const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, 'secret.key');
const MAX_LOGS = 100;
const systemLogs = [];

// --- LOGGING ---
function log(msg, type='INFO', relatedUser=null) {
    const timestamp = new Date().toLocaleTimeString('en-US',{hour12:false});
    const entry = `[${timestamp}] [${type}] ${msg}`;
    console.log(entry);
    systemLogs.unshift({ text: entry, relatedUser });
    if(systemLogs.length > MAX_LOGS) systemLogs.pop();
}

function getLogs() { return systemLogs; }

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

module.exports = { log, getLogs, encrypt, decrypt };