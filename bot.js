const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');
const { log } = require('./utils');
const { getAllAccounts, getAccount, saveAccount, getSettings, getGlobalProxies } = require('./data');

const activeBots = {};
const pendingFreeGames = {};
let steamAppsMap = {};
const TOP_GAMES_FALLBACK = { 730: "Counter-Strike 2", 440: "Team Fortress 2", 570: "Dota 2", 252490: "Rust", 271590: "GTA V" };

// --- PER-BOT TIMER TRACKING ---
// Every deferred callback in this file closes over a SteamUser client. Untracked,
// they keep dead clients (and their PICS caches) alive long after the bot stopped,
// so all of them go through this registry and die with the bot.
function botTimeout(bot, fn, ms) {
    if (!bot) return null;
    if (!bot.timers) bot.timers = new Set();
    const id = setTimeout(() => { bot.timers.delete(id); fn(); }, ms);
    bot.timers.add(id);
    return id;
}

function clearBotTimers(bot) {
    if (!bot || !bot.timers) return;
    for (const id of bot.timers) clearTimeout(id);
    bot.timers.clear();
}

// The single teardown path for a client. Every caller that used to hand-roll
// removeAllListeners/logOff/client=null must use this instead.
function destroyClient(bot) {
    if (!bot) return;
    if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
    if (bot.crashTimeout) { clearTimeout(bot.crashTimeout); bot.crashTimeout = null; }
    clearBotTimers(bot);
    bot.nextRotation = null;
    bot.ownedApps = null;
    bot.ownershipReady = false;

    const client = bot.client;
    bot.client = null;
    if (!client) return;

    const wasConnected = !!client.steamID;

    client.removeAllListeners();
    // A torn-down client can still emit 'error'. On an EventEmitter with no error
    // listener that throws, which would take down every other bot in this process.
    client.on('error', () => {});
    try { client.logOff(); } catch(e) {}

    if (!wasConnected) {
        // logOff() is a no-op for a client that never finished connecting:
        // steam-user's _disconnect() only does `this._connection && this._connection
        // .end(true)`, and a client wedged on a dead proxy has no _connection yet, so
        // its reconnect timer would hold the instance forever. Force the teardown.
        // (When it *was* connected, logOff's own 4s path does this for us.)
        try { client._disconnect(true); } catch(e) {}
    }
}

// --- APP OWNERSHIP ---
// steam-user's ownsApp()/picsCache requires enablePicsCache, which on login pulls
// full parsed appinfo for every app in every owned package and holds it in memory.
// On an account with a large library (this tool mass-adds free licenses, so they
// only grow) that is gigabytes and OOMs the process. getUserOwnedApps gives us the
// same ownership answer for a few hundred KB, so we keep our own appid Set.
function refreshOwnedApps(username, client) {
    return new Promise((resolve) => {
        const bot = activeBots[username];
        if (!bot || bot.client !== client || !client.steamID) return resolve(null);
        client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeInfo: true }, (err, res) => {
            const b = activeBots[username];
            if (err || !res || !res.apps || !b || b.client !== client) return resolve(null);
            b.ownedApps = new Set(res.apps.map(a => a.appid));
            b.ownershipReady = true;

            // Same call previously powered updateHours; do the bookkeeping here so we
            // only ask Steam once.
            let minutes = 0;
            const owned = res.apps.map(a => ({ id: a.appid, name: a.name }));
            res.apps.forEach(a => minutes += (a.playtime_forever || 0));
            const acc = getAccount(username);
            if (acc) {
                const total = minutes / 60;
                acc.grandTotal = total.toFixed(1);
                acc.ownedGames = owned;

                // boostedHours used to be a guess (games.length/60 per minute of
                // uptime) that counted hours Steam may never have credited. Derive it
                // from Steam's own playtime instead: hours gained since we first saw
                // this account. On first sight we back-date the baseline so the number
                // already on screen is preserved rather than resetting to zero.
                if (acc.baselineHours === undefined) {
                    acc.baselineHours = Math.max(0, total - (acc.boostedHours || 0));
                }
                acc.boostedHours = Math.max(0, total - acc.baselineHours);
                recordDailyHours(acc);

                saveAccount(acc);
            }
            resolve(res.apps);
        });
    });
}

// Returns true/false, or null when ownership isn't known yet (caller should wait).
function botOwnsApp(bot, appid) {
    if (!bot || !bot.ownershipReady || !bot.ownedApps) return null;
    return bot.ownedApps.has(Number(appid));
}

// --- SCHEDULING ---
// An account can be restricted to a daily window (e.g. 22:00-06:00). Windows may wrap
// past midnight. Empty/absent schedule means "always on", which is the default so
// existing accounts are unaffected.
function parseHHMM(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

function isWithinSchedule(acc, now = new Date()) {
    if (!acc || !acc.scheduleEnabled) return true;
    const start = parseHHMM(acc.scheduleStart);
    const end = parseHHMM(acc.scheduleEnd);
    if (start === null || end === null || start === end) return true; // malformed = always on
    const mins = now.getHours() * 60 + now.getMinutes();
    // A window that wraps midnight is "outside the inverted range".
    return start < end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

// Runs every minute: start accounts entering their window, stop those leaving it.
function enforceSchedules() {
    getAllAccounts().forEach(acc => {
        if (!acc.scheduleEnabled) return;
        const bot = activeBots[acc.username];
        const inside = isWithinSchedule(acc);
        const running = bot && bot.client;

        if (inside && !running && acc.autoStart && bot?.status !== 'Crashed') {
            log(`${acc.username}: entering scheduled window, starting.`, "SCHEDULE", acc.username);
            startBotProcess(acc);
        } else if (!inside && running) {
            log(`${acc.username}: outside scheduled window, stopping.`, "SCHEDULE", acc.username);
            stopBot(acc.username);
            if (activeBots[acc.username]) activeBots[acc.username].status = 'Off schedule';
        }
    });
}

// --- HOURS HISTORY ---
// grandTotal is a single cumulative number, which makes trends invisible. Keep one
// datapoint per account per day, capped, so the UI can draw a real chart.
const HISTORY_DAYS = 90;
function recordDailyHours(acc) {
    if (!acc) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!Array.isArray(acc.history)) acc.history = [];
    const total = parseFloat(acc.grandTotal) || 0;
    const last = acc.history[acc.history.length - 1];
    if (last && last.d === day) { last.h = total; return; }
    acc.history.push({ d: day, h: total });
    if (acc.history.length > HISTORY_DAYS) acc.history.splice(0, acc.history.length - HISTORY_DAYS);
}

// Refresh tokens expire and are invalidated by a password change; drop ours so the
// next attempt falls back to the password.
function clearRefreshToken(username) {
    const acc = getAccount(username);
    if (acc && acc.refreshToken) { acc.refreshToken = null; saveAccount(acc); }
}

// Bumped on every start. A restart scheduled against an older epoch has been
// superseded and must not create a second client for the same account.
function currentEpoch(username) {
    const b = activeBots[username];
    return b ? (b.epoch || 0) : -1;
}

function updateAppList() {
    https.get('https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json', (res) => {
        if (res.statusCode !== 200) { res.resume(); return; }
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                // Store only {name} keyed by appid, not the raw upstream objects, and
                // no second lowercased copy: the full list is ~185k entries and every
                // extra field costs tens of MB of permanently resident heap.
                const newMap = {};
                parsed.forEach(a => { if (a.name) newMap[a.appid] = a.name; });
                steamAppsMap = newMap; // atomic swap — never partially empty
                searchCache.q = null;
                log(`Loaded ${parsed.length} games.`, "SUCCESS");
            } catch(e){}
        });
    }).on('error', () => {});
}
updateAppList(); setInterval(updateAppList, 86400000);

function getGameName(id) { return steamAppsMap[id] || TOP_GAMES_FALLBACK[id] || "Unknown Game"; }

// Walks the map in place rather than materialising Object.values() (a ~185k-element
// array) on every keystroke. One-entry cache because the dashboard's debounced search
// re-sends the same query as the user pauses.
const searchCache = { q: null, result: null };
function searchGames(q) {
    if (searchCache.q === q) return searchCache.result;
    const hits = [];
    for (const appid in steamAppsMap) {
        const name = steamAppsMap[appid];
        if (name.toLowerCase().includes(q)) hits.push({ appid: +appid, name });
    }
    hits.sort((a, b) => a.name.length - b.name.length);
    const result = hits.slice(0, 20);
    searchCache.q = q; searchCache.result = result;
    return result;
}

function getGamePayload(games, customStatus) {
    const payload = [];
    if (customStatus && typeof customStatus === 'string' && customStatus.trim().length > 0) payload.push(customStatus);
    if (Array.isArray(games)) payload.push(...games);
    return payload;
}

function updateHours(username, client) {
    // Randomised so 245 bots don't all hit Steam at the same instant.
    const delay = Math.floor(Math.random() * 45000) + 15000;
    botTimeout(activeBots[username], () => {
        if (!activeBots[username] || activeBots[username].client !== client) return;
        refreshOwnedApps(username, client);
    }, delay);
}


function checkAndEnsureGames(username, client, retryCount = 0) {
    return new Promise((resolve) => {
        botTimeout(activeBots[username], () => {
            if (!activeBots[username] || activeBots[username].client !== client) return resolve(false);
            const acc = getAccount(username);
            if (!acc || !acc.games || acc.games.length === 0) return resolve(false);

            const bot = activeBots[username];
            if (!bot.ownershipReady) {
                if (retryCount < 6) {
                    log(`${username} ownership not loaded yet, retrying in 5s... (${retryCount + 1}/6)`, "BOT", username);
                    botTimeout(bot, () => checkAndEnsureGames(username, client, retryCount + 1).then(resolve), 5000);
                    return;
                }
                log(`${username} ownership not loaded, skipping game check.`, "WARN", username);
                return resolve(false);
            }
            const missing = acc.games.filter(id => botOwnsApp(bot, id) === false);

            if (missing.length === 0) return resolve(false);

            log(`${username} missing ${missing.length} games. Attempting to request free licenses...`, "BOT", username);
            
            client.requestFreeLicense(missing, (err, granted, grantedIds) => {
                if (err) {
                    log(`${username} failed to request free games: ${err.message}`, "WARN", username);
                    return resolve(false);
                }
                
                let changed = false;
                const actuallyGranted = grantedIds || [];
                const stillMissing = missing.filter(id => !actuallyGranted.includes(id));
                
                if (stillMissing.length > 0) {
                    const missingNames = stillMissing.map(id => getGameName(id)).join(', ');
                    const msg = `Removed ${stillMissing.length} unaddable games (Paid/Region Lock): ${missingNames}`;
                    log(`${username}: ${msg}`, "WARN", username);
                    if (activeBots[username]) activeBots[username].lastError = msg;
                    acc.games = acc.games.filter(id => !stillMissing.includes(id));
                    saveAccount(acc);
                    changed = true;
                }
                
                if (actuallyGranted.length > 0) {
                    log(`${username} added ${actuallyGranted.length} free games.`, "SUCCESS", username);
                    updateHours(username, client);
                    changed = true;
                }
                resolve(changed);
            });
        }, Math.floor(Math.random() * 5000) + 2000);
    });
}

function sendDiscordWebhook(title, description, color, webhookUrl = null) {
    const url = webhookUrl || getSettings().discordWebhook;
    if (!url) return;
    const payload = JSON.stringify({
        embeds: [{
            title: title,
            description: description,
            color: color,
            footer: { text: "BruddiBooster" },
            timestamp: new Date().toISOString()
        }]
    });
    // The response must be consumed or the socket is held until the agent times it
    // out — and this fires on every crash, guard prompt and rate limit.
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => res.resume());
    req.on('error', () => {});
    req.setTimeout(10000, () => req.destroy());
    req.write(payload); req.end();
}

function handleCrash(username, msg) {
    const bot = activeBots[username];
    if (!bot || bot.status === 'Stopped' || bot.status === 'Crashed') return;

    const now = Date.now();
    if (now - (bot.lastRestart || 0) > 600000) bot.restartCount = 0; // Reset if > 10 mins since last crash

    bot.restartCount = (bot.restartCount || 0) + 1;
    bot.lastRestart = now;

    if (bot.restartCount <= 3) {
        const wait = Math.min(5000 * Math.pow(2, bot.restartCount - 1), 60000); // 5s, 10s, 20s
        log(`${username} crashed: ${msg}. Restarting (${bot.restartCount}/3) in ${wait/1000}s...`, "WARN", username);
        
        if (bot.restartCount >= 2) {
            rotateProxy(username);
        }

        bot.status = `Restarting (${bot.restartCount}/3)...`;

        const epoch = currentEpoch(username);
        destroyClient(bot);

        botTimeout(bot, () => {
            const acc = getAccount(username);
            if (!acc || !activeBots[username]) return;
            if (activeBots[username].status === 'Stopped') return;
            if (currentEpoch(username) !== epoch) return; // superseded by another start
            startBotProcess(acc);
        }, wait);
    } else {
        log(`${username} crashed 3 times in a row. Stopping. Last Error: ${msg}`, "ERROR", username);
        bot.status = 'Crashed';
        bot.lastError = `Too many restarts. Last error: ${msg}`;
        sendDiscordWebhook("Bot Crashed", `Account **${username}** failed to restart 3 times. Last error: ${msg}`, 15158332);

        destroyClient(bot);
    }
}

function rotateProxy(username) {
    const proxies = getGlobalProxies();
    if (!proxies || proxies.length === 0) return;

    const acc = getAccount(username);
    if (!acc) return;

    // Pick a random proxy from the pool
    const newProxy = proxies[Math.floor(Math.random() * proxies.length)];
    
    acc.proxy = newProxy;
    saveAccount(acc);
    log(`${username}: Auto-rotated proxy to ${newProxy} (Pool Size: ${proxies.length})`, "BOT", username);
}

function startBotProcess(account) {
    const { username, password, sharedSecret, proxy } = account;
    if (activeBots[username] && activeBots[username].client) return;

    // Honour the account's daily window. A manual start outside it would just be
    // undone by the scheduler a minute later.
    if (!isWithinSchedule(account)) {
        if (!activeBots[username]) activeBots[username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null, restartCount: 0, timers: new Set(), epoch: 0 };
        activeBots[username].status = 'Off schedule';
        activeBots[username].lastError = `Outside its scheduled window (${account.scheduleStart}-${account.scheduleEnd}).`;
        log(`${username}: not starting, outside scheduled window.`, "SCHEDULE", username);
        return;
    }

    if (!activeBots[username]) activeBots[username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null, restartCount: 0, timers: new Set(), epoch: 0 };
    activeBots[username].lastError = null;
    // Invalidate any restart still queued against the previous client.
    activeBots[username].epoch = (activeBots[username].epoch || 0) + 1;

    // enablePicsCache is deliberately off: see refreshOwnedApps above. Ownership is
    // tracked from getUserOwnedApps instead.
    const clientOptions = {};
    if (proxy && proxy.trim().length > 0) clientOptions.httpProxy = proxy;

    const client = new SteamUser(clientOptions);
    activeBots[username].client = client;
    activeBots[username].status = 'Logging in...';
    activeBots[username].loginStartTime = Date.now();
    log(`Starting ${username}...`, "BOT", username);

    // Steam hands out a refresh token on first login. Reusing it avoids sending the
    // password again, which is what trips rate limits (eresult 84/88) and fires Steam
    // Guard emails on every restart, crash or proxy rotation.
    const stored = getAccount(username);
    const refreshToken = stored && stored.refreshToken;

    let opts;
    if (refreshToken) {
        opts = { refreshToken };
        activeBots[username].usingRefreshToken = true;
    } else {
        opts = { accountName: username, password: password };
        activeBots[username].usingRefreshToken = false;
        if (sharedSecret) {
            try {
                opts.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
            } catch (e) {
                const errMsg = `Secret Error: ${e.message}`;
                log(`${username}: ${errMsg}`, "ERROR", username);
                activeBots[username].status = 'Error';
                activeBots[username].lastError = errMsg;
                return;
            }
        }
    }

    // Persist the token Steam issues so the next login can skip the password.
    client.on('refreshToken', (token) => {
        if (!token) return;
        const acc = getAccount(username);
        if (!acc) return;
        acc.refreshToken = token;
        saveAccount(acc);
        log(`${username}: stored refresh token (future logins skip the password).`, "AUTH", username);
    });

    try {
        client.logOn(opts);
    } catch (e) {
        // A malformed or wrong-account token throws synchronously; drop it and retry
        // with the password rather than wedging the bot.
        if (refreshToken) {
            log(`${username}: refresh token rejected (${e.message}); falling back to password.`, "WARN", username);
            clearRefreshToken(username);
            destroyClient(activeBots[username]);
            return botTimeout(activeBots[username], () => {
                const acc = getAccount(username);
                if (acc) startBotProcess(acc);
            }, 1000);
        }
        log(`${username}: logOn failed: ${e.message}`, "ERROR", username);
        activeBots[username].status = 'Error';
        activeBots[username].lastError = e.message;
        return;
    }

    client.on('loggedOn', () => {
        const state = account.personaState !== undefined ? account.personaState : SteamUser.EPersonaState.Online;
        client.setPersona(state);
        
        if (activeBots[username].crashTimeout) clearTimeout(activeBots[username].crashTimeout);
        activeBots[username].crashTimeout = setTimeout(() => {
            if (activeBots[username]) activeBots[username].restartCount = 0;
        }, 120000);
        
        if (pendingFreeGames[username] && pendingFreeGames[username].autoStop) {
            log(`${username} login for Free Games task (No Farming).`, "BOT", username);
        } else {
            // Instantly start playing games + show custom status on Steam
            updateBotGames(username);

            let initDone = false;
            const initGames = () => {
                if (initDone) return; // the fallback timer and the event can both land
                initDone = true;
                checkAndEnsureGames(username, client).then((changed) => {
                    if (changed) updateBotGames(username); // Re-initialize games/rotation if games were removed or added
                });
            };

            // Load ownership first (cheap), then reconcile the game list against it.
            refreshOwnedApps(username, client).then(initGames);
        }

        activeBots[username].status = 'Running';
        activeBots[username].lastError = null;
        const proxyMsg = (proxy && proxy.trim().length > 0) ? ` (Proxy: ${proxy})` : '';
        log(`${username} successfully logged in${proxyMsg}.`, "SUCCESS", username);
        
        updateHours(username, client);

        if (pendingFreeGames[username]) {
            const task = pendingFreeGames[username];
            delete pendingFreeGames[username];
            log(`${username} processing queued free games...`, "BOT", username);
            requestFreeGames(username, task.games, task.autoStop);
        }

        if (client.steamID) { account.steamId = client.steamID.getSteamID64(); saveAccount(account); }
        
        const currentSteamID = client.steamID;
        client.getPersonas([currentSteamID], () => {
            botTimeout(activeBots[username], () => {
                if (activeBots[username] && activeBots[username].client === client) { 
                    const u = client.users[currentSteamID.getSteamID64()]; 
                    if (u) { if(u.player_name) account.nickname = u.player_name; if(u.avatar_hash) account.avatarHash = u.avatar_hash.toString('hex'); saveAccount(account); } 
                } 
            }, 1000); 
        });
    });

    client.on('steamGuard', (domain, cb) => {
        const isEmail = !!domain;
        const statusLabel = isEmail ? `Email Guard (${domain})` : 'Need Guard';
        const logMsg = isEmail ? `needs email Guard Code (${domain})` : 'needs Mobile Authenticator code';
        const webhookMsg = isEmail
            ? `Account **${username}** needs a Steam Guard code sent to **${domain}**.`
            : `Account **${username}** needs a Mobile Authenticator code to login.`;
        log(`${username} ${logMsg}`, "AUTH", username);
        activeBots[username].status = statusLabel;
        activeBots[username].guardCallback = cb;
        sendDiscordWebhook("Steam Guard Required", webhookMsg, 16776960);
    });

    client.on('error', (e) => {
        const errorDetails = e.eresult ? `(Steam Code: ${e.eresult})` : '';
        const fullMsg = `${e.message} ${errorDetails}`.trim();
        log(`${username} Error: ${fullMsg}`, "ERROR", username);

        // eresult 5 with a refresh token means the token expired or was revoked (a
        // password change does this), not that the password is wrong. Drop it and
        // retry with credentials before condemning the account.
        if (e.eresult === 5 && activeBots[username] && activeBots[username].usingRefreshToken) {
            log(`${username}: refresh token expired. Retrying with password.`, "WARN", username);
            clearRefreshToken(username);
            const epoch = currentEpoch(username);
            destroyClient(activeBots[username]);
            activeBots[username].status = 'Reconnecting...';
            botTimeout(activeBots[username], () => {
                if (currentEpoch(username) !== epoch) return;
                const acc = getAccount(username);
                if (acc) startBotProcess(acc);
            }, 2000);
            return;
        }

        if (e.eresult === 5) { // InvalidPassword
            log(`${username}: Invalid password. Disabling auto-start.`, "ERROR", username);
            sendDiscordWebhook("Invalid Password", `Account **${username}** has an invalid password. Auto-start disabled.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Wrong Password';
                activeBots[username].lastError = 'Invalid password. Please update it in the dashboard.';
            }
            const acc = getAccount(username);
            if (acc) { acc.autoStart = false; saveAccount(acc); }
            return;
        }

        if (e.eresult === 6) { // LoggedInElsewhere
            log(`${username}: Logged in elsewhere. Retrying in 30s...`, "WARN", username);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Logged In Elsewhere';
                activeBots[username].lastError = 'Account is logged in somewhere else. Retrying in 30s.';
            }
            const elsewhereEpoch = currentEpoch(username);
            botTimeout(activeBots[username], () => {
                if (activeBots[username] && activeBots[username].status === 'Logged In Elsewhere' && currentEpoch(username) === elsewhereEpoch) {
                    const acc = getAccount(username);
                    if (acc) startBotProcess(acc);
                }
            }, 30000);
            return;
        }

        if (e.eresult === 43) { // VACCheckTimedOut
            log(`${username} Error 43 (VACCheckTimedOut). Disabling account to prevent loop.`, "ERROR", username);
            sendDiscordWebhook("Account Disabled", `Account **${username}** encountered Error 43 and has been disabled.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Disabled (Error 43)';
                activeBots[username].lastError = 'Steam Error 43: Account disabled.';
            }
            const acc = getAccount(username);
            if (acc) { acc.autoStart = false; saveAccount(acc); }
            return;
        }

        if (e.eresult === 63) { // AccountLogonDenied (email guard needed)
            log(`${username}: Steam Guard email required. Waiting for manual input.`, "AUTH", username);
            if (activeBots[username]) {
                activeBots[username].status = 'Need Guard (Email)';
                activeBots[username].lastError = 'Steam Guard email code required. Enter it via the dashboard.';
            }
            sendDiscordWebhook("Steam Guard Required", `Account **${username}** needs an email Steam Guard code.`, 16776960);
            return;
        }

        if (e.eresult === 87) { // InvalidLoginAuthCode
            log(`${username}: Steam Guard code was invalid or expired. Stopping.`, "ERROR", username);
            sendDiscordWebhook("Invalid Guard Code", `Account **${username}** rejected the Steam Guard code.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Bad Guard Code';
                activeBots[username].lastError = 'The Steam Guard code was invalid or expired. Enter a fresh one.';
            }
            return;
        }

        if (e.eresult === 65) { // TwoFactorCodeMismatch
            log(`${username}: Shared secret is invalid (2FA mismatch). Stopping.`, "ERROR", username);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Wrong 2FA Secret';
                activeBots[username].lastError = 'Shared secret is wrong or expired. Please update it.';
            }
            return;
        }

        if (e.eresult === 84 || e.eresult === 88) { // RateLimitExceeded / LimitExceeded
            rotateProxy(username); // try a new IP before the cooldown
            sendDiscordWebhook("Rate Limit Hit", `Account **${username}** has been rate limited by Steam. Cooldown active for 5 minutes.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Rate Limit (5m)';
                activeBots[username].lastError = 'Steam Rate Limit (IP/Account). Cooldown active.';
            }
            const rateEpoch = currentEpoch(username);
            botTimeout(activeBots[username], () => {
                if (activeBots[username] && activeBots[username].status === 'Rate Limit (5m)' && currentEpoch(username) === rateEpoch) {
                    const acc = getAccount(username);
                    if (acc) startBotProcess(acc);
                }
            }, 5 * 60 * 1000);
            return;
        }

        handleCrash(username, fullMsg);
    });

    client.on('disconnected', (eresult, msg) => {
        handleCrash(username, `Disconnected: ${msg} (${eresult})`);
    });

    // A VAC or game ban on a boosting farm is worth knowing about immediately.
    client.on('vacBans', (numBans, appids) => {
        if (!numBans) return;
        const acc = getAccount(username);
        if (acc) {
            acc.vacBanned = true;
            acc.vacBanApps = appids || [];
            saveAccount(acc);
        }
        const names = (appids || []).map(id => getGameName(id)).join(', ') || 'unknown games';
        log(`${username} has ${numBans} VAC ban(s): ${names}`, "ERROR", username);
        if (activeBots[username]) activeBots[username].lastError = `VAC banned (${names})`;
        sendDiscordWebhook("VAC Ban Detected", `Account **${username}** has ${numBans} VAC ban(s) on: ${names}`, 15158332);
    });

    // A limited account can't do much and will never behave normally; surface it
    // rather than letting the user wonder why nothing works.
    client.on('accountLimitations', (limited, communityBanned, locked, canInviteFriends) => {
        const acc = getAccount(username);
        if (acc) {
            acc.limited = !!limited;
            acc.communityBanned = !!communityBanned;
            acc.locked = !!locked;
            saveAccount(acc);
        }
        if (locked) {
            log(`${username} account is LOCKED by Steam. Stopping.`, "ERROR", username);
            sendDiscordWebhook("Account Locked", `Account **${username}** is locked by Steam.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Locked';
                activeBots[username].lastError = 'Steam has locked this account.';
            }
        } else if (limited) {
            log(`${username} is a limited account.`, "WARN", username);
        }
    });

    // Steam fires this when another session (you, on your own PC) takes over the
    // account. Without handling it the bot happily reports "Running" while earning
    // nothing at all.
    client.on('playingState', (blocked, playingApp) => {
        const bot = activeBots[username];
        if (!bot || bot.client !== client) return;
        bot.playBlocked = !!blocked;
        bot.blockingApp = blocked ? playingApp : null;

        if (blocked) {
            const acc = getAccount(username);
            const gameName = playingApp ? getGameName(playingApp) : 'another game';
            bot.lastError = `Another session is playing ${gameName}; hours are not accruing.`;
            if (bot.status === 'Running') bot.status = 'Blocked (playing elsewhere)';
            log(`${username} blocked: another session is playing ${gameName}.`, "WARN", username);

            if (acc && acc.autoReclaim) {
                log(`${username}: auto-reclaim enabled, kicking the other session.`, "BOT", username);
                // gamesPlayed(payload, true) kicks the blocking session, then resumes.
                try { updateBotGames(username, true); } catch (e) {}
            } else {
                sendDiscordWebhook("Boosting Blocked", `Account **${username}** stopped boosting: another session is playing ${gameName}.`, 16776960);
            }
        } else if (bot.status === 'Blocked (playing elsewhere)') {
            bot.status = 'Running';
            bot.lastError = null;
            log(`${username} regained its playing session; resuming.`, "SUCCESS", username);
            try { updateBotGames(username); } catch (e) {}
        }
    });

    client.on('friendRelationship', (sid, relationship) => {
        if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
            const acc = getAccount(username);
            if (acc && acc.autoAccept) {
                client.addFriend(sid);
                log(`${username} auto-accepted friend request from ${sid.getSteamID64()}`, "FRIENDS", username);
            }
        }
    });
}

// force=true passes Steam's kick flag, reclaiming the playing session from another
// device. Only used when the account opts in via autoReclaim.
function updateBotGames(username, force = false) {
    const bot = activeBots[username];
    const acc = getAccount(username);
    if (!bot || !bot.client || !acc) return; // acc is gone if the account was deleted mid-run

    let gamesToFarm = acc.games || [];
    // Only filter once ownership is known; before that, play what the user configured.
    if (bot.ownershipReady) gamesToFarm = gamesToFarm.filter(id => botOwnsApp(bot, id) !== false);

    // Clear existing rotation if any
    if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
    bot.nextRotation = null;

    if (gamesToFarm.length > 32) {
        bot.rotateIndex = 0;
        let scheduledMinutes = getSettings().rotationInterval || 60;

        const rotate = () => {
            if (!bot.client) return;
            const current = getAccount(username) || acc; // re-read: games/status may have changed
            const allGames = gamesToFarm;
            let idx = bot.rotateIndex || 0;
            if (idx >= allGames.length) idx = 0;

            const gamesToPlay = allGames.slice(idx, idx + 32);
            bot.rotateIndex = (idx + 32) >= allGames.length ? 0 : idx + 32;

            const currentBatch = Math.floor(idx / 32) + 1;
            const totalBatches = Math.ceil(allGames.length / 32);

            const intervalMinutes = getSettings().rotationInterval || 60;
            const intervalMs = intervalMinutes * 60 * 1000;

            log(`${username} rotating games. Playing batch ${currentBatch}/${totalBatches} (Total: ${allGames.length} games).`, "BOT", username);
            bot.client.gamesPlayed(getGamePayload(gamesToPlay, current.customStatus), force);
            bot.nextRotation = Date.now() + intervalMs;

            // The interval period is fixed at creation, so pick up a changed
            // rotationInterval setting by rescheduling.
            if (intervalMinutes !== scheduledMinutes) {
                scheduledMinutes = intervalMinutes;
                clearInterval(bot.rotationInterval);
                bot.rotationInterval = setInterval(rotate, intervalMs);
            }
        };
        rotate(); // Play first set immediately
        bot.rotationInterval = setInterval(rotate, scheduledMinutes * 60 * 1000);
    } else {
        bot.client.gamesPlayed(getGamePayload(gamesToFarm, acc.customStatus), force);
    }
    
    if (acc.personaState !== undefined) bot.client.setPersona(acc.personaState);
}

function stopBot(u) {
    const b = activeBots[u];
    if (!b) return;
    const had = !!b.client;
    // Bump the epoch so any restart already queued for this bot is discarded.
    b.epoch = (b.epoch || 0) + 1;
    destroyClient(b);
    if (had) log(`${u} stopped.`, "BOT", u);
    b.status = 'Stopped';
    b.guardCallback = null;
    b.lastError = null;
}

function getActiveBots() { return activeBots; }

// Stats Loop
// boostedHours is accumulated in the in-memory account cache every minute but only
// flushed to disk every STATS_FLUSH_MINUTES. Writing all 245 accounts every minute
// meant up to 245 synchronous writeFileSync calls per minute on the event loop.
const STATS_FLUSH_MINUTES = 5;
// How often to re-read real playtime from Steam for running bots.
const HOURS_REFRESH_MINUTES = 30;
let statsTicks = 0;

setInterval(() => {
    const accounts = getAllAccounts();
    const currentUsers = new Set(accounts.map(a => a.username));

    Object.keys(activeBots).forEach(u => {
        if (!currentUsers.has(u)) {
            stopBot(u);
            delete activeBots[u];
            log(`Stopped ${u} (File removed)`, "SYSTEM", u);
        }
    });

    Object.keys(pendingFreeGames).forEach(u => {
        if (!currentUsers.has(u)) delete pendingFreeGames[u];
    });

    enforceSchedules();

    statsTicks++;
    const flush = statsTicks % STATS_FLUSH_MINUTES === 0;
    if (flush) {
        accounts.forEach(acc => {
            if (acc._dirty) { delete acc._dirty; saveAccount(acc); }
        });
    }

    // Refresh playtime from Steam periodically so boostedHours tracks reality.
    if (statsTicks % HOURS_REFRESH_MINUTES === 0) {
        accounts.forEach(acc => {
            const bot = activeBots[acc.username];
            if (bot && bot.status === 'Running' && bot.client) updateHours(acc.username, bot.client);
        });
    }
}, 60000);

// Persist anything the stats loop has accumulated but not yet written.
// Called on shutdown so a restart doesn't lose up to STATS_FLUSH_MINUTES of hours.
function flushDirtyAccounts() {
    let n = 0;
    getAllAccounts().forEach(acc => {
        if (acc._dirty) { delete acc._dirty; saveAccount(acc); n++; }
    });
    return n;
}

// Watchdog & Refresh Loop (Every 1 Hour)
setInterval(() => {
    const accounts = getAllAccounts();
    accounts.forEach(acc => {
        const bot = activeBots[acc.username];
        if (bot) {
            const offline = bot.status === 'Running' && (!bot.client || !bot.client.steamID);
            const stuck = bot.status === 'Logging in...' && bot.loginStartTime && (Date.now() - bot.loginStartTime > 300000);
            if (offline || stuck) {
                 if (offline) {
                     log(`${acc.username} watchdog: Bot offline. Restarting...`, "WATCHDOG", acc.username);
                     sendDiscordWebhook("Watchdog Restart", `Bot **${acc.username}** detected offline. Restarting...`, 15105570);
                 } else {
                     log(`${acc.username} watchdog: Stuck at Logging in (Dead Proxy?). Restarting...`, "WATCHDOG", acc.username);
                 }
                 bot.status = 'Restarting...';
                 const epoch = currentEpoch(acc.username);
                 destroyClient(bot);
                 botTimeout(bot, () => {
                     if (currentEpoch(acc.username) !== epoch) return;
                     startBotProcess(acc);
                 }, 5000);
            }
        }
    });
}, 3600000);

function requestFreeGames(username, gameIds, autoStop = false, retryCount = 0) {
    return new Promise((resolve) => {
        const bot = activeBots[username];
        if (!bot || !bot.client || bot.status !== 'Running') {
            log(`${username} cannot add free games: Bot not running.`, "WARN", username);
            return resolve({ result: 'error', msg: 'Bot not running' });
        }
        const currentClient = bot.client;
        
        bot.client.requestFreeLicense(gameIds, (err, grantedPackages, grantedAppIDs) => {
            if (err) {
                log(`${username} failed to add free games: ${err.message}`, "ERROR", username);
                if (autoStop && retryCount === 0) {
                    log(`${username} stopping after failed free games task.`, "BOT", username);
                    botTimeout(bot, () => stopBot(username), 5000);
                }
                resolve({ result: 'error', msg: err.message });
            } else {
                // Verify ownership after a short delay
                botTimeout(bot, () => {
                    if (!activeBots[username] || activeBots[username].client !== currentClient) return resolve({ result: 'error', msg: 'Bot disconnected' });
                    
                    // Re-read ownership so licences granted a moment ago are visible.
                    refreshOwnedApps(username, currentClient).then((apps) => {
                    if (!activeBots[username] || activeBots[username].client !== currentClient) return resolve({ result: 'error', msg: 'Bot disconnected' });
                    if (!apps) {
                        log(`${username} could not verify ownership (owned-apps fetch failed).`, "WARN", username);
                        return resolve({ result: 'owned' }); // Skip verification to avoid a loop
                    }
                    const missing = gameIds.filter(id => botOwnsApp(activeBots[username], id) === false);
                    const verifiedCount = gameIds.length - missing.length;

                    updateHours(username, currentClient);
                        
                        if (missing.length > 0) {
                            if (retryCount < 2) {
                                log(`${username} verified ${verifiedCount}/${gameIds.length}. Retrying ${missing.length} missing games (Attempt ${retryCount + 2}/3)...`, "BOT", username);
                                return requestFreeGames(username, missing, false, retryCount + 1).then(r => {
                                    const extra = (r.result === 'success' ? r.count : 0);
                                    const total = verifiedCount + extra;
                                    
                                    if (autoStop && retryCount === 0) {
                                        log(`${username} stopping after free games task (Auto-Stop).`, "BOT", username);
                                        botTimeout(bot, () => stopBot(username), 5000);
                                    }
                                    resolve({ result: total > 0 ? 'success' : 'owned', count: total });
                                });
                            } else {
                                const missingNames = missing.map(id => getGameName(id)).join(', ');
                                log(`${username} failed to add ${missing.length} games after 3 tries: ${missingNames}. Possible Region Lock.`, "WARN", username);
                                
                                const acc = getAccount(username);
                                if (acc && acc.games) {
                                    acc.games = acc.games.filter(id => !missing.includes(id));
                                    saveAccount(acc);
                                    log(`${username}: Removed ${missing.length} unaddable games from account list.`, "BOT", username);
                                }
                            }
                        }
                        
                        if (verifiedCount > 0) {
                            log(`${username} verified ownership of ${verifiedCount}/${gameIds.length} requested games.`, "SUCCESS", username);
                            if (autoStop && retryCount === 0) {
                                log(`${username} stopping after free games task (Auto-Stop).`, "BOT", username);
                                botTimeout(bot, () => stopBot(username), 5000);
                            }
                            resolve({ result: 'success', count: verifiedCount });
                        } else {
                            log(`${username} requested games, but none were found in library (Already owned?).`, "INFO", username);
                            if (autoStop && retryCount === 0) {
                                log(`${username} stopping after free games task.`, "BOT", username);
                                botTimeout(bot, () => stopBot(username), 5000);
                            }
                            resolve({ result: 'owned' });
                        }
                    });
                }, 2000);
            }
        });
    });
}

function queueFreeGames(username, games, autoStop = false) {
    pendingFreeGames[username] = { games, autoStop };
}

module.exports = { isWithinSchedule, recordDailyHours, startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, getGamePayload, updateBotGames, requestFreeGames, queueFreeGames, flushDirtyAccounts };