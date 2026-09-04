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
    systemLogs.unshift({ text: entry, relatedUser });
    if(systemLogs.length > MAX_LOGS) systemLogs.splice(MAX_LOGS);
    if (logListener) logListener({ text: entry, relatedUser });
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
    fs.writeFileSync(KEY_FILE, ENCRYPTION_KEY.toString('hex'));
}

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

module.exports = { log, getLogs, clearLogs, encrypt, decrypt, setLogListener, captureConsole };