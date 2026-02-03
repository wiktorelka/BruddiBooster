const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./utils');

const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const BUNDLES_FILE = path.join(__dirname, 'bundles.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR);

// --- USERS ---
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

function getUsers() { return panelUsers; }
function saveUsers(users) { panelUsers = users; fs.writeFileSync(USERS_FILE, JSON.stringify(panelUsers, null, 2)); }

// --- ACCOUNTS ---
function getAllAccounts() {
    return fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).map(file => {
        try { const r = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file))); return { ...r, password: decrypt(r.password), sharedSecret: decrypt(r.sharedSecret) }; } catch(e) { return null; }
    }).filter(a => a);
}

function getAccount(username) {
    try {
        const p = path.join(ACCOUNTS_DIR, username.toLowerCase() + '.json');
        if (!fs.existsSync(p)) return null;
        const r = JSON.parse(fs.readFileSync(p));
        return { ...r, password: decrypt(r.password), sharedSecret: decrypt(r.sharedSecret) };
    } catch (e) { return null; }
}

function saveAccount(acc) {
    if (!acc.category || acc.category.trim() === "") acc.category = "Default";
    const d = { ...acc, password: encrypt(acc.password), sharedSecret: encrypt(acc.sharedSecret) };
    fs.writeFileSync(path.join(ACCOUNTS_DIR, acc.username.toLowerCase() + '.json'), JSON.stringify(d, null, 2));
}

function deleteAccountFile(user) { const p = path.join(ACCOUNTS_DIR, user.toLowerCase() + '.json'); if (fs.existsSync(p)) fs.unlinkSync(p); }

// --- SESSIONS ---
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE)); } catch(e){} }

function getSessions() { return sessions; }
function saveSessions(s) { 
    sessions = s;
    const now = Date.now();
    for (const t in sessions) if (sessions[t].expiresAt < now) delete sessions[t];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); 
}

// --- BUNDLES ---
let bundles = {};
if (fs.existsSync(BUNDLES_FILE)) { try { bundles = JSON.parse(fs.readFileSync(BUNDLES_FILE)); } catch(e){} }

function getBundles() { return bundles; }
function saveBundles(b) { bundles = b; fs.writeFileSync(BUNDLES_FILE, JSON.stringify(bundles, null, 2)); }

// --- SETTINGS ---
let globalSettings = { discordWebhook: "", rotationInterval: 60 };
if (fs.existsSync(SETTINGS_FILE)) { try { globalSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE)); } catch(e){} }

function getSettings() { return globalSettings; }
function saveSettings(s) { globalSettings = s; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2)); }

module.exports = { getUsers, saveUsers, getAllAccounts, getAccount, saveAccount, deleteAccountFile, getSessions, saveSessions, getBundles, saveBundles, getSettings, saveSettings };