const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Per-account login throttling.
//
// The IP rate limiter stops one address hammering many accounts. It does nothing
// against a botnet spreading attempts for a single account across many addresses,
// which is the shape a real credential-stuffing attack takes. This tracks failures
// per username as well, with a progressive delay.
//
// In memory only: a restart clears it, which is an acceptable trade for having no
// dependency and no disk writes on the hot path.
// ---------------------------------------------------------------------------

const ATTEMPTS = new Map(); // username -> { fails, lockedUntil, last }
const WINDOW_MS = 60 * 60 * 1000;   // failures older than this are forgotten
const MAX_TRACKED = 5000;           // hard cap so this can't grow without bound

// fails -> lock duration. Short at first so a fat-fingered password isn't punished.
function lockDuration(fails) {
    if (fails < 5) return 0;
    if (fails < 8) return 60 * 1000;         // 1 min
    if (fails < 12) return 5 * 60 * 1000;    // 5 min
    if (fails < 20) return 30 * 60 * 1000;   // 30 min
    return 60 * 60 * 1000;                   // 1 hour, capped
}

function key(username) { return String(username || '').toLowerCase().slice(0, 64); }

function prune(now) {
    for (const [k, v] of ATTEMPTS) {
        if (now - v.last > WINDOW_MS && (!v.lockedUntil || v.lockedUntil < now)) ATTEMPTS.delete(k);
    }
    // If still oversized, drop the oldest entries.
    if (ATTEMPTS.size > MAX_TRACKED) {
        const sorted = [...ATTEMPTS.entries()].sort((a, b) => a[1].last - b[1].last);
        for (let i = 0; i < sorted.length - MAX_TRACKED; i++) ATTEMPTS.delete(sorted[i][0]);
    }
}

// Returns { locked: bool, retryAfterSec } without mutating state.
function checkAccountLock(username) {
    const k = key(username);
    const rec = ATTEMPTS.get(k);
    const now = Date.now();
    if (!rec || !rec.lockedUntil || rec.lockedUntil <= now) return { locked: false, retryAfterSec: 0 };
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
}

// Returns the resulting lock state so the caller can log it.
function recordFailure(username) {
    const k = key(username);
    const now = Date.now();
    let rec = ATTEMPTS.get(k);
    if (!rec || now - rec.last > WINDOW_MS) rec = { fails: 0, lockedUntil: 0, last: now };
    rec.fails++;
    rec.last = now;
    const dur = lockDuration(rec.fails);
    if (dur > 0) rec.lockedUntil = now + dur;
    ATTEMPTS.set(k, rec);
    if (ATTEMPTS.size > MAX_TRACKED) prune(now);
    return { fails: rec.fails, lockedForSec: Math.ceil(dur / 1000) };
}

function recordSuccess(username) { ATTEMPTS.delete(key(username)); }

function lockStats() {
    const now = Date.now();
    let locked = 0;
    for (const v of ATTEMPTS.values()) if (v.lockedUntil > now) locked++;
    return { tracked: ATTEMPTS.size, locked };
}

// ---------------------------------------------------------------------------
// Cookies + CSRF
// ---------------------------------------------------------------------------

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k) continue;
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
        catch (e) { out[k] = part.slice(i + 1).trim(); }
    }
    return out;
}

function newCsrfToken() { return crypto.randomBytes(24).toString('hex'); }

// Session tokens are stored hashed, never in the clear. sessions.json previously held
// working bearer tokens: anyone who could read that file (it was mode 664) could take
// over an account without the password. A plain SHA-256 is right here -- the token is
// 32 random bytes, so there is nothing to brute force and no need for a slow KDF.
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Timing-safe compare that tolerates differing lengths.
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a), bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
    checkAccountLock, recordFailure, recordSuccess, lockStats,
    parseCookies, newCsrfToken, safeEqual, hashToken
};
