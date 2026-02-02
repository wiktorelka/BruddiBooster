const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('../utils/utils');

const DB_PATH = path.join(__dirname, '..', '..', 'database.db');
const db = new Database(DB_PATH);

// --- TABLE CREATION ---
function createTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT,
            twoFactorSecret TEXT
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            sharedSecret TEXT,
            proxy TEXT,
            category TEXT,
            autoStart BOOLEAN,
            autoAccept BOOLEAN,
            games TEXT,
            nickname TEXT,
            owner TEXT,
            grandTotal TEXT,
            addedAt INTEGER,
            boostedHours REAL,
            personaState INTEGER,
            steamId TEXT,
            avatarHash TEXT,
            realName TEXT,
            customURL TEXT,
            privacy TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT,
            role TEXT,
            expiresAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS bundles (
            name TEXT PRIMARY KEY,
            games TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS hourly_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_username TEXT,
            hours_boosted REAL,
            timestamp INTEGER
        );
    `);
}

// --- MIGRATION ---
function migrate() {
    const MIGRATION_FILE = path.join(__dirname, '..', '..', '.migrated');
    if (fs.existsSync(MIGRATION_FILE)) return;

    console.log("Running initial migration from JSON files to SQLite...");

    // Users
    const USERS_FILE = path.join(__dirname, '..', '..', 'users.json');
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE));
            const stmt = db.prepare('INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)');
            users.forEach(u => stmt.run(u.username, u.password.includes(':') ? u.password : encrypt(u.password), u.role));
            fs.renameSync(USERS_FILE, USERS_FILE + '.bak');
        } catch (e) { console.error("Failed to migrate users:", e); }
    }

    // Accounts
    const ACCOUNTS_DIR = path.join(__dirname, '..', '..', 'accounts');
    if (fs.existsSync(ACCOUNTS_DIR)) {
        const stmt = db.prepare('INSERT OR IGNORE INTO accounts (username, password, sharedSecret, proxy, category, autoStart, autoAccept, games, nickname, owner, grandTotal, addedAt, boostedHours, personaState) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).forEach(file => {
            try {
                const acc = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file)));
                stmt.run(acc.username, encrypt(acc.password), encrypt(acc.sharedSecret), acc.proxy, acc.category, acc.autoStart, acc.autoAccept, JSON.stringify(acc.games), acc.nickname, acc.owner, acc.grandTotal, acc.addedAt, acc.boostedHours, acc.personaState);
            } catch (e) { console.error(`Failed to migrate account ${file}:`, e); }
        });
        fs.renameSync(ACCOUNTS_DIR, ACCOUNTS_DIR + '.bak');
    }

    // Bundles
    const BUNDLES_FILE = path.join(__dirname, '..', '..', 'bundles.json');
    if (fs.existsSync(BUNDLES_FILE)) {
        try {
            const bundles = JSON.parse(fs.readFileSync(BUNDLES_FILE));
            const stmt = db.prepare('INSERT OR IGNORE INTO bundles (name, games) VALUES (?, ?)');
            for (const [name, games] of Object.entries(bundles)) {
                stmt.run(name, JSON.stringify(games));
            }
            fs.renameSync(BUNDLES_FILE, BUNDLES_FILE + '.bak');
        } catch (e) { console.error("Failed to migrate bundles:", e); }
    }

    // Settings
    const SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
            const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
            for (const [key, value] of Object.entries(settings)) {
                stmt.run(key, value);
            }
            fs.renameSync(SETTINGS_FILE, SETTINGS_FILE + '.bak');
        } catch (e) { console.error("Failed to migrate settings:", e); }
    }

    fs.writeFileSync(MIGRATION_FILE, 'done');
    console.log("Migration complete.");
}

createTables();
migrate();

// --- USERS ---
function getUsers() { return db.prepare('SELECT * FROM users').all(); }
function getUser(username) { return db.prepare('SELECT * FROM users WHERE username = ?').get(username); }
function createUser(username, password, role = 'user') { return db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, encrypt(password), role); }
function updateUser(username, data) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    return db.prepare(`UPDATE users SET ${fields} WHERE username = ?`).run(...values, username);
}
function deleteUser(username) { return db.prepare('DELETE FROM users WHERE username = ?').run(username); }


// --- ACCOUNTS ---
function getAllAccounts() {
    const accounts = db.prepare('SELECT * FROM accounts').all();
    return accounts.map(acc => ({
        ...acc,
        password: decrypt(acc.password),
        sharedSecret: decrypt(acc.sharedSecret),
        games: JSON.parse(acc.games || '[]'),
        privacy: JSON.parse(acc.privacy || '{}')
    }));
}
function getAccount(username) {
    const acc = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
    if (!acc) return null;
    return {
        ...acc,
        password: decrypt(acc.password),
        sharedSecret: decrypt(acc.sharedSecret),
        games: JSON.parse(acc.games || '[]'),
        privacy: JSON.parse(acc.privacy || '{}')
    };
}
function createAccount(acc) {
    const { username, password, sharedSecret, proxy, category, autoStart, autoAccept, games, nickname, owner, grandTotal, addedAt, boostedHours, personaState } = acc;
    return db.prepare('INSERT INTO accounts (username, password, sharedSecret, proxy, category, autoStart, autoAccept, games, nickname, owner, grandTotal, addedAt, boostedHours, personaState) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(username, encrypt(password), encrypt(sharedSecret), proxy, category, autoStart, autoAccept, JSON.stringify(games), nickname, owner, grandTotal, addedAt, boostedHours, personaState);
}
function updateAccount(username, data) {
    const acc = getAccount(username);
    if (!acc) return;

    const newAcc = { ...acc, ...data };
    const { password, sharedSecret, games, privacy, ...rest } = newAcc;

    const fields = Object.keys(rest).map(k => `${k} = ?`).join(', ');
    const values = Object.values(rest);

    db.prepare(`UPDATE accounts SET ${fields}, password = ?, sharedSecret = ?, games = ?, privacy = ? WHERE username = ?`).run(...values, encrypt(password), encrypt(sharedSecret), JSON.stringify(games), JSON.stringify(privacy), username);
}
function deleteAccount(username) { return db.prepare('DELETE FROM accounts WHERE username = ?').run(username); }


// --- SESSIONS ---
function getSession(token) { return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token); }
function createSession(token, username, role, expiresAt) { return db.prepare('INSERT INTO sessions (token, username, role, expiresAt) VALUES (?, ?, ?, ?)').run(token, username, role, expiresAt); }
function deleteSession(token) { return db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function cleanupSessions() { return db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now()); }
setInterval(cleanupSessions, 60 * 60 * 1000);


// --- BUNDLES ---
function getBundles() {
    const bundles = db.prepare('SELECT * FROM bundles').all();
    const result = {};
    bundles.forEach(b => { result[b.name] = JSON.parse(b.games || '[]'); });
    return result;
}
function createBundle(name, games) { return db.prepare('INSERT OR REPLACE INTO bundles (name, games) VALUES (?, ?)').run(name, JSON.stringify(games)); }
function deleteBundle(name) { return db.prepare('DELETE FROM bundles WHERE name = ?').run(name); }


// --- SETTINGS ---
function getSettings() {
    const settings = db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach(s => { result[s.key] = s.value; });
    return result;
}
function updateSetting(key, value) { return db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value); }

// --- STATS ---
function recordHourlyStat(account_username, hours_boosted) {
    return db.prepare('INSERT INTO hourly_stats (account_username, hours_boosted, timestamp) VALUES (?, ?, ?)').run(account_username, hours_boosted, Date.now());
}

function getStatsLast30Days() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const daily = db.prepare(`
        SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as day, SUM(hours_boosted) as total_hours
        FROM hourly_stats
        WHERE timestamp >= ?
        GROUP BY day
        ORDER BY day
    `).all(thirtyDaysAgo);

    const byAccount = db.prepare(`
        SELECT account_username, SUM(hours_boosted) as total_hours
        FROM hourly_stats
        WHERE timestamp >= ?
        GROUP BY account_username
        ORDER BY total_hours DESC
        LIMIT 10
    `).all(thirtyDaysAgo);

    return { daily, byAccount };
}


module.exports = {
    db,
    getUsers, getUser, createUser, updateUser, deleteUser,
    getAllAccounts, getAccount, createAccount, updateAccount, deleteAccount,
    getSession, createSession, deleteSession,
    getBundles, createBundle, deleteBundle,
    getSettings, updateSetting,
    recordHourlyStat, getStatsLast30Days
};