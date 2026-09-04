const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const https = require('https');
const http = require('http');

const { log, getLogs, clearLogs, encrypt, decrypt } = require('./utils');
const { getUsers, saveUsers, getAllAccounts, getAccount, saveAccount, deleteAccountFile, getSessions, saveSessions, getBundles, saveBundles, getSettings, saveSettings, getGlobalProxies, saveGlobalProxies } = require('./data');
const { startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, getGamePayload, updateBotGames, requestFreeGames, queueFreeGames, flushDirtyAccounts } = require('./bot');

// 245 Steam clients share this process. A throw from any one of their callbacks
// would otherwise take down every other bot, so log and keep serving. This is a
// backstop -- the teardown path in bot.js is what stops clients throwing at all.
process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err && err.stack ? err.stack : err}`, "ERROR");
});
process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`, "ERROR");
});

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
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], // 'unsafe-inline' needed for the inline script in index.html
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
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- SOCKET.IO ---
const { setLogListener } = require('./utils');
setLogListener((logEntry) => { io.emit('new_log', logEntry); });

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { success: false, msg: "Too many attempts" } });
const bulkLimiter = rateLimit({ windowMs: 60*1000, max: 5, message: { success: false, msg: "Too many bulk requests" } });
// Blunt session-token guessing. Generous enough for the dashboard's own polling.
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 600, message: { error: 'Too many requests' } });

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
    if (token && sessions[token] && sessions[token].expiresAt > Date.now()) {
        req.user = sessions[token];
        return next();
    }
    // Only touch disk when a real session actually expired. Previously every
    // request with a bad or absent token triggered a synchronous full rewrite of
    // sessions.json, which is a free disk-write amplifier for an unauthenticated
    // caller.
    if (token && sessions[token]) { delete sessions[token]; saveSessions(sessions); }
    res.status(401).json({ error: 'Unauthorized' });
};

// Expired sessions used to be pruned only as a side effect of a failed request.
setInterval(() => { saveSessions(getSessions()); }, 60 * 60 * 1000).unref();

app.get('/api/verify_session', (req, res) => {
    const token = req.headers.authorization;
    const sessions = getSessions();
    if (token && sessions[token] && sessions[token].expiresAt > Date.now()) {
        // The panel user may have been deleted while this session was still valid.
        const user = getUsers().find(u => u.username === sessions[token].username);
        if (!user) return res.json({ success: false });
        res.json({ success: true, role: sessions[token].role, username: sessions[token].username, has2FA: !!user.twoFactorSecret });
    } else res.json({ success: false });
});

app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password, token } = req.body;
    const user = getUsers().find(u => u.username === username);
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ success: false, msg: 'Invalid Credentials' });
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

app.use('/api/', apiLimiter, requireAuth);

app.post('/api/library', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAccount(req.body.username); res.json({ games: acc.ownedGames || [] }); });

app.post('/api/accounts/bulk', bulkLimiter, (req, res) => {
    const { data, category, autoStart, autoAccept, bundle } = req.body; const lines = data.split(/\r?\n/); let c = 0; let skipped = 0;
    const bundles = getBundles(); 
    let selectedGames = [730];
    if (bundle === 'none') selectedGames = [];
    else if (bundle && bundles[bundle]) selectedGames = bundles[bundle];
    lines.forEach(l => { const p = l.trim().split(':'); if (p.length >= 2) { if (!getAccount(p[0].trim())) { saveAccount({ username: p[0].trim(), password: p[1].trim(), sharedSecret: p[2]?p[2].trim():"", proxy: p[3]?p[3].trim():"", category: category||"Default", autoStart: !!autoStart, autoAccept: !!autoAccept, games: selectedGames, nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); c++; } else { skipped++; } } });
    log(`Bulk added ${c}, skipped ${skipped}`, "SYSTEM"); res.json({ success: true, count: c, skipped });
});
app.get('/api/accounts/export', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const accounts = getAllAccounts();
    log(`${req.user.username} exported ${accounts.length} accounts.`, "AUDIT");
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
            let proxyChanged = false;
            if (changes.proxy !== undefined && changes.proxy !== acc.proxy) {
                acc.proxy = changes.proxy;
                proxyChanged = true;
            }
            if (changes.category !== undefined) acc.category = changes.category;
            if (changes.autoStart !== undefined) acc.autoStart = changes.autoStart;
            if (changes.autoAccept !== undefined) acc.autoAccept = changes.autoAccept;
            
            // Bulk Games (Bundle)
            if (changes.bundle) {
                if (changes.bundle === 'none') {
                    acc.games = [];
                    const bot = activeBots[acc.username];
                    if (bot && bot.client && bot.status === 'Running') updateBotGames(acc.username);
                } else if (bundles[changes.bundle]) {
                    acc.games = bundles[changes.bundle];
                    const bot = activeBots[acc.username];
                    if (bot && bot.client && bot.status === 'Running') updateBotGames(acc.username);
                }
            }

            saveAccount(acc);
            
            // Restart if proxy changed and bot is running
            if (proxyChanged) {
                const bot = activeBots[acc.username];
                if (bot && (bot.status === 'Running' || bot.status === 'Logging in...' || bot.status.includes('Rate Limit'))) {
                    stopBot(acc.username);
                    setTimeout(() => startBotProcess(acc), 1000);
                }
            }
            
            count++;
        }
    });
    res.json({ success: true, count });
});
app.post('/api/accounts', (req, res) => { if (getAccount(req.body.username)) return res.status(400).json({ error: 'Exists' }); saveAccount({ username: req.body.username, password: req.body.password, sharedSecret: req.body.sharedSecret, category: req.body.category||"Default", autoStart: req.body.autoStart, autoAccept: req.body.autoAccept, games: [730], nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); res.json({ success: true }); });
app.post('/api/edit', (req, res) => { 
    const { oldUsername, newUsername, newPassword, newSharedSecret, newProxy, newCategory, newAutoStart, newAutoAccept } = req.body;
    if(!verifyOwner(req, oldUsername)) return res.status(403).json({});
    const ex = getAccount(oldUsername);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    stopBot(oldUsername);
    if (oldUsername !== newUsername) { deleteAccountFile(oldUsername); forgetAccountCaches(oldUsername); delete getActiveBots()[oldUsername]; }
    // Only overwrite what the caller actually sent. The edit modal omits proxy and
    // autoAccept entirely, so taking these unconditionally wiped the account's proxy
    // on every edit. Blank password/secret means "unchanged", as the UI advertises.
    saveAccount({
        ...ex,
        username: newUsername,
        password: (newPassword && newPassword !== "") ? newPassword : ex.password,
        sharedSecret: (newSharedSecret && newSharedSecret !== "") ? newSharedSecret : ex.sharedSecret,
        proxy: newProxy !== undefined ? newProxy : ex.proxy,
        category: newCategory || ex.category || "Default",
        autoStart: newAutoStart !== undefined ? newAutoStart : ex.autoStart,
        autoAccept: newAutoAccept !== undefined ? newAutoAccept : ex.autoAccept
    });
    res.json({ success: true });
});
// /api/accounts is polled by every open dashboard every few seconds and resolves a
// name for every game of every account. Cache the resolved list per account and
// reuse it until that account's games array is actually replaced.
const gameNameCache = new Map(); // username -> { ref, resolved }
function resolveGames(acc) {
    const ref = acc.games || [];
    const hit = gameNameCache.get(acc.username);
    if (hit && hit.ref === ref) return hit.resolved;
    const resolved = ref.map(id => ({ id, name: getGameName(id) }));
    gameNameCache.set(acc.username, { ref, resolved });
    return resolved;
}
// Kept off the account object itself: saveAccount() spreads the record to disk, so
// anything stashed there would be persisted into the account JSON.
const ownedIdCache = new Map(); // username -> { ref, ids }
function resolveOwnedIds(acc) {
    const ref = acc.ownedGames || [];
    const hit = ownedIdCache.get(acc.username);
    if (hit && hit.ref === ref) return hit.ids;
    const ids = ref.map(g => g.id);
    ownedIdCache.set(acc.username, { ref, ids });
    return ids;
}
function forgetAccountCaches(username) {
    gameNameCache.delete(username);
    ownedIdCache.delete(username);
}

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
            grandTotal: acc.grandTotal || "0.0", steamId: acc.steamId || null, games: resolveGames(acc),
            customStatus: acc.customStatus || "", addedAt: acc.addedAt || Date.now(), boostedHours: acc.boostedHours || 0, 
            personaState: acc.personaState !== undefined ? acc.personaState : 1, category: acc.category || "Default", autoStart: !!acc.autoStart, autoAccept: !!acc.autoAccept, ip: displayIp,
            proxy: acc.proxy || "",
            ownedGames: resolveOwnedIds(acc),
            hasSharedSecret: !!acc.sharedSecret
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
    
    const BATCH_SIZE = 5;
    let idx = 0;
    const runBatch = () => {
        const batch = botsToRestart.slice(idx, idx + BATCH_SIZE);
        if(batch.length === 0) return;
        batch.forEach(u => { const acc = getAccount(u); if (acc) startBotProcess(acc); });
        idx += BATCH_SIZE;
        if(idx < botsToRestart.length) setTimeout(runBatch, 2000);
    };
    setTimeout(runBatch, 1000);

    log(`Restart All triggered. Cycling ${count} bots (Threaded).`, "SYSTEM", req.user.username);
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
    acc.games = (req.body.games || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    acc.customStatus = req.body.customStatus || ""; acc.personaState = parseInt(req.body.personaState); 
    saveAccount(acc); 
    const b = getActiveBots()[req.body.username]; 
    if (b && b.client && b.status === 'Running') { updateBotGames(req.body.username); }
    res.json({ success: true }); 
});
app.post('/api/games/free_license', bulkLimiter, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { usernames, games, autoStart } = req.body;
    if (!usernames || !Array.isArray(usernames) || !games || !Array.isArray(games)) return res.status(400).json({ error: 'Invalid data' });
    
    const activeBots = getActiveBots();
    const processList = [];

    usernames.forEach(u => {
        if (verifyOwner(req, u)) processList.push(u);
    });

    res.json({ success: true, count: processList.length, queued: processList.length, message: "Processing started in background" });

    (async () => {
        const BATCH_SIZE = 10;
        const total = processList.length;
        let processed = 0;
        let stats = { success: 0, owned: 0, failed: 0, queued: 0 };
        io.emit('free_games_progress', { processed: 0, total, stats });

        for (let i = 0; i < processList.length; i += BATCH_SIZE) {
            const batch = processList.slice(i, i + BATCH_SIZE);
            
            const promises = batch.map(u => {
                const bot = activeBots[u];
                let p;
                if (bot && bot.client && bot.status === 'Running') { 
                    p = requestFreeGames(u, games); 
                } else if (autoStart) { 
                    queueFreeGames(u, games, true); 
                    startBotProcess(getAccount(u)); 
                    p = Promise.resolve({ result: 'queued' });
                } else {
                    p = Promise.resolve({ result: 'error', msg: 'Offline' });
                }
                
                return p.then(r => {
                    if (r.result === 'success') stats.success++;
                    else if (r.result === 'owned') stats.owned++;
                    else if (r.result === 'error') stats.failed++;
                    else if (r.result === 'queued') stats.queued++;
                    processed++;
                    io.emit('free_games_progress', { processed, total, stats });
                    return r;
                });
            });

            await Promise.all(promises);
            if (i + BATCH_SIZE < processList.length) await new Promise(r => setTimeout(r, 10000));
        }
        io.emit('free_games_progress', { processed: total, total, stats, complete: true });
    })();
});
app.post('/api/delete', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); deleteAccountFile(req.body.username); forgetAccountCaches(req.body.username); delete getActiveBots()[req.body.username]; res.json({ success: true }); });
app.post('/api/get_account', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAccount(req.body.username); if (!acc) return res.status(404).json({}); res.json({ username: acc.username, hasSharedSecret: !!acc.sharedSecret, proxy: acc.proxy || '', category: acc.category || '', autoStart: !!acc.autoStart, autoAccept: !!acc.autoAccept }); });
app.post('/api/settings/password', async (req, res) => { const users = getUsers(); const u = users.find(x => x.username === req.user.username); if (!(await bcrypt.compare(req.body.currentPass, u.password))) return res.status(400).json({}); u.password = await bcrypt.hash(req.body.newPass, 12); saveUsers(users); res.json({ success: true }); });
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
app.post('/api/logs/clear', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    clearLogs();
    res.json({ success: true });
});
app.get('/api/search_games', (req, res) => { const q = (req.query.q || "").toLowerCase().trim(); if (!q) return res.json([]); res.json(searchGames(q)); });
app.get('/api/users', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json([]); res.json(getUsers().map(u => ({ username: u.username, role: u.role }))); });
app.post('/api/users', async (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); const users = getUsers(); users.push({ username: req.body.username, password: await bcrypt.hash(req.body.password, 12), role: 'user' }); saveUsers(users); res.json({ success: true }); });
app.post('/api/users/delete', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); let users = getUsers(); users = users.filter(u => u.username !== req.body.username); saveUsers(users); log(`${req.user.username} deleted panel user "${req.body.username}".`, "AUDIT"); res.json({ success: true }); });

app.get('/api/bundles', (req, res) => {
    const b = getBundles();
    const resolved = {};
    for (const [k, v] of Object.entries(b)) {
        resolved[k] = v.map(id => ({ id, name: getGameName(id) }));
    }
    res.json(resolved);
});
// Bundles are global, so writing them is admin-only (reading them is not).
app.post('/api/bundles', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { name, games } = req.body;
    if (!name || !games || !Array.isArray(games)) return res.status(400).json({ error: 'Invalid data' });
    const b = getBundles(); b[name] = games.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647); saveBundles(b); res.json({ success: true });
});
app.post('/api/bundles/delete', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { name } = req.body;
    const b = getBundles(); if (b[name]) { delete b[name]; saveBundles(b); } res.json({ success: true });
});

app.get('/api/settings', (req, res) => { res.json(getSettings()); });
app.post('/api/settings', (req, res) => { 
    if (req.user.role !== 'admin') return res.status(403).json({});
    const s = getSettings(); 
    s.discordWebhook = req.body.discordWebhook; 
    s.rotationInterval = req.body.rotationInterval;
    saveSettings(s); 
    res.json({ success: true }); 
});
app.get('/api/proxies/global', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json([]);
    res.json(getGlobalProxies());
});
app.post('/api/proxies/global', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { proxies } = req.body;
    if (!Array.isArray(proxies)) return res.status(400).json({});
    saveGlobalProxies(proxies);
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
            path: 'http://api.steampowered.com/ISteamDirectory/GetCMList/v1/?cellid=0',
            headers: { 'Host': 'api.steampowered.com' },
            timeout: 5000
        };
        
        if (u.username) {
            options.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(u.username + ':' + u.password).toString('base64');
        }

        let responded = false;
        const safeReply = (data) => {
            if (responded) return;
            responded = true;
            res.json(data);
        };

        const request = http.request(options, (response) => {
            response.resume(); // Consume the stream either way, or the socket is held open
            if (response.statusCode === 200) {
                safeReply({ success: true, ip: "Steam Reachable" });
            } else {
                safeReply({ success: false, msg: `HTTP ${response.statusCode}` });
            }
        });

        request.on('error', (err) => safeReply({ success: false, msg: "Connection Failed" }));
        request.on('timeout', () => { request.destroy(); safeReply({ success: false, msg: "Timeout" }); });
        request.end();
    } catch (e) {
        res.json({ success: false, msg: "Invalid Format" });
    }
});

// Failing to bind is fatal -- without this the uncaughtException handler above
// would swallow EADDRINUSE and leave a process running that never serves anything.
server.on('error', (err) => {
    log(`Server error: ${err.message}`, "ERROR");
    process.exit(1);
});
server.listen(3000, () => log('BruddiBooster v18 Running on 3000', "SYSTEM"));

// --- GRACEFUL SHUTDOWN ---
// Without this, a restart drops every Steam connection mid-session and loses up to
// STATS_FLUSH_MINUTES of accumulated boostedHours.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}. Shutting down...`, "SYSTEM");

    const bots = getActiveBots();
    const running = Object.keys(bots).filter(u => bots[u].client);
    running.forEach(u => stopBot(u));
    const flushed = flushDirtyAccounts();
    log(`Logged off ${running.length} bots, flushed ${flushed} accounts.`, "SYSTEM");

    io.close();
    server.close(() => process.exit(0));
    // steam-user's logoff handshake needs a moment; don't wait forever for it.
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));