const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, 'secret.key');
const MAX_LOGS = 1000;
const systemLogs = [];
let logListener = null;

// --- LOGGING ---
function setLogListener(fn) { logListener = fn; }
function log(msg, type='INFO', relatedUser=null) {
    const timestamp = new Date().toLocaleTimeString('en-US',{hour12:false});
    const entry = `[${timestamp}] [${type}] ${msg}`;
    console.log(entry);
    appendAudit(type, msg);
    systemLogs.unshift({ text: entry, relatedUser });
    if(systemLogs.length > MAX_LOGS) systemLogs.splice(MAX_LOGS);
    if (logListener) logListener({ text: entry, relatedUser });
}

// --- PERSISTENT AUDIT TRAIL ---
// The log view is a 1000-entry in-memory ring buffer, so every AUTH/AUDIT record --
// logins, failed logins, credential exports, account deletions -- vanished on restart.
// Security-relevant lines are also appended to a file that survives, with a size cap
// and one rotation so it can't grow without bound.
const AUDIT_FILE = path.join(process.env.HB_DATA_DIR || __dirname, 'audit.log');
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const AUDIT_TYPES = new Set(['AUDIT', 'AUTH', 'SECURITY']);

function appendAudit(type, msg) {
    if (!AUDIT_TYPES.has(type)) return;
    try {
        try {
            const st = fs.statSync(AUDIT_FILE);
            if (st.size > AUDIT_MAX_BYTES) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
        } catch (e) { /* no file yet */ }
        const line = `${new Date().toISOString()} [${type}] ${msg}\n`;
        fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
    } catch (e) { /* logging must never break the caller */ }
}

function getAuditLog(limit = 200) {
    try {
        const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
        return raw.trim().split('\n').filter(Boolean).slice(-limit).reverse();
    } catch (e) { return []; }
}

function getLogs() { return systemLogs; }

// Libraries (express-rate-limit, steam-user, node itself) write straight to
// console.error/warn, so those never reached the dashboard's log view -- they were
// only visible to whoever was watching the terminal. Mirror them into the ring buffer.
let consolePatched = false;
function captureConsole() {
    if (consolePatched) return;
    consolePatched = true;
    for (const [method, type] of [['error', 'ERROR'], ['warn', 'WARN']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            try {
                const text = args.map(a => {
                    if (a instanceof Error) return a.stack || a.message;
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }).join(' ');
                // Only the first line: stack traces would flood a 1000-entry buffer.
                const firstLine = text.split('\n')[0].slice(0, 500);
                if (!firstLine.trim()) return;
                const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
                const entry = `[${timestamp}] [${type}] ${firstLine}`;
                systemLogs.unshift({ text: entry, relatedUser: null });
                if (systemLogs.length > MAX_LOGS) systemLogs.splice(MAX_LOGS);
                if (logListener) logListener({ text: entry, relatedUser: null });
            } catch (e) { /* never let logging break the caller */ }
        };
    }
}
function clearLogs() { systemLogs.length = 0; }

// --- SECURITY ---
let ENCRYPTION_KEY;
if (fs.existsSync(KEY_FILE)) {
    ENCRYPTION_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
} else {
    ENCRYPTION_KEY = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, ENCRYPTION_KEY.toString('hex'), { mode: 0o600 });
}
// This key decrypts every stored account password; it must not be readable by other
// users on the box. Applied on every start so an existing loose key is corrected.
try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) {}

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

module.exports = { log, getLogs, clearLogs, encrypt, decrypt, setLogListener, captureConsole, getAuditLog };