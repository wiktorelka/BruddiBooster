const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const https = require('https');
const http = require('http');

const { log, getLogs, encrypt, decrypt } = require('./utils');
const { getUsers, saveUsers, getAllAccounts, getAccount, saveAccount, deleteAccountFile, getSessions, saveSessions, getBundles, saveBundles, getSettings, saveSettings } = require('./data');
const { startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, updateProfile, getGamePayload, updateBotGames, requestFreeGames } = require('./bot');

const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

let serverPublicIp = "Loading...";
https.get('https://api.ipify.org', (res) => {
    let data = ''; res.on('data', c => data += c);
    res.on('end', () => { if(data) serverPublicIp = data.trim(); });
}).on('error', () => { serverPublicIp = "Server IP"; });

app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // 'unsafe-inline' needed for the inline script in index.html
            scriptSrcAttr: ["'unsafe-inline'"], // Needed for event handlers
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://avatars.steamstatic.com", "https://raw.githubusercontent.com", "https://cdn.cloudflare.steamstatic.com", "https://shared.akamai.steamstatic.com", "https://steamcdn-a.akamaihd.net"],
            connectSrc: ["'self'", "https://raw.githubusercontent.com"], // For fetching game list
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- SOCKET.IO ---
const { setLogListener } = require('./utils');
setLogListener((logEntry) => { io.emit('new_log', logEntry); });

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { success: false, msg: "Too many attempts" } });

// Init Bots
const autoStartAccounts = getAllAccounts().filter(acc => acc.autoStart);
let startDelay = 5000;
autoStartAccounts.forEach(acc => {
    setTimeout(() => startBotProcess(acc), startDelay);
    startDelay += 5000;
});

const requireAuth = (req, res, next) => {
    const token = req.headers.authorization;
    const sessions = getSessions();
    if (sessions[token] && sessions[token].expiresAt > Date.now()) { req.user = sessions[token]; next(); } else { delete sessions[token]; saveSessions(sessions); res.status(401).json({ error: 'Unauthorized' }); }
};

app.get('/api/verify_session', (req, res) => {
    const token = req.headers.authorization;
    const sessions = getSessions();
    if (token && sessions[token] && sessions[token].expiresAt > Date.now()) {
        const user = getUsers().find(u => u.username === sessions[token].username);
        res.json({ success: true, role: sessions[token].role, username: sessions[token].username, has2FA: !!user.twoFactorSecret });
    } else res.json({ success: false });
});

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password, token } = req.body;
    const user = getUsers().find(u => u.username === username);
    if (!user || decrypt(user.password) !== password) return res.status(401).json({ success: false, msg: 'Invalid Credentials' });
    if (user.twoFactorSecret) {
        if (!token) return res.json({ success: false, requires2fa: true });
        if (!speakeasy.totp.verify({ secret: decrypt(user.twoFactorSecret), encoding: 'base32', token })) return res.status(401).json({ success: false, msg: 'Invalid Code' });
    }
    const st = crypto.randomBytes(32).toString('hex');
    const sessions = getSessions();
    sessions[st] = { username: user.username, role: user.role, expiresAt: Date.now() + (7*24*3600*1000) };
    saveSessions(sessions);
    res.json({ success: true, token: st, role: user.role, username: user.username, has2FA: !!user.twoFactorSecret });
});

app.post('/api/logout', (req, res) => { 
    const sessions = getSessions();
    if (sessions[req.headers.authorization]) { delete sessions[req.headers.authorization]; saveSessions(sessions); } 
    res.json({ success: true }); 
});

app.use('/api/', requireAuth);

app.post('/api/library', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAccount(req.body.username); res.json({ games: acc.ownedGames || [] }); });

app.post('/api/accounts/bulk', (req, res) => {
    const { data, category, autoStart, autoAccept, bundle } = req.body; const lines = data.split(/\r?\n/); let c = 0;
    const bundles = getBundles(); const selectedGames = (bundle && bundles[bundle]) ? bundles[bundle] : [730];
    lines.forEach(l => { const p = l.trim().split(':'); if (p.length >= 2 && !getAccount(p[0].trim())) { saveAccount({ username: p[0].trim(), password: p[1].trim(), sharedSecret: p[2]?p[2].trim():"", proxy: p[3]?p[3].trim():"", category: category||"Default", autoStart: !!autoStart, autoAccept: !!autoAccept, games: selectedGames, nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); c++; } });
    log(`Bulk added ${c}`, "SYSTEM"); res.json({ success: true, count: c });
});
app.get('/api/accounts/export', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const accounts = getAllAccounts();
    const data = accounts.map(a => {
        let line = `${a.username}:${a.password}`;
        if (a.sharedSecret) line += `:${a.sharedSecret}`;
        if (a.proxy) line += `:${a.proxy}`;
        return line;
    }).join('\n');
    res.json({ success: true, data });
});
app.post('/api/accounts/bulk_update', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { updates, globalChanges } = req.body; 
    if (!Array.isArray(updates)) return res.status(400).json({});
    
    const bundles = getBundles();
    const activeBots = getActiveBots();
    let count = 0;

    updates.forEach(u => {
        const changes = { ...globalChanges, ...u };
        const acc = getAccount(changes.username);
        if (acc) {
            if (changes.proxy !== undefined) acc.proxy = changes.proxy;
            if (changes.category !== undefined) acc.category = changes.category;
            if (changes.autoStart !== undefined) acc.autoStart = changes.autoStart;
            if (changes.autoAccept !== undefined) acc.autoAccept = changes.autoAccept;
            
            // Bulk Games (Bundle)
            if (changes.bundle && bundles[changes.bundle]) {
                acc.games = bundles[changes.bundle];
                const bot = activeBots[acc.username];
                if (bot && bot.client && bot.status === 'Running') {
                    updateBotGames(acc.username);
                }
            }

            saveAccount(acc);
            
            // Bulk Profile (Avatar, Privacy) - Only works if bot is running
            if (changes.avatar || changes.privacy) { try { updateProfile(acc.username, { avatar: changes.avatar, privacy: changes.privacy }); } catch(e){} }
            
            count++;
        }
    });
    res.json({ success: true, count });
});
app.post('/api/accounts', (req, res) => { if (getAccount(req.body.username)) return res.status(400).json({ error: 'Exists' }); saveAccount({ username: req.body.username, password: req.body.password, sharedSecret: req.body.sharedSecret, category: req.body.category||"Default", autoStart: req.body.autoStart, autoAccept: req.body.autoAccept, games: [730], nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); res.json({ success: true }); });
app.post('/api/edit', (req, res) => { 
    const { oldUsername, newUsername, newPassword, newSharedSecret, newProxy, newCategory, newAutoStart, newAutoAccept } = req.body;
    if(!verifyOwner(req, oldUsername)) return res.status(403).json({});
    const ex = getAccount(oldUsername); stopBot(oldUsername);
    if (oldUsername !== newUsername) { deleteAccountFile(oldUsername); delete getActiveBots()[oldUsername]; }
    saveAccount({ ...ex, username: newUsername, password: (newPassword && newPassword !== "") ? newPassword : ex.password, sharedSecret: newSharedSecret, proxy: newProxy, category: newCategory||ex.category||"Default", autoStart: newAutoStart, autoAccept: newAutoAccept });
    res.json({ success: true });
});
// UPDATED: Return lastError
app.get('/api/accounts', (req, res) => {
    let accounts = getAllAccounts().filter(a => a.owner === req.user.username || (req.user.role === 'admin' && !a.owner));
    const activeBots = getActiveBots();
    res.json(accounts.map(acc => {
        const b = activeBots[acc.username];
        let displayIp = serverPublicIp;
        if (acc.proxy) {
            try {
                if (acc.proxy.includes('@')) displayIp = acc.proxy.split('@')[1].split(':')[0];
                else if (acc.proxy.includes('://')) displayIp = acc.proxy.split('://')[1].split(':')[0];
                else displayIp = acc.proxy.split(':')[0];
            } catch(e) {}
        }
        return { 
            username: acc.username, nickname: acc.nickname || acc.username, avatarHash: acc.avatarHash || null, 
            status: b ? b.status : 'Stopped', 
            lastError: b ? b.lastError : null, // SEND ERROR TO FRONTEND
            nextRotation: b ? b.nextRotation : null,
            grandTotal: acc.grandTotal || "0.0", steamId: acc.steamId || null, games: (acc.games||[]).map(id => ({ id, name: getGameName(id) })), 
            customStatus: acc.customStatus || "", addedAt: acc.addedAt || Date.now(), boostedHours: acc.boostedHours || 0, 
            personaState: acc.personaState !== undefined ? acc.personaState : 1, category: acc.category || "Default", autoStart: !!acc.autoStart, autoAccept: !!acc.autoAccept, ip: displayIp
        };
    }));
});
function verifyOwner(req, username) { if (req.user.role === 'admin') return true; const acc = getAccount(username); return acc && acc.owner === req.user.username; }
app.post('/api/start', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); startBotProcess(getAccount(req.body.username)); res.json({ success: true }); });
app.post('/api/stop', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); res.json({ success: true }); });
app.post('/api/restart', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); setTimeout(() => { startBotProcess(getAccount(req.body.username)); }, 1000); res.json({ success: true }); });
app.post('/api/steamguard', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); const b = getActiveBots()[req.body.username]; if (b && b.guardCallback) { b.guardCallback(req.body.code); b.status = 'Verifying...'; b.guardCallback = null; res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/restart_all', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const activeBots = getActiveBots();
    let count = 0;
    const botsToRestart = [];
    Object.keys(activeBots).forEach(u => {
        if (activeBots[u].status === 'Running' || activeBots[u].status === 'Logging in...' || activeBots[u].status.includes('Rate Limit')) {
            botsToRestart.push(u);
            stopBot(u);
            count++;
        }
    });
    let delay = 2000;
    botsToRestart.forEach(u => {
        setTimeout(() => { const acc = getAccount(u); if (acc) startBotProcess(acc); }, delay);
        delay += 3000;
    });
    log(`Restart All triggered. Cycling ${count} bots.`, "SYSTEM", req.user.username);
    res.json({ success: true, count });
});
app.post('/api/panic', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const activeBots = getActiveBots();
    let count = 0;
    Object.keys(activeBots).forEach(u => {
        if (activeBots[u].status === 'Running' || activeBots[u].status === 'Logging in...') {
            stopBot(u);
            count++;
        }
    });
    log(`Panic Stop triggered. Stopped ${count} bots.`, "SYSTEM", req.user.username);
    res.json({ success: true, count });
});
app.post('/api/games', (req, res) => { 
    if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); 
    const acc = getAccount(req.body.username); 
    acc.games = req.body.games; // Removed slice limit
    acc.customStatus = req.body.customStatus || ""; acc.personaState = parseInt(req.body.personaState); 
    saveAccount(acc); 
    const b = getActiveBots()[req.body.username]; 
    if (b && b.client && b.status === 'Running') { updateBotGames(req.body.username); }
    res.json({ success: true }); 
});
app.post('/api/games/free_license', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { usernames, games } = req.body;
    if (!usernames || !Array.isArray(usernames) || !games || !Array.isArray(games)) return res.status(400).json({ error: 'Invalid data' });
    
    let count = 0;
    usernames.forEach(u => {
        if (verifyOwner(req, u)) { requestFreeGames(u, games); count++; }
    });
    res.json({ success: true, count });
});
app.post('/api/delete', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); deleteAccountFile(req.body.username); delete getActiveBots()[req.body.username]; res.json({ success: true }); });
app.post('/api/get_account', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAccount(req.body.username); res.json({ username: acc.username, sharedSecret: acc.sharedSecret || '', proxy: acc.proxy || '', category: acc.category || '', autoStart: !!acc.autoStart, autoAccept: !!acc.autoAccept }); });
app.post('/api/settings/password', (req, res) => { const users = getUsers(); const u = users.find(x => x.username === req.user.username); if (decrypt(u.password) !== req.body.currentPass) return res.status(400).json({}); u.password = encrypt(req.body.newPass); saveUsers(users); res.json({ success: true }); });
app.post('/api/settings/2fa/generate', (req, res) => { const s = speakeasy.generateSecret({ name: `BruddiBooster (${req.user.username})` }); qrcode.toDataURL(s.otpauth_url, (e, d) => { res.json({ secret: s.base32, qr: d }); }); });
app.post('/api/settings/2fa/enable', (req, res) => { if (speakeasy.totp.verify({ secret: req.body.secret, encoding: 'base32', token: req.body.token })) { const users = getUsers(); users.find(u => u.username === req.user.username).twoFactorSecret = encrypt(req.body.secret); saveUsers(users); res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/settings/2fa/disable', (req, res) => { const users = getUsers(); users.find(u => u.username === req.user.username).twoFactorSecret = null; saveUsers(users); res.json({ success: true }); });
app.get('/api/logs', (req, res) => {
    let logs = getLogs();
    if (req.user.role !== 'admin') {
        const userAccounts = getAllAccounts().filter(a => a.owner === req.user.username).map(a => a.username);
        logs = logs.filter(l => l.relatedUser && userAccounts.includes(l.relatedUser));
    }
    res.json(logs.map(l => l.text));
});
app.get('/api/search_games', (req, res) => { const q = (req.query.q || "").toLowerCase().trim(); if (!q) return res.json([]); res.json(searchGames(q)); });
app.get('/api/users', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json([]); res.json(getUsers().map(u => ({ username: u.username, role: u.role }))); });
app.post('/api/users', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); const users = getUsers(); users.push({ username: req.body.username, password: encrypt(req.body.password), role: 'user' }); saveUsers(users); res.json({ success: true }); });
app.post('/api/users/delete', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); let users = getUsers(); users = users.filter(u => u.username !== req.body.username); saveUsers(users); res.json({ success: true }); });

app.get('/api/bundles', (req, res) => {
    const b = getBundles();
    const resolved = {};
    for (const [k, v] of Object.entries(b)) {
        resolved[k] = v.map(id => ({ id, name: getGameName(id) }));
    }
    res.json(resolved);
});
app.post('/api/bundles', (req, res) => { 
    const { name, games } = req.body;
    if (!name || !games || !Array.isArray(games)) return res.status(400).json({ error: 'Invalid data' });
    const b = getBundles(); b[name] = games; saveBundles(b); res.json({ success: true });
});
app.post('/api/bundles/delete', (req, res) => {
    const { name } = req.body;
    const b = getBundles(); if (b[name]) { delete b[name]; saveBundles(b); } res.json({ success: true });
});

app.get('/api/settings', (req, res) => { res.json(getSettings()); });
app.post('/api/settings', (req, res) => { 
    if (req.user.role !== 'admin') return res.status(403).json({});
    const s = getSettings(); 
    s.discordWebhook = req.body.discordWebhook; 
    saveSettings(s); 
    res.json({ success: true }); 
});
app.post('/api/settings/test_webhook', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    sendDiscordWebhook("Test Notification", "This is a test message from BruddiBooster.", 5814783, req.body.discordWebhook);
    res.json({ success: true });
});
app.post('/api/proxy/check', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { proxy } = req.body;
    if (!proxy) return res.json({ success: false, msg: "No proxy provided" });

    try {
        const u = new URL(proxy);
        if (!u.hostname || !u.port) throw new Error("Invalid Proxy");
        
        const options = {
            host: u.hostname,
            port: u.port,
            method: 'GET',
            path: 'http://api.ipify.org/',
            headers: { 'Host': 'api.ipify.org' },
            timeout: 5000
        };
        
        if (u.username) {
            options.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(u.username + ':' + u.password).toString('base64');
        }

        const request = http.request(options, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => res.json({ success: true, ip: data.trim() }));
            } else {
                res.json({ success: false, msg: `HTTP ${response.statusCode}` });
            }
        });

        request.on('error', (err) => res.json({ success: false, msg: "Connection Failed" }));
        request.on('timeout', () => { request.destroy(); res.json({ success: false, msg: "Timeout" }); });
        request.end();
    } catch (e) {
        res.json({ success: false, msg: "Invalid Format" });
    }
});

server.listen(3000, () => log('BruddiBooster v18 Running on 3000', "SYSTEM"));