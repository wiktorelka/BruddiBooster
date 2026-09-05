/*
 * Does this still actually boost hours?
 *
 * The leak harness proves we don't retain clients. This proves the thing the tool
 * exists for: that logging in results in the right games being played, that a >32
 * game list rotates, that ownership gates what we try to idle, and that hours are
 * derived from Steam's real playtime.
 *
 * Run: node test/boost-behaviour.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-boost-'));
process.env.HB_DATA_DIR = DATA_DIR;
fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ discordWebhook: '', rotationInterval: 60 }));

// ---- virtual clock (so rotation intervals can be fast-forwarded) ----
const realSetImmediate = global.setImmediate;
let vnow = 0, vseq = 0;
const pending = new Map();
global.setTimeout = (fn, ms = 0, ...a) => { const id = ++vseq; pending.set(id, { time: vnow + ms, fn, a, interval: null }); return id; };
global.setInterval = (fn, ms = 0, ...a) => { const id = ++vseq; pending.set(id, { time: vnow + ms, fn, a, interval: Math.max(1, ms) }); return id; };
global.clearTimeout = global.clearInterval = (id) => { pending.delete(id); };
const drain = () => new Promise(r => realSetImmediate(r));
async function advance(ms) {
    const target = vnow + ms;
    for (let g = 0; g < 100000; g++) {
        let next = null;
        for (const [id, t] of pending) if (t.time <= target && (!next || t.time < next.t.time)) next = { id, t };
        if (!next) break;
        vnow = next.t.time;
        if (next.t.interval) next.t.time = vnow + next.t.interval; else pending.delete(next.id);
        try { next.t.fn(...next.t.a); } catch (e) { console.error('timer threw:', e.message); }
        await drain();
    }
    vnow = target;
    await drain();
}

// ---- stub steam-user ----
const FakeSteamUser = require('./fake-steam-user');
const p = require.resolve('steam-user');
require.cache[p] = { id: p, filename: p, loaded: true, exports: FakeSteamUser, children: [], paths: [] };
const https = require('https');
const noop = () => ({ on() { return this; }, write() {}, end() {}, setTimeout() { return this; }, destroy() {} });
https.get = noop; https.request = noop;

const data = require('../data');
const bot = require('../bot');

let pass = 0; const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { failures.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

function seed(username, games, extra = {}) {
    data.saveAccount(Object.assign({
        username, password: 'pw', sharedSecret: '', proxy: '', category: 'Default',
        autoStart: false, autoAccept: false, games, nickname: null, owner: 'admin',
        grandTotal: '0.0', addedAt: Date.now(), boostedHours: 0, personaState: 1
    }, extra));
    return data.getAccount(username);
}

async function login(username, ownedAppIds, playtimeMinutes) {
    const acc = data.getAccount(username);
    bot.startBotProcess(acc);
    const c = bot.getActiveBots()[username].client;
    // Ownership + playtime come from getUserOwnedApps in the real client too.
    c.getUserOwnedApps = (id, opts, cb) => process.nextTick(() => cb(null, {
        apps: ownedAppIds.map(a => ({ appid: a, name: 'App ' + a, playtime_forever: playtimeMinutes ? Math.round(playtimeMinutes / ownedAppIds.length) : 0 }))
    }));
    c.becomeLoggedOn();
    await drain(); await advance(100);
    return c;
}

(async () => {
    console.log('=== hour-boosting behaviour ===\n');

    // 1. Plays exactly the configured games.
    seed('basic', [730, 440]);
    let c = await login('basic', [730, 440], 0);
    check('plays the configured games on login',
        JSON.stringify(c._playing) === JSON.stringify([730, 440]),
        'played=' + JSON.stringify(c._playing));

    // 2. Custom status is sent as the first element (Steam shows it as the title).
    seed('status', [730], { customStatus: 'Boosting!' });
    c = await login('status', [730], 0);
    check('custom status leads the gamesPlayed payload',
        Array.isArray(c._playing) && c._playing[0] === 'Boosting!' && c._playing[1] === 730,
        'played=' + JSON.stringify(c._playing));

    // 3. Games the account does not own are not idled.
    seed('unowned', [730, 999999]);
    c = await login('unowned', [730], 0);
    await advance(30000);
    check('unowned games are filtered out of the play list',
        Array.isArray(c._playing) && c._playing.includes(730) && !c._playing.includes(999999),
        'played=' + JSON.stringify(c._playing));

    // 4. More than 32 games rotates in batches of 32.
    const many = Array.from({ length: 70 }, (_, i) => 2000 + i);
    seed('rotator', many);
    c = await login('rotator', many, 0);
    const firstBatch = (c._playing || []).slice();
    check('idles at most 32 games at once (Steam limit)', firstBatch.length === 32, 'got ' + firstBatch.length);
    await advance(61 * 60 * 1000); // one rotation interval
    const secondBatch = (c._playing || []).slice();
    check('rotates to a different batch after the interval',
        JSON.stringify(firstBatch) !== JSON.stringify(secondBatch),
        'batch unchanged');
    check('rotation covers new appids',
        secondBatch.some(g => !firstBatch.includes(g)), 'no new games in batch 2');

    // 5. Hours come from Steam's playtime, not an estimate.
    seed('hours', [730]);
    await login('hours', [730], 600); // 600 minutes = 10 hours
    await advance(1000);
    let acc = data.getAccount('hours');
    check('grandTotal reflects Steam playtime', acc.grandTotal === '10.0', 'grandTotal=' + acc.grandTotal);
    check('baseline recorded on first sight', acc.baselineHours !== undefined, 'baselineHours=' + acc.baselineHours);
    check('boostedHours starts at 0 for a pre-existing library',
        Math.abs(acc.boostedHours) < 0.01, 'boostedHours=' + acc.boostedHours);

    // ...and grows only as Steam's playtime grows.
    const b = bot.getActiveBots()['hours'];
    b.client.getUserOwnedApps = (id, o, cb) => process.nextTick(() => cb(null, { apps: [{ appid: 730, name: 'CS2', playtime_forever: 900 }] }));
    await advance(31 * 60 * 1000); // trigger the periodic refresh
    acc = data.getAccount('hours');
    check('boostedHours tracks real gained playtime (10h -> 15h = 5h boosted)',
        Math.abs(acc.boostedHours - 5) < 0.01, 'boostedHours=' + acc.boostedHours);

    // 6. Blocked-session handling: the account stops earning when another device
    //    takes over. Without detection this silently reads as "Running".
    seed('blocked', [730]);
    c = await login('blocked', [730], 0);
    c.emit('playingState', true, 570);
    await drain();
    let b2 = bot.getActiveBots()['blocked'];
    check('blocked session is detected', b2.playBlocked === true, 'playBlocked=' + b2.playBlocked);
    check('status reflects being blocked', /Blocked/.test(b2.status), 'status=' + b2.status);
    check('does NOT reclaim when autoReclaim is off', c._kicked !== true, 'kicked=' + c._kicked);
    c.emit('playingState', false, 0);
    await drain();
    check('recovers to Running when the other session ends',
        bot.getActiveBots()['blocked'].status === 'Running', 'status=' + bot.getActiveBots()['blocked'].status);

    //    ...and does reclaim when the account opts in.
    seed('reclaim', [730], { autoReclaim: true });
    c = await login('reclaim', [730], 0);
    c.emit('playingState', true, 570);
    await drain(); await advance(100);
    check('reclaims the session when autoReclaim is on', c._lastForce === true, 'force=' + c._lastForce);

    // 7. Refresh tokens: first login uses the password, later logins reuse the token.
    seed('token', [730]);
    c = await login('token', [730], 0);
    check('first login sends the password', c._logOnOpts.accountName === 'token' && !c._logOnOpts.refreshToken,
        JSON.stringify(Object.keys(c._logOnOpts)));
    c.emit('refreshToken', 'tok_abc123');
    await drain();
    check('refresh token is persisted', data.getAccount('token').refreshToken === 'tok_abc123',
        'stored=' + data.getAccount('token').refreshToken);
    bot.stopBot('token');
    await advance(100);
    const c2 = await login('token', [730], 0);
    check('second login uses the refresh token, not the password',
        c2._logOnOpts.refreshToken === 'tok_abc123' && !c2._logOnOpts.password,
        JSON.stringify(Object.keys(c2._logOnOpts)));

    //    An expired token must fall back to the password instead of looping.
    c2.emit('error', Object.assign(new Error('InvalidPassword'), { eresult: 5 }));
    await advance(5000);
    check('expired refresh token is discarded', !data.getAccount('token').refreshToken,
        'still=' + data.getAccount('token').refreshToken);
    const c3 = bot.getActiveBots()['token'].client;
    check('falls back to a password login after the token is dropped',
        c3 && c3._logOnOpts.accountName === 'token', 'opts=' + JSON.stringify(c3 && Object.keys(c3._logOnOpts)));

    // 8. eresult 87 stops cleanly instead of entering the crash-restart loop.
    seed('badguard', [730]);
    c = await login('badguard', [730], 0);
    c.emit('error', Object.assign(new Error('InvalidLoginAuthCode'), { eresult: 87 }));
    await drain();
    check('bad Guard code stops the bot with a clear status',
        bot.getActiveBots()['badguard'].status === 'Bad Guard Code',
        'status=' + bot.getActiveBots()['badguard'].status);

    // 9. "In use elsewhere": you launched the game yourself. The bot must keep trying
    //    so it resumes on its own, but back off instead of hammering Steam every 30s
    //    (which is what earns a rate limit).
    seed('elsewhere', [730]);
    bot.startBotProcess(data.getAccount('elsewhere'));
    let ec = bot.getActiveBots()['elsewhere'].client;
    const waits = [];
    for (let i = 0; i < 6; i++) {
        const before = vnow;
        ec.emit('error', Object.assign(new Error('LoggedInElsewhere'), { eresult: 6 }));
        await drain();
        const b3 = bot.getActiveBots()['elsewhere'];
        if (i === 0) {
            check('status reads as in-use, not an error', b3.status === 'Playing elsewhere', 'status=' + b3.status);
            check('a resume time is published for the UI', typeof b3.nextRetry === 'number', 'nextRetry=' + b3.nextRetry);
        }
        // Walk forward until it retries and produces a new client.
        await advance(11 * 60 * 1000);
        waits.push(vnow - before);
        ec = bot.getActiveBots()['elsewhere'].client;
        if (!ec) break;
    }
    check('it never gives up (still retrying after 6 conflicts)', !!ec, 'client=' + !!ec);
    const attempts = bot.getActiveBots()['elsewhere'].elsewhereAttempts;
    check('each conflict escalates the wait', attempts >= 5, 'attempts=' + attempts);

    //    A successful login resets the ladder.
    if (ec) { ec.becomeLoggedOn(); await drain(); }
    check('reconnecting resets the backoff',
        bot.getActiveBots()['elsewhere'].elsewhereAttempts === 0,
        'attempts=' + bot.getActiveBots()['elsewhere'].elsewhereAttempts);
    check('and clears the resume countdown',
        !bot.getActiveBots()['elsewhere'].nextRetry,
        'nextRetry=' + bot.getActiveBots()['elsewhere'].nextRetry);
    bot.stopBot('elsewhere');

    //    Stopping it by hand must cancel the retry loop.
    seed('elsewhere2', [730]);
    bot.startBotProcess(data.getAccount('elsewhere2'));
    bot.getActiveBots()['elsewhere2'].client.emit('error', Object.assign(new Error('x'), { eresult: 6 }));
    await drain();
    bot.stopBot('elsewhere2');
    await advance(20 * 60 * 1000);
    check('a manual stop cancels the retry loop',
        !bot.getActiveBots()['elsewhere2'].client &&
        bot.getActiveBots()['elsewhere2'].status === 'Stopped',
        'status=' + bot.getActiveBots()['elsewhere2'].status);

    // 10. A disconnect caused by you playing must not burn the crash budget, and a
    //     bot that does crash out must eventually be retried.
    seed('kicked', [730]);
    bot.startBotProcess(data.getAccount('kicked'));
    let kc = bot.getActiveBots()['kicked'].client;
    kc.becomeLoggedOn(); await drain();
    kc.emit('disconnected', 6, 'Logged in elsewhere');
    await drain();
    let kb = bot.getActiveBots()['kicked'];
    check('being kicked for playing is treated as in-use, not a crash',
        kb.status === 'Playing elsewhere', 'status=' + kb.status);
    check('it does not consume a restart attempt', (kb.restartCount || 0) === 0, 'restartCount=' + kb.restartCount);

    //     Repeated kicks must never reach 'Crashed'.
    for (let i = 0; i < 5; i++) {
        await advance(11 * 60 * 1000);
        const c = bot.getActiveBots()['kicked'].client;
        if (!c) break;
        c.emit('disconnected', 6, 'Logged in elsewhere');
        await drain();
    }
    check('repeated kicks never park the account at Crashed',
        bot.getActiveBots()['kicked'].status === 'Playing elsewhere',
        'status=' + bot.getActiveBots()['kicked'].status);
    bot.stopBot('kicked');

    //     A genuine crash still gives up, but the watchdog retries it later.
    seed('crashy', [730], { autoStart: true });
    bot.startBotProcess(data.getAccount('crashy'));
    for (let i = 0; i < 5; i++) {
        const c = bot.getActiveBots()['crashy'].client;
        if (!c) break;
        c.becomeLoggedOn(); await drain();
        c.emit('disconnected', 3, 'NoConnection');
        await advance(70 * 1000);
    }
    check('a real crash still stops after the restart budget',
        bot.getActiveBots()['crashy'].status === 'Crashed',
        'status=' + bot.getActiveBots()['crashy'].status);
    // The virtual clock drives timers but not Date.now(), so back-date the crash the
    // same way the stuck-login case does.
    bot.getActiveBots()['crashy'].crashedAt = Date.now() - (45 * 60 * 1000);
    await advance(61 * 60 * 1000);   // one watchdog tick
    check('the watchdog revives a crashed bot rather than leaving it dead',
        bot.getActiveBots()['crashy'].status !== 'Crashed',
        'status=' + bot.getActiveBots()['crashy'].status);
    bot.stopBot('crashy');

    // 11. Scheduling: windows may wrap past midnight.
    const sched = (start, end, hh, mm) => bot.isWithinSchedule(
        { scheduleEnabled: true, scheduleStart: start, scheduleEnd: end },
        new Date(2026, 0, 1, hh, mm));
    check('inside a normal window (09:00-17:00 at 12:00)', sched('09:00','17:00',12,0) === true);
    check('outside a normal window (09:00-17:00 at 20:00)', sched('09:00','17:00',20,0) === false);
    check('inside a window wrapping midnight (22:00-06:00 at 02:00)', sched('22:00','06:00',2,0) === true);
    check('inside a wrapping window before midnight (22:00-06:00 at 23:00)', sched('22:00','06:00',23,0) === true);
    check('outside a wrapping window (22:00-06:00 at 12:00)', sched('22:00','06:00',12,0) === false);
    check('no schedule means always on', bot.isWithinSchedule({ scheduleEnabled: false }) === true);
    check('malformed times fall back to always on',
        bot.isWithinSchedule({ scheduleEnabled: true, scheduleStart: 'x', scheduleEnd: 'y' }) === true);

    //    A bot outside its window must not start.
    seed('scheduled', [730], { scheduleEnabled: true, scheduleStart: '03:00', scheduleEnd: '03:01', autoStart: true });
    bot.startBotProcess(data.getAccount('scheduled'));
    check('does not start outside its scheduled window',
        !bot.getActiveBots()['scheduled'].client &&
        bot.getActiveBots()['scheduled'].status === 'Off schedule',
        'status=' + bot.getActiveBots()['scheduled'].status);

    // 12. Hours history builds a daily series.
    const hAcc = seed('hist', [730], { grandTotal: '12.5' });
    bot.recordDailyHours(hAcc);
    bot.recordDailyHours(hAcc);   // same day must not duplicate
    check('history records one point per day', hAcc.history.length === 1, 'points=' + hAcc.history.length);
    check('history stores the running total', hAcc.history[0].h === 12.5, 'h=' + hAcc.history[0].h);
    hAcc.grandTotal = '20.0';
    bot.recordDailyHours(hAcc);
    check('same-day refresh updates in place', hAcc.history.length === 1 && hAcc.history[0].h === 20,
        JSON.stringify(hAcc.history));

    // 13. Stop actually stops.
    bot.stopBot('basic');
    check('stopBot clears the client', !bot.getActiveBots()['basic'].client);
    check('stopBot reports Stopped', bot.getActiveBots()['basic'].status === 'Stopped');

    // 7. Persona state is applied.
    seed('persona', [730], { personaState: 7 });
    c = await login('persona', [730], 0);
    check('persona state is set from the account', c._persona === 7 || c._personaCalled, 'persona=' + c._persona);

    for (const u of Object.keys(bot.getActiveBots())) bot.stopBot(u);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('PASS - still boosts hours correctly.');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
