const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');
const { log } = require('./utils');
const { getAllAccounts, getAccount, saveAccount, getSettings, getGlobalProxies } = require('./data');

const activeBots = {}; 
const pendingFreeGames = {};
let allSteamApps = [];
let steamAppsMap = {};
const TOP_GAMES_FALLBACK = { 730: "Counter-Strike 2", 440: "Team Fortress 2", 570: "Dota 2", 252490: "Rust", 271590: "GTA V" };

function updateAppList() {
    https.get('https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json', (res) => {
        if (res.statusCode !== 200) return;
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { 
            try { 
                allSteamApps = JSON.parse(data); 
                steamAppsMap = {};
                allSteamApps.forEach(a => steamAppsMap[a.appid] = a);
                log(`Loaded ${allSteamApps.length} games.`, "SUCCESS"); 
            } catch(e){} 
        });
    }).on('error', () => {});
}
updateAppList(); setInterval(updateAppList, 86400000); 

function getGameName(id) { const f = steamAppsMap[id]; return f ? f.name : (TOP_GAMES_FALLBACK[id] || "Unknown Game"); }

function searchGames(q) {
    return allSteamApps.filter(a => a.name && a.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, 20);
}

function getGamePayload(games, customStatus) {
    const payload = [];
    if (customStatus && typeof customStatus === 'string' && customStatus.trim().length > 0) payload.push(customStatus);
    if (Array.isArray(games)) payload.push(...games);
    return payload;
}

function updateHours(username, client) {
    const delay = Math.floor(Math.random() * 45000) + 15000;
    setTimeout(() => { if (!activeBots[username] || activeBots[username].client !== client) return; client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeInfo: true }, (err, res) => { if (res && res.apps) { let m = 0; const owned = res.apps.map(a => ({ id: a.appid, name: a.name })); res.apps.forEach(a => m += a.playtime_forever); const acc = getAccount(username); if (acc) { acc.grandTotal = (m / 60).toFixed(1); acc.ownedGames = owned; saveAccount(acc); } } }); }, delay);
}

function checkAndEnsureGames(username, client, retryCount = 0) {
    return new Promise((resolve) => {
        setTimeout(() => {
            if (!activeBots[username] || activeBots[username].client !== client) return resolve(false);
            const acc = getAccount(username);
            if (!acc || !acc.games || acc.games.length === 0) return resolve(false);

            let missing = [];
            try {
                missing = acc.games.filter(id => !client.ownsApp(id));
            } catch (e) {
                if (retryCount < 6) {
                    log(`${username} PICS cache not ready, retrying in 5s... (${retryCount + 1}/6)`, "BOT", username);
                    return setTimeout(() => checkAndEnsureGames(username, client, retryCount + 1).then(resolve), 5000);
                }
                log(`${username} PICS cache not ready, skipping game check.`, "WARN", username);
                return resolve(false);
            }

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
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } });
    req.on('error', () => {});
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
        const wait = 5000 * bot.restartCount;
        log(`${username} crashed: ${msg}. Restarting (${bot.restartCount}/3) in ${wait/1000}s...`, "WARN", username);
        
        if (bot.restartCount >= 2) {
            rotateProxy(username);
        }

        bot.status = `Restarting (${bot.restartCount}/3)...`;
        
        if (bot.client) {
            bot.client.removeAllListeners();
            try { bot.client.logOff(); } catch(e){}
            bot.client = null;
        }
        if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
        if (bot.crashTimeout) { clearTimeout(bot.crashTimeout); bot.crashTimeout = null; }

        setTimeout(() => {
            const acc = getAccount(username);
            if (acc && activeBots[username] && activeBots[username].status !== 'Stopped') {
                startBotProcess(acc);
            }
        }, wait);
    } else {
        log(`${username} crashed 3 times in a row. Stopping. Last Error: ${msg}`, "ERROR", username);
        bot.status = 'Crashed';
        bot.lastError = `Too many restarts. Last error: ${msg}`;
        sendDiscordWebhook("Bot Crashed", `Account **${username}** failed to restart 3 times. Last error: ${msg}`, 15158332);
        
        if (bot.client) {
            bot.client.removeAllListeners();
            try { bot.client.logOff(); } catch(e){}
            bot.client = null;
        }
        if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
        if (bot.crashTimeout) { clearTimeout(bot.crashTimeout); bot.crashTimeout = null; }
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

    if (!activeBots[username]) activeBots[username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null, restartCount: 0 };
    activeBots[username].lastError = null;

    const clientOptions = { enablePicsCache: true };
    if (proxy && proxy.trim().length > 0) clientOptions.httpProxy = proxy;

    const client = new SteamUser(clientOptions);
    activeBots[username].client = client;
    activeBots[username].status = 'Logging in...';
    activeBots[username].loginStartTime = Date.now();
    log(`Starting ${username}...`, "BOT", username);

    const opts = { accountName: username, password: password };
    
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

    client.logOn(opts);

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

            const initGames = () => {
                checkAndEnsureGames(username, client).then((changed) => {
                    if (changed) updateBotGames(username); // Re-initialize games/rotation if games were removed or added
                });
            };

            if (client.picsCache && client.picsCache.apps && Object.keys(client.picsCache.apps).length > 0) {
                initGames();
            } else {
                client.once('appOwnershipCached', initGames);
                setTimeout(() => { 
                    if (activeBots[username] && activeBots[username].client === client) {
                        if (client.listenerCount('appOwnershipCached') > 0) { 
                            client.removeListener('appOwnershipCached', initGames); 
                            initGames(); 
                        } 
                    }
                }, 60000);
            }
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
            setTimeout(() => { 
                if (activeBots[username] && activeBots[username].client === client) { 
                    const u = client.users[currentSteamID.getSteamID64()]; 
                    if (u) { if(u.player_name) account.nickname = u.player_name; if(u.avatar_hash) account.avatarHash = u.avatar_hash.toString('hex'); saveAccount(account); } 
                } 
            }, 1000); 
        });
    });

    client.on('steamGuard', (d, cb) => { 
        log(`${username} needs Guard Code`, "AUTH", username);
        activeBots[username].status = 'Need Guard'; 
        activeBots[username].guardCallback = cb; 
        sendDiscordWebhook("Steam Guard Required", `Account **${username}** needs a Steam Guard code to login.`, 16776960);
    });

    client.on('error', (e) => {
        const errorDetails = e.eresult ? `(Steam Code: ${e.eresult})` : '';
        const fullMsg = `${e.message} ${errorDetails}`;
        log(`${username} Error: ${fullMsg}`, "ERROR", username);

        if (e.eresult === 43) {
            log(`${username} Error 43 (VACCheckTimedOut). Disabling account to prevent loop.`, "ERROR", username);
            sendDiscordWebhook("Account Disabled", `Account **${username}** encountered Error 43 and has been disabled.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Disabled (Error 43)';
                activeBots[username].lastError = 'Steam Error 43: Account disabled.';
            }
            
            const acc = getAccount(username);
            if (acc) {
                acc.autoStart = false;
                saveAccount(acc);
            }
            return;
        }

        if (e.eresult === 84) {
            sendDiscordWebhook("Rate Limit Hit", `Account **${username}** has been rate limited by Steam. Cooldown active for 5 minutes.`, 15158332);
            stopBot(username);
            if (activeBots[username]) {
                activeBots[username].status = 'Rate Limit (5m)';
                activeBots[username].lastError = 'Steam Rate Limit (IP/Account). Cooldown active.';
            }
            setTimeout(() => {
                if (activeBots[username] && activeBots[username].status === 'Rate Limit (5m)') {
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

function updateBotGames(username) {
    const bot = activeBots[username];
    const acc = getAccount(username);
    if (!bot || !bot.client) return;

    let gamesToFarm = acc.games || [];
    try {
        if (bot.client.picsCache && bot.client.picsCache.apps && Object.keys(bot.client.picsCache.apps).length > 0) {
            gamesToFarm = gamesToFarm.filter(id => bot.client.ownsApp(id));
        }
    } catch(e) {}

    // Clear existing rotation if any
    if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
    bot.nextRotation = null;

    if (gamesToFarm.length > 32) {
        bot.rotateIndex = 0;
        const rotate = () => {
            if (!bot.client) return;
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
            bot.client.gamesPlayed(getGamePayload(gamesToPlay, acc.customStatus));
            bot.nextRotation = Date.now() + intervalMs;
        };
        rotate(); // Play first set immediately
        const intervalMinutes = getSettings().rotationInterval || 60;
        bot.rotationInterval = setInterval(rotate, intervalMinutes * 60 * 1000);
    } else {
        bot.client.gamesPlayed(getGamePayload(gamesToFarm, acc.customStatus));
    }
    
    if (acc.personaState !== undefined) bot.client.setPersona(acc.personaState);
}

function stopBot(u) { const b = activeBots[u]; if (b) { if (b.rotationInterval) { clearInterval(b.rotationInterval); b.rotationInterval = null; } if (b.crashTimeout) { clearTimeout(b.crashTimeout); b.crashTimeout = null; } b.nextRotation = null; if (b.client) { b.client.removeAllListeners(); try { b.client.logOff(); } catch(e){} b.client = null; log(`${u} stopped.`, "BOT", u); } b.status = 'Stopped'; b.guardCallback = null; b.lastError = null; } }

function getActiveBots() { return activeBots; }

// Stats Loop
setInterval(() => {
    const accounts = getAllAccounts();
    const currentUsers = accounts.map(a => a.username);

    Object.keys(activeBots).forEach(u => {
        if (!currentUsers.includes(u)) {
            stopBot(u);
            delete activeBots[u];
            log(`Stopped ${u} (File removed)`, "SYSTEM", u);
        }
    });
    
    Object.keys(pendingFreeGames).forEach(u => {
        if (!currentUsers.includes(u)) delete pendingFreeGames[u];
    });

    accounts.forEach(acc => {
        const bot = activeBots[acc.username];
        if (bot && bot.status === 'Running' && (acc.games||[]).length > 0) {
            acc.boostedHours = (acc.boostedHours || 0) + ((1/60) * acc.games.length);
            saveAccount(acc);
        }
    });
}, 60000);

// Watchdog & Refresh Loop (Every 1 Hour)
setInterval(() => {
    const accounts = getAllAccounts();
    accounts.forEach(acc => {
        const bot = activeBots[acc.username];
        if (bot) {
            if (bot.status === 'Running' && (!bot.client || !bot.client.steamID)) {
                 log(`${acc.username} watchdog: Bot offline. Restarting...`, "WATCHDOG", acc.username);
                 bot.status = 'Restarting...';
                 if(bot.client) { bot.client.removeAllListeners(); try { bot.client.logOff(); } catch(e){} bot.client = null; }
                 sendDiscordWebhook("Watchdog Restart", `Bot **${acc.username}** detected offline. Restarting...`, 15105570);
                 setTimeout(() => startBotProcess(acc), 5000);
            } else if (bot.status === 'Logging in...' && bot.loginStartTime && (Date.now() - bot.loginStartTime > 300000)) {
                 log(`${acc.username} watchdog: Stuck at Logging in (Dead Proxy?). Restarting...`, "WATCHDOG", acc.username);
                 bot.status = 'Restarting...';
                 if(bot.client) { bot.client.removeAllListeners(); try { bot.client.logOff(); } catch(e){} bot.client = null; }
                 setTimeout(() => startBotProcess(acc), 5000);
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
                    setTimeout(() => stopBot(username), 5000);
                }
                resolve({ result: 'error', msg: err.message });
            } else {
                // Verify ownership after a short delay
                setTimeout(() => {
                    if (!activeBots[username] || activeBots[username].client !== currentClient) return resolve({ result: 'error', msg: 'Bot disconnected' });
                    
                    let missing = [];
                    try {
                        missing = gameIds.filter(id => !bot.client.ownsApp(id));
                    } catch (e) {
                        log(`${username} PICS cache error during verification: ${e.message}`, "WARN", username);
                        return resolve({ result: 'owned' }); // Skip verification to avoid loop/crash
                    }
                    const verifiedCount = gameIds.length - missing.length;
                    
                    updateHours(username, bot.client);
                        
                        if (missing.length > 0) {
                            if (retryCount < 2) {
                                log(`${username} verified ${verifiedCount}/${gameIds.length}. Retrying ${missing.length} missing games (Attempt ${retryCount + 2}/3)...`, "BOT", username);
                                return requestFreeGames(username, missing, false, retryCount + 1).then(r => {
                                    const extra = (r.result === 'success' ? r.count : 0);
                                    const total = verifiedCount + extra;
                                    
                                    if (autoStop && retryCount === 0) {
                                        log(`${username} stopping after free games task (Auto-Stop).`, "BOT", username);
                                        setTimeout(() => stopBot(username), 5000);
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
                                setTimeout(() => stopBot(username), 5000);
                            }
                            resolve({ result: 'success', count: verifiedCount });
                        } else {
                            log(`${username} requested games, but none were found in library (Already owned?).`, "INFO", username);
                            if (autoStop && retryCount === 0) {
                                log(`${username} stopping after free games task.`, "BOT", username);
                                setTimeout(() => stopBot(username), 5000);
                            }
                            resolve({ result: 'owned' });
                        }
                }, 2000);
            }
        });
    });
}

function queueFreeGames(username, games, autoStop = false) {
    pendingFreeGames[username] = { games, autoStop };
}

module.exports = { startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, getGamePayload, updateBotGames, requestFreeGames, queueFreeGames };