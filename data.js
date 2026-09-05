const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('./utils');

// Data lives next to the code by default; HB_DATA_DIR lets tests point at a scratch dir.
const DATA_DIR = process.env.HB_DATA_DIR || __dirname;

const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BUNDLES_FILE = path.join(DATA_DIR, 'bundles.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json');

// Secrets must not be group- or world-readable. secret.key decrypts every stored
// password, sessions.json holds live session records, users.json holds password hashes
// and 2FA secrets. These were all created at the process umask (0664/0775).
const SECRET_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;
function lockDown(file, mode = SECRET_MODE) {
    try { if (fs.existsSync(file)) fs.chmodSync(file, mode); } catch (e) { /* best effort */ }
}

if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: SECRET_DIR_MODE });
lockDown(ACCOUNTS_DIR, SECRET_DIR_MODE);
[USERS_FILE, SESSIONS_FILE].forEach(f => lockDown(f));
try {
    // Existing account files were written before this and keep their old mode.
    if (fs.existsSync(ACCOUNTS_DIR)) fs.readdirSync(ACCOUNTS_DIR)
        .filter(f => f.endsWith('.json'))
        .forEach(f => lockDown(path.join(ACCOUNTS_DIR, f)));
} catch (e) {}

let accountsCache = {};
let accountsLoaded = false;

// Write to a temp file in the same directory, then rename. rename() is atomic on the
// same filesystem, so a crash or power loss mid-write leaves the previous file intact
// instead of a truncated one. The old code wrote in place, so an interrupted save of
// an account (or users.json) destroyed it.
function writeFileAtomic(file, data) {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        // Create the temp file already restricted, so there is no window where the
        // contents exist at a looser mode.
        fs.writeFileSync(tmp, data, { mode: SECRET_MODE });
        fs.renameSync(tmp, file);
        lockDown(file);
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
        throw e;
    }
}

function loadAllAccounts() {
    if (!fs.existsSync(ACCOUNTS_DIR)) return;
    const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json'));
    files.forEach(file => {
        try {
            const r = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf8'));
            if (r && r.username) {
                accountsCache[r.username.toLowerCase()] = { ...r, password: decrypt(r.password), sharedSecret: decrypt(r.sharedSecret), refreshToken: decrypt(r.refreshToken) };
            }
        } catch(e) {}
    });
    accountsLoaded = true;
}

// --- USERS ---
let panelUsers = [];
if (fs.existsSync(USERS_FILE)) {
    try {
        panelUsers = JSON.parse(fs.readFileSync(USERS_FILE));
        let migrated = false;
        panelUsers.forEach(u => {
            if (!u.password.startsWith('$2b$') && !u.password.startsWith('$2a$')) {
                // Migrate from AES-encrypted or plaintext to bcrypt
                const plain = u.password.includes(':') ? decrypt(u.password) : u.password;
                u.password = bcrypt.hashSync(plain, 12);
                migrated = true;
            }
        });
        if (migrated) writeFileAtomic(USERS_FILE, JSON.stringify(panelUsers, null, 2));
    } catch(e){}
} else {
    panelUsers = [{ username: "admin", password: bcrypt.hashSync("password", 12), role: "admin" }];
    writeFileAtomic(USERS_FILE, JSON.stringify(panelUsers, null, 2));
}

function getUsers() { return panelUsers; }
function saveUsers(users) { panelUsers = users; writeFileAtomic(USERS_FILE, JSON.stringify(panelUsers, null, 2)); }

// --- ACCOUNTS ---
function getAllAccounts() {
    if (!accountsLoaded) loadAllAccounts();
    return Object.values(accountsCache);
}

// Callers pass whatever arrived in a JSON body, so a missing or non-string username
// must return null rather than throwing on .toLowerCase() (which surfaced as a 500 on
// every account route).
function normaliseUsername(username) {
    return typeof username === 'string' ? username.trim().toLowerCase() : null;
}

function getAccount(username) {
    if (!accountsLoaded) loadAllAccounts();
    const key = normaliseUsername(username);
    if (!key) return null;
    return accountsCache[key] || null;
}

function saveAccount(acc) {
    if (!accountsLoaded) loadAllAccounts();
    if (!acc || !normaliseUsername(acc.username)) return;
    if (!acc.category || acc.category.trim() === "") acc.category = "Default";
    accountsCache[acc.username.toLowerCase()] = acc;
    const d = { ...acc, password: encrypt(acc.password), sharedSecret: encrypt(acc.sharedSecret), refreshToken: encrypt(acc.refreshToken) };
    try {
        writeFileAtomic(path.join(ACCOUNTS_DIR, acc.username.toLowerCase() + '.json'), JSON.stringify(d, null, 2));
    } catch(e) {}
}

function deleteAccountFile(user) {
    if (!accountsLoaded) loadAllAccounts();
    const lower = normaliseUsername(user);
    if (!lower) return;
    delete accountsCache[lower];
    const p = path.join(ACCOUNTS_DIR, lower + '.json'); 
    if (fs.existsSync(p)) fs.unlinkSync(p); 
}

// --- SESSIONS ---
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE)); } catch(e){} }

function getSessions() { return sessions; }
function saveSessions(s) { 
    sessions = s;
    const now = Date.now();
    for (const t in sessions) if (sessions[t].expiresAt < now) delete sessions[t];
    writeFileAtomic(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); 
}

// --- BUNDLES ---
let bundles = {};
if (fs.existsSync(BUNDLES_FILE)) { try { bundles = JSON.parse(fs.readFileSync(BUNDLES_FILE)); } catch(e){} }

function getBundles() { return bundles; }
function saveBundles(b) { bundles = b; writeFileAtomic(BUNDLES_FILE, JSON.stringify(bundles, null, 2)); }

// --- SETTINGS ---
let globalSettings = { discordWebhook: "", rotationInterval: 60 };
if (fs.existsSync(SETTINGS_FILE)) { try { globalSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE)); } catch(e){} }

function getSettings() { return globalSettings; }
function saveSettings(s) { globalSettings = s; writeFileAtomic(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2)); }

// --- GLOBAL PROXIES ---
let globalProxies = [];
if (fs.existsSync(PROXIES_FILE)) { try { globalProxies = JSON.parse(fs.readFileSync(PROXIES_FILE)); } catch(e){} }

function getGlobalProxies() { return globalProxies; }
function saveGlobalProxies(p) { globalProxies = p; writeFileAtomic(PROXIES_FILE, JSON.stringify(globalProxies, null, 2)); }

function getAccountUsernames() {
    if (!accountsLoaded) loadAllAccounts();
    return Object.keys(accountsCache);
}

module.exports = { getUsers, saveUsers, getAllAccounts, getAccount, saveAccount, deleteAccountFile, getSessions, saveSessions, getBundles, saveBundles, getSettings, saveSettings, getGlobalProxies, saveGlobalProxies, getAccountUsernames };