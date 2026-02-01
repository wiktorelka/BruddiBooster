const express = require('express');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

// --- LOGGING ---
const MAX_LOGS = 100;
const systemLogs = [];
function log(msg, type='INFO') {
    const entry = `[${new Date().toLocaleTimeString('en-US',{hour12:false})}] [${type}] ${msg}`;
    console.log(entry);
    systemLogs.unshift(entry);
    if(systemLogs.length > MAX_LOGS) systemLogs.pop();
}

// --- DIRECTORIES ---
const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR);
const KEY_FILE = path.join(__dirname, 'secret.key');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// --- SECURITY ---
let ENCRYPTION_KEY;
if (fs.existsSync(KEY_FILE)) {
    ENCRYPTION_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
} else {
    ENCRYPTION_KEY = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, ENCRYPTION_KEY.toString('hex'));
}

let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE)); } catch(e){} }
function saveSessions() { 
    const now = Date.now();
    for (const t in sessions) if (sessions[t].expiresAt < now) delete sessions[t];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); 
}

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { success: false, msg: "Too many attempts" } });

function encrypt(text) {
    if (!text) return text;
    try {
        let iv = crypto.randomBytes(16);
        let cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let e = cipher.update(text); e = Buffer.concat([e, cipher.final()]);
        return iv.toString('hex') + ':' + e.toString('hex');
    } catch (e) { return text; }
}

function decrypt(text) {
    if (!text) return text;
    try {
        let p = text.split(':'); if (p.length < 2) return text;
        let iv = Buffer.from(p.shift(), 'hex');
        let d = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let o = d.update(Buffer.from(p.join(':'), 'hex')); o = Buffer.concat([o, d.final()]);
        return o.toString();
    } catch (e) { return text; }
}

let panelUsers = [];
if (fs.existsSync(USERS_FILE)) {
    try { panelUsers = JSON.parse(fs.readFileSync(USERS_FILE)); 
        panelUsers.forEach(u => { if (!u.password.includes(':')) u.password = encrypt(u.password); });
        fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2));
    } catch(e){}
} else {
    panelUsers = [{ username: "admin", password: encrypt("password"), role: "admin" }];
    fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2));
}

let allSteamApps = [];
const TOP_GAMES_FALLBACK = { 730: "Counter-Strike 2", 440: "Team Fortress 2", 570: "Dota 2", 252490: "Rust", 271590: "GTA V" };
function updateAppList() {
    https.get('https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json', (res) => {
        if (res.statusCode !== 200) return;
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { allSteamApps = JSON.parse(data); log(`Loaded ${allSteamApps.length} games.`, "SUCCESS"); } catch(e){} });
    }).on('error', () => {});
}
updateAppList(); setInterval(updateAppList, 86400000); 
function getGameName(id) { const f = allSteamApps.find(a => a.appid == id); return f ? f.name : (TOP_GAMES_FALLBACK[id] || "Unknown Game"); }

const activeBots = {}; 
function getAllAccounts() {
    return fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).map(file => {
        try { const r = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file))); return { ...r, password: decrypt(r.password), sharedSecret: decrypt(r.sharedSecret) }; } catch(e) { return null; }
    }).filter(a => a);
}
function saveAccount(acc) {
    if (!acc.category || acc.category.trim() === "") acc.category = "Default";
    const d = { ...acc, password: encrypt(acc.password), sharedSecret: encrypt(acc.sharedSecret) };
    fs.writeFileSync(path.join(ACCOUNTS_DIR, acc.username.toLowerCase() + '.json'), JSON.stringify(d, null, 2));
}
function deleteAccountFile(user) { const p = path.join(ACCOUNTS_DIR, user.toLowerCase() + '.json'); if (fs.existsSync(p)) fs.unlinkSync(p); }

// Init Bots
getAllAccounts().forEach(acc => {
    activeBots[acc.username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null };
    if (acc.autoStart) startBotProcess(acc);
});

// Stats Loop
setInterval(() => {
    getAllAccounts().forEach(acc => {
        if (activeBots[acc.username] && activeBots[acc.username].status === 'Running' && (acc.games||[]).length > 0) {
            acc.boostedHours = (acc.boostedHours || 0) + ((1/60) * acc.games.length);
            saveAccount(acc);
        }
    });
}, 60000);

function getGamePayload(games, customStatus) {
    const payload = [];
    if (customStatus && typeof customStatus === 'string' && customStatus.trim().length > 0) payload.push(customStatus);
    if (Array.isArray(games)) payload.push(...games);
    return payload;
}

// --- UPDATED BOT LOGIC (Error Handling) ---
function startBotProcess(account) {
    const { username, password, sharedSecret } = account;
    if (activeBots[username].client) return;

    // Reset error state
    activeBots[username].lastError = null;

    const client = new SteamUser();
    activeBots[username] = { client, status: 'Logging in...', lastError: null };
    log(`Starting ${username}...`, "BOT");

    const opts = { accountName: username, password: password };
    
    // Better Shared Secret Handling
    if (sharedSecret) { 
        try { 
            opts.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret); 
        } catch (e) { 
            const errMsg = `Secret Error: ${e.message}`;
            log(`${username}: ${errMsg}`, "ERROR");
            activeBots[username].status = 'Error'; 
            activeBots[username].lastError = errMsg;
            return; 
        } 
    }

    client.logOn(opts);

    client.on('loggedOn', () => {
        const state = account.personaState !== undefined ? account.personaState : SteamUser.EPersonaState.Online;
        client.setPersona(state);
        client.gamesPlayed(getGamePayload(account.games, account.customStatus));
        activeBots[username].status = 'Running';
        activeBots[username].lastError = null; // Clear error on success
        
        updateHours(username, client);
        if (client.steamID) { account.steamId = client.steamID.getSteamID64(); saveAccount(account); }
        
        client.getPersonas([client.steamID], () => { setTimeout(() => { if (!client.steamID) return; const u = client.users[client.steamID.getSteamID64()]; if (u) { if(u.player_name) account.nickname = u.player_name; if(u.avatar_hash) account.avatarHash = u.avatar_hash.toString('hex'); saveAccount(account); } }, 1000); });
    });

    client.on('steamGuard', (d, cb) => { 
        log(`${username} needs Guard Code`, "AUTH");
        activeBots[username].status = 'Need Guard'; 
        activeBots[username].guardCallback = cb; 
    });

    // CAPTURE ERROR DETAILS
    client.on('error', (e) => {
        const errorDetails = e.eresult ? `(Steam Code: ${e.eresult})` : '';
        const fullMsg = `${e.message} ${errorDetails}`;
        
        log(`${username} Error: ${fullMsg}`, "ERROR");
        
        activeBots[username].status = 'Error';
        activeBots[username].lastError = fullMsg; // Store for frontend tooltip
        
        if(activeBots[username].client) { 
            activeBots[username].client.logOff(); 
            activeBots[username].client = null; 
        }
    });
}

function updateHours(username, client) {
    setTimeout(() => { if (!activeBots[username] || !activeBots[username].client) return; client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeInfo: true }, (err, res) => { if (res && res.apps) { let m = 0; const owned = res.apps.map(a => ({ id: a.appid, name: a.name })); res.apps.forEach(a => m += a.playtime_forever); const acc = getAllAccounts().find(a => a.username === username); if (acc) { acc.grandTotal = (m / 60).toFixed(1); acc.ownedGames = owned; saveAccount(acc); } } }); }, 5000);
}

function stopBot(u) { const b = activeBots[u]; if (b && b.client) { b.client.logOff(); b.client = null; log(`${u} stopped.`, "BOT"); } if (b) { b.status = 'Stopped'; b.guardCallback = null; b.lastError = null; } }

const requireAuth = (req, res, next) => {
    const token = req.headers.authorization;
    if (sessions[token] && sessions[token].expiresAt > Date.now()) { req.user = sessions[token]; next(); } else { delete sessions[token]; saveSessions(); res.status(401).json({ error: 'Unauthorized' }); }
};

app.get('/api/verify_session', (req, res) => {
    const token = req.headers.authorization;
    if (token && sessions[token] && sessions[token].expiresAt > Date.now()) {
        const user = panelUsers.find(u => u.username === sessions[token].username);
        res.json({ success: true, role: sessions[token].role, username: sessions[token].username, has2FA: !!user.twoFactorSecret });
    } else res.json({ success: false });
});

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password, token } = req.body;
    const user = panelUsers.find(u => u.username === username);
    if (!user || decrypt(user.password) !== password) return res.status(401).json({ success: false, msg: 'Invalid Credentials' });
    if (user.twoFactorSecret) {
        if (!token) return res.json({ success: false, requires2fa: true });
        if (!speakeasy.totp.verify({ secret: decrypt(user.twoFactorSecret), encoding: 'base32', token })) return res.status(401).json({ success: false, msg: 'Invalid Code' });
    }
    const st = crypto.randomBytes(32).toString('hex');
    sessions[st] = { username: user.username, role: user.role, expiresAt: Date.now() + (7*24*3600*1000) };
    saveSessions();
    res.json({ success: true, token: st, role: user.role, username: user.username, has2FA: !!user.twoFactorSecret });
});

app.post('/api/logout', (req, res) => { if (sessions[req.headers.authorization]) { delete sessions[req.headers.authorization]; saveSessions(); } res.json({ success: true }); });

app.use('/api/', requireAuth);

app.post('/api/library', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAllAccounts().find(a => a.username === req.body.username); res.json({ games: acc.ownedGames || [] }); });

app.post('/api/accounts/bulk', (req, res) => {
    const { data, category, autoStart } = req.body; const lines = data.split(/\r?\n/); let c = 0;
    lines.forEach(l => { const p = l.trim().split(':'); if (p.length >= 2 && !getAllAccounts().find(a => a.username.toLowerCase() === p[0].trim().toLowerCase())) { saveAccount({ username: p[0].trim(), password: p[1].trim(), sharedSecret: p[2]?p[2].trim():"", category: category||"Default", autoStart: !!autoStart, games: [730], nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); activeBots[p[0].trim()] = { client: null, status: 'Stopped' }; c++; } });
    log(`Bulk added ${c}`, "SYSTEM"); res.json({ success: true, count: c });
});
app.post('/api/accounts', (req, res) => { if (getAllAccounts().find(a => a.username === req.body.username)) return res.status(400).json({ error: 'Exists' }); saveAccount({ username: req.body.username, password: req.body.password, sharedSecret: req.body.sharedSecret, category: req.body.category||"Default", autoStart: req.body.autoStart, games: [730], nickname: null, owner: req.user.username, grandTotal: "0.0", addedAt: Date.now(), boostedHours: 0, personaState: 1 }); activeBots[req.body.username] = { client: null, status: 'Stopped' }; res.json({ success: true }); });
app.post('/api/edit', (req, res) => { 
    const { oldUsername, newUsername, newPassword, newSharedSecret, newCategory, newAutoStart } = req.body;
    if(!verifyOwner(req, oldUsername)) return res.status(403).json({});
    const ex = getAllAccounts().find(a => a.username === oldUsername); stopBot(oldUsername);
    if (oldUsername !== newUsername) { deleteAccountFile(oldUsername); delete activeBots[oldUsername]; activeBots[newUsername] = { client: null, status: 'Stopped' }; }
    saveAccount({ ...ex, username: newUsername, password: newPassword, sharedSecret: newSharedSecret, category: newCategory||ex.category||"Default", autoStart: newAutoStart });
    res.json({ success: true });
});
// UPDATED: Return lastError
app.get('/api/accounts', (req, res) => {
    let accounts = getAllAccounts(); if (req.user.role !== 'admin') accounts = accounts.filter(a => a.owner === req.user.username);
    res.json(accounts.map(acc => {
        const b = activeBots[acc.username];
        return { 
            username: acc.username, nickname: acc.nickname || acc.username, avatarHash: acc.avatarHash || null, 
            status: b ? b.status : 'Stopped', 
            lastError: b ? b.lastError : null, // SEND ERROR TO FRONTEND
            grandTotal: acc.grandTotal || "0.0", steamId: acc.steamId || null, games: (acc.games||[]).map(id => ({ id, name: getGameName(id) })), 
            customStatus: acc.customStatus || "", addedAt: acc.addedAt || Date.now(), boostedHours: acc.boostedHours || 0, 
            personaState: acc.personaState !== undefined ? acc.personaState : 1, category: acc.category || "Default", autoStart: !!acc.autoStart 
        };
    }));
});
function verifyOwner(req, username) { if (req.user.role === 'admin') return true; const acc = getAllAccounts().find(a => a.username === username); return acc && acc.owner === req.user.username; }
app.post('/api/start', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); startBotProcess(getAllAccounts().find(a => a.username === req.body.username)); res.json({ success: true }); });
app.post('/api/stop', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); res.json({ success: true }); });
app.post('/api/restart', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); setTimeout(() => { startBotProcess(getAllAccounts().find(a => a.username === req.body.username)); }, 1000); res.json({ success: true }); });
app.post('/api/steamguard', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); const b = activeBots[req.body.username]; if (b && b.guardCallback) { b.guardCallback(req.body.code); b.status = 'Verifying...'; b.guardCallback = null; res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/games', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAllAccounts().find(a => a.username === req.body.username); acc.games = req.body.games.slice(0, 32); acc.customStatus = req.body.customStatus || ""; acc.personaState = parseInt(req.body.personaState); saveAccount(acc); const b = activeBots[req.body.username]; if (b && b.client && b.status === 'Running') { b.client.gamesPlayed(getGamePayload(acc.games, acc.customStatus)); b.client.setPersona(acc.personaState); } res.json({ success: true }); });
app.post('/api/delete', (req, res) => { if (!verifyOwner(req, req.body.username)) return res.status(403).json({}); stopBot(req.body.username); deleteAccountFile(req.body.username); delete activeBots[req.body.username]; res.json({ success: true }); });
app.post('/api/get_account', (req, res) => { if(!verifyOwner(req, req.body.username)) return res.status(403).json({}); const acc = getAllAccounts().find(a => a.username === req.body.username); res.json({ username: acc.username, password: acc.password, sharedSecret: acc.sharedSecret || '', category: acc.category || '', autoStart: !!acc.autoStart }); });
app.post('/api/settings/password', (req, res) => { const u = panelUsers.find(x => x.username === req.user.username); if (decrypt(u.password) !== req.body.currentPass) return res.status(400).json({}); u.password = encrypt(req.body.newPass); fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); res.json({ success: true }); });
app.post('/api/settings/2fa/generate', (req, res) => { const s = speakeasy.generateSecret({ name: `BruddiBooster (${req.user.username})` }); qrcode.toDataURL(s.otpauth_url, (e, d) => { res.json({ secret: s.base32, qr: d }); }); });
app.post('/api/settings/2fa/enable', (req, res) => { if (speakeasy.totp.verify({ secret: req.body.secret, encoding: 'base32', token: req.body.token })) { panelUsers.find(u => u.username === req.user.username).twoFactorSecret = encrypt(req.body.secret); fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/settings/2fa/disable', (req, res) => { panelUsers.find(u => u.username === req.user.username).twoFactorSecret = null; fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); res.json({ success: true }); });
app.get('/api/logs', (req, res) => res.json(systemLogs));
app.get('/api/search_games', (req, res) => { const q = (req.query.q || "").toLowerCase().trim(); if (!q) return res.json([]); const r = allSteamApps.filter(a => a.name && a.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length); res.json(r.slice(0, 20)); });
app.get('/api/users', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json([]); res.json(panelUsers.map(u => ({ username: u.username, role: u.role }))); });
app.post('/api/users', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); panelUsers.push({ username: req.body.username, password: encrypt(req.body.password), role: 'user' }); fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); res.json({ success: true }); });
app.post('/api/users/delete', (req, res) => { if (req.user.role !== 'admin') return res.status(403).json({}); panelUsers = panelUsers.filter(u => u.username !== req.body.username); fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); res.json({ success: true }); });

app.listen(3000, () => log('BruddiBooster v18 Running on 3000', "SYSTEM"));