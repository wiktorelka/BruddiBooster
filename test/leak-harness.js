/*
 * Memory-leak harness for bot.js
 *
 * Real Steam logins can't be driven thousands of times, so this stubs steam-user
 * and replaces the global timer functions with a virtual clock. That gives two
 * things the real thing can't: instant time travel through the restart backoffs,
 * and an exact count of the timer closures still holding a reference to a dead
 * client -- which is the leak we're hunting.
 *
 * Run: node --expose-gc test/leak-harness.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

if (typeof global.gc !== 'function') {
    console.error('Run with --expose-gc:  node --expose-gc test/leak-harness.js');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Isolate the data directory before anything requires data.js
// ---------------------------------------------------------------------------

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-leak-'));
process.env.HB_DATA_DIR = DATA_DIR;
fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ discordWebhook: '', rotationInterval: 60 }));

// ---------------------------------------------------------------------------
// 2. Virtual clock -- installed before bot.js is required so its module-scope
//    setInterval calls land in our pending map too.
// ---------------------------------------------------------------------------

const realSetTimeout = global.setTimeout;
const realSetImmediate = global.setImmediate;

let vnow = 0;
let vseq = 0;
const pending = new Map(); // id -> { time, fn, args, interval }

global.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++vseq;
    pending.set(id, { time: vnow + ms, fn, args, interval: null });
    return id;
};
global.setInterval = (fn, ms = 0, ...args) => {
    const id = ++vseq;
    pending.set(id, { time: vnow + ms, fn, args, interval: Math.max(1, ms) });
    return id;
};
global.clearTimeout = (id) => { pending.delete(id); };
global.clearInterval = (id) => { pending.delete(id); };

const drain = () => new Promise(r => realSetImmediate(r));

async function advance(ms) {
    const target = vnow + ms;
    // Cap the work so a runaway interval can't spin forever.
    for (let guard = 0; guard < 200000; guard++) {
        let next = null;
        for (const [id, t] of pending) {
            if (t.time <= target && (next === null || t.time < next.t.time)) next = { id, t };
        }
        if (!next) break;
        vnow = next.t.time;
        if (next.t.interval) next.t.time = vnow + next.t.interval;
        else pending.delete(next.id);
        try { next.t.fn(...next.t.args); } catch (e) { console.error('  timer threw:', e.message); }
        await drain();
    }
    vnow = target;
    await drain();
}

// Timers registered at module scope (app list refresh, stats loop, watchdog) are
// permanent by design; snapshot them so they don't count against the per-bot total.
let baselineTimerIds = new Set();
const perBotTimers = () => [...pending.keys()].filter(id => !baselineTimerIds.has(id)).length;

// ---------------------------------------------------------------------------
// 3. Stub steam-user and the outbound HTTP bot.js uses
// ---------------------------------------------------------------------------

const FakeSteamUser = require('./fake-steam-user');
const steamUserPath = require.resolve('steam-user');
require.cache[steamUserPath] = {
    id: steamUserPath, filename: steamUserPath, loaded: true,
    exports: FakeSteamUser, children: [], paths: []
};

const https = require('https');
const noopReq = () => ({ on() { return this; }, write() {}, end() {}, setTimeout() { return this; }, destroy() {} });
https.get = noopReq;
https.request = noopReq;

// ---------------------------------------------------------------------------
// 4. Load the code under test
// ---------------------------------------------------------------------------

const data = require('../data');
const bot = require('../bot');
baselineTimerIds = new Set(pending.keys());

function seedAccount(username, games = [730]) {
    data.saveAccount({
        username, password: 'pw', sharedSecret: '', proxy: '', category: 'Default',
        autoStart: false, autoAccept: false, games, nickname: null, owner: 'admin',
        grandTotal: '0.0', addedAt: Date.now(), boostedHours: 0, personaState: 1
    });
    return data.getAccount(username);
}

// ---------------------------------------------------------------------------
// 5. Measurement
// ---------------------------------------------------------------------------

async function settle() {
    for (let i = 0; i < 4; i++) { global.gc(); await drain(); }
    global.gc();
}

// Clients still reachable, minus the ones a running bot is legitimately holding.
function orphanCount() {
    const activeBots = bot.getActiveBots();
    const held = new Set();
    for (const u of Object.keys(activeBots)) {
        if (activeBots[u].client) held.add(activeBots[u].client);
    }
    let orphans = 0;
    for (const ref of FakeSteamUser.liveInstances()) {
        const c = ref.deref();
        if (c && !held.has(c)) orphans++;
    }
    return { orphans, held: held.size };
}

const results = [];
async function measure(label) {
    await settle();
    const { orphans, held } = orphanCount();
    const mu = process.memoryUsage();
    const heapMB = +(mu.heapUsed / 1048576).toFixed(1);
    // The client ballast is a Buffer, so it lands in `external`, not `heapUsed`.
    const extMB = +(mu.external / 1048576).toFixed(1);
    const timers = perBotTimers();
    results.push({ label, orphans, held, timers, heapMB, extMB });
    console.log(`  ${label.padEnd(34)} orphans=${String(orphans).padStart(4)}  held=${String(held).padStart(3)}  timers=${String(timers).padStart(4)}  heap=${heapMB}MB  external=${extMB}MB`);
    return { orphans, held, timers, heapMB, extMB };
}

// ---------------------------------------------------------------------------
// 6. Scenarios
// ---------------------------------------------------------------------------

// Clears every bot out from under the module so phases don't contaminate one another.
async function reset() {
    const activeBots = bot.getActiveBots();
    for (const u of Object.keys(activeBots)) {
        bot.stopBot(u);
        delete activeBots[u];
    }
    // Give any lingering per-bot timer a chance to fire and drop its closure.
    await advance(10 * 60 * 1000);
    for (const id of [...pending.keys()]) if (!baselineTimerIds.has(id)) pending.delete(id);
    await settle();
}

async function phase1_startStopChurn(cycles = 300) {
    console.log(`\n[1] start/stop churn x${cycles}`);
    const acc = seedAccount('churn');
    for (let i = 0; i < cycles; i++) {
        bot.startBotProcess(acc);
        const c = bot.getActiveBots()['churn'].client;
        c.becomeLoggedOn();
        await drain();
        bot.stopBot('churn');
    }
    return measure('after churn');
}

async function phase2_crashLoop(cycles = 100) {
    console.log(`\n[2] crash/restart loop x${cycles}`);
    const acc = seedAccount('crasher');
    for (let i = 0; i < cycles; i++) {
        const b = bot.getActiveBots()['crasher'];
        if (!b || !b.client) bot.startBotProcess(acc);
        const c = bot.getActiveBots()['crasher'].client;
        c.becomeLoggedOn();
        await drain();
        c.emit('disconnected', 3, 'NoConnection');   // -> handleCrash
        await advance(65 * 1000);                     // walk through the backoff
        if (bot.getActiveBots()['crasher'].status === 'Crashed') {
            bot.getActiveBots()['crasher'].restartCount = 0;
            bot.getActiveBots()['crasher'].status = 'Stopped';
        }
    }
    bot.stopBot('crasher');
    return measure('after crash loop');
}

// The headline case: a client wedged on a dead proxy that never reaches loggedOn.
// logOff() cannot help it (no connection yet), and the watchdog replaces it.
async function phase3_stuckLoginWatchdog(cycles = 50) {
    console.log(`\n[3] stuck-at-login watchdog restarts x${cycles}`);
    const acc = seedAccount('stuck');
    bot.startBotProcess(acc);
    for (let i = 0; i < cycles; i++) {
        const b = bot.getActiveBots()['stuck'];
        if (!b.client) { bot.startBotProcess(acc); }
        const b2 = bot.getActiveBots()['stuck'];
        b2.status = 'Logging in...';
        b2.loginStartTime = Date.now() - 400000;  // older than the 5 min threshold
        await advance(60 * 60 * 1000);            // fire the hourly watchdog
        await advance(10 * 1000);                 // let its 5s restart land
    }
    bot.stopBot('stuck');
    return measure('after watchdog restarts');
}

async function phase4_concurrentRestart(cycles = 50) {
    console.log(`\n[4] rate-limit retry racing a manual start x${cycles}`);
    const acc = seedAccount('racer');
    for (let i = 0; i < cycles; i++) {
        bot.startBotProcess(acc);
        const c = bot.getActiveBots()['racer'].client;
        c.becomeLoggedOn();
        await drain();
        // Rate limit -> stopBot + a 5 min retry timer.
        c.emit('error', Object.assign(new Error('RateLimitExceeded'), { eresult: 84 }));
        await drain();
        // Operator hits Start before the retry fires: guard is open, new client.
        bot.startBotProcess(acc);
        bot.getActiveBots()['racer'].client.becomeLoggedOn();
        await advance(6 * 60 * 1000);  // the queued retry now fires too
        bot.stopBot('racer');
    }
    return measure('after restart race');
}

async function phase5_rotation() {
    console.log('\n[5] game rotation interval cleanup');
    const many = Array.from({ length: 100 }, (_, i) => 1000 + i);
    const acc = seedAccount('rotator', many);
    bot.startBotProcess(acc);
    bot.getActiveBots()['rotator'].client.becomeLoggedOn();
    await drain();
    await advance(2 * 60 * 60 * 1000);  // let it rotate a couple of times
    const hadInterval = !!bot.getActiveBots()['rotator'].rotationInterval;
    bot.stopBot('rotator');
    const stillPending = !!bot.getActiveBots()['rotator'].rotationInterval;
    console.log(`  rotation interval created=${hadInterval} still set after stop=${stillPending}`);
    return measure('after rotation');
}

// ---------------------------------------------------------------------------
// 7. Run
// ---------------------------------------------------------------------------

(async () => {
    console.log('=== bot.js leak harness ===');
    console.log(`data dir: ${DATA_DIR}\n`);
    const base = await measure('baseline');

    const phases = [
        ['start/stop churn', await phase1_startStopChurn()],
        ['crash loop',       (await reset(), await phase2_crashLoop())],
        ['watchdog restart', (await reset(), await phase3_stuckLoginWatchdog())],
        ['restart race',     (await reset(), await phase4_concurrentRestart())],
        ['rotation',         (await reset(), await phase5_rotation())]
    ];
    await reset();
    const final = await measure('final (all bots stopped)');

    console.log('\n=== summary ===');
    console.table(results);
    console.log(`clients constructed in total: ${FakeSteamUser.stats().created}`);

    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    const failures = [];
    // Each phase ends with its bots stopped, so nothing should still be reachable
    // and no per-bot timer should still be holding a closure.
    for (const [name, r] of phases) {
        if (r.orphans > 0) failures.push(`${name}: ${r.orphans} orphaned client(s) retained`);
        if (r.timers > 0) failures.push(`${name}: ${r.timers} per-bot timer(s) still pending`);
    }
    if (final.orphans > 0) failures.push(`${final.orphans} clients still reachable with every bot stopped`);
    if (final.timers > 0) failures.push(`${final.timers} per-bot timers still pending with every bot stopped`);
    // External memory is where the client ballast lands; it must return to baseline.
    if (final.extMB > base.extMB + 5) failures.push(`external memory grew ${base.extMB}MB -> ${final.extMB}MB`);

    if (failures.length) {
        console.log('\nFAIL');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('\nPASS - no orphaned clients, no leaked per-bot timers.');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
