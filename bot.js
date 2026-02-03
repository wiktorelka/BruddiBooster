const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const https = require('https');
const { log } = require('./utils');
const { getAllAccounts, getAccount, saveAccount, getSettings, getGlobalProxies } = require('./data');

const activeBots = {}; 
const pendingFreeGames = {};
let allSteamApps = [];
const TOP_GAMES_FALLBACK = { 730: "Counter-Strike 2", 440: "Team Fortress 2", 570: "Dota 2", 252490: "Rust", 271590: "GTA V" };

function updateAppList() {
    https.get('https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json', (res) => {
        if (res.statusCode !== 200) return;
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { allSteamApps = JSON.parse(data); log(`Loaded ${allSteamApps.length} games.`, "SUCCESS"); } catch(e){} });
    }).on('error', () => {});
}
updateAppList(); setInterval(updateAppList, 86400000); 

function getGameName(id) { const f = allSteamApps.find(a => a.appid == id); return f ? f.name : (TOP_GAMES_FALLBACK[id] || "Unknown Game"); }

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
    setTimeout(() => { if (!activeBots[username] || !activeBots[username].client) return; client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeInfo: true }, (err, res) => { if (res && res.apps) { let m = 0; const owned = res.apps.map(a => ({ id: a.appid, name: a.name })); res.apps.forEach(a => m += a.playtime_forever); const acc = getAccount(username); if (acc) { acc.grandTotal = (m / 60).toFixed(1); acc.ownedGames = owned; saveAccount(acc); } } }); }, delay);
}

function checkAndEnsureGames(username, client, retryCount = 0) {
    return new Promise((resolve) => {
        setTimeout(() => {
            const acc = getAccount(username);
            if (!acc || !acc.games || acc.games.length === 0) return resolve();

            let missing = [];
            try {
                missing = acc.games.filter(id => !client.ownsApp(id));
            } catch (e) {
                if (retryCount < 6) {
                    log(`${username} PICS cache not ready, retrying in 5s... (${retryCount + 1}/6)`, "BOT", username);
                    return setTimeout(() => checkAndEnsureGames(username, client, retryCount + 1).then(resolve), 5000);
                }
                log(`${username} PICS cache not ready, skipping game check.`, "WARN", username);
                return resolve();
            }

            if (missing.length === 0) return resolve();

            log(`${username} missing ${missing.length} games. Attempting to request free licenses...`, "BOT", username);
            
            client.requestFreeLicense(missing, (err, granted, grantedIds) => {
                const actuallyGranted = grantedIds || [];
                const stillMissing = missing.filter(id => !actuallyGranted.includes(id));
                
                if (stillMissing.length > 0) {
                    const missingNames = stillMissing.map(id => getGameName(id)).join(', ');
                    const msg = `Missing games: ${missingNames} (Possible Region Lock)`;
                    log(`${username}: ${msg}`, "WARN", username);
                    if (activeBots[username]) activeBots[username].lastError = msg;
                    sendDiscordWebhook("Missing Games", `Account **${username}** cannot farm: ${missingNames}`, 16776960);
                }
                
                if (actuallyGranted.length > 0) {
                    log(`${username} added ${actuallyGranted.length} free games.`, "SUCCESS", username);
                    updateHours(username, client);
                }
                resolve();
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
        if (bot.rotationInterval) clearInterval(bot.rotationInterval);
        if (bot.crashTimeout) clearTimeout(bot.crashTimeout);
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

    client.on('webSession', (sessionID, cookies) => {
        if (activeBots[username]) {
            activeBots[username].community = new SteamCommunity();
            activeBots[username].community.setCookies(cookies);
            fetchProfileDetails(username);
        }
    });

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
            const initGames = () => {
                checkAndEnsureGames(username, client).then(() => {
                    updateBotGames(username); // Initialize games/rotation
                });
            };

            if (client.picsCache && client.picsCache.apps && Object.keys(client.picsCache.apps).length > 0) {
                initGames();
            } else {
                client.once('appOwnershipCached', initGames);
                setTimeout(() => { if (client.listenerCount('appOwnershipCached') > 0) { client.removeListener('appOwnershipCached', initGames); initGames(); } }, 60000);
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
        
        client.getPersonas([client.steamID], () => { setTimeout(() => { if (!client.steamID) return; const u = client.users[client.steamID.getSteamID64()]; if (u) { if(u.player_name) account.nickname = u.player_name; if(u.avatar_hash) account.avatarHash = u.avatar_hash.toString('hex'); saveAccount(account); } }, 1000); });
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
            activeBots[username].status = 'Disabled (Error 43)';
            activeBots[username].lastError = 'Steam Error 43: Account disabled.';
            sendDiscordWebhook("Account Disabled", `Account **${username}** encountered Error 43 and has been disabled.`, 15158332);
            
            if(activeBots[username].client) { try { activeBots[username].client.logOff(); } catch(e){} activeBots[username].client = null; }
            
            const acc = getAccount(username);
            if (acc) {
                acc.autoStart = false;
                saveAccount(acc);
            }
            return;
        }

        if (e.eresult === 84) {
            activeBots[username].status = 'Rate Limit (5m)';
            activeBots[username].lastError = 'Steam Rate Limit (IP/Account). Cooldown active.';
            sendDiscordWebhook("Rate Limit Hit", `Account **${username}** has been rate limited by Steam. Cooldown active for 5 minutes.`, 15158332);
            if(activeBots[username].client) { activeBots[username].client.logOff(); activeBots[username].client = null; }
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
        if (bot.client.picsCache && bot.client.picsCache.apps) {
            const owned = gamesToFarm.filter(id => bot.client.ownsApp(id));
            if (owned.length < gamesToFarm.length) {
                 log(`${username}: Filtering ${gamesToFarm.length - owned.length} unowned games from rotation.`, "BOT", username);
            }
            gamesToFarm = owned;
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

function fetchProfileDetails(username) {
    const bot = activeBots[username];
    if (!bot || !bot.community) return;

    // Fetch Profile Info (Real Name, Custom URL)
    bot.community.httpRequestGet('https://steamcommunity.com/my/edit/info', (err, response, body) => {
        if (err || !body) return;
        const acc = getAccount(username);
        if (!acc) return;

        const realNameMatch = body.match(/name="real_name"[^>]*value="([^"]*)"/);
        if (realNameMatch) acc.realName = realNameMatch[1];
        
        const customUrlMatch = body.match(/name="customURL"[^>]*value="([^"]*)"/);
        if (customUrlMatch) acc.customURL = customUrlMatch[1];

        saveAccount(acc);
    });

    // Fetch Privacy Settings
    bot.community.httpRequestGet('https://steamcommunity.com/my/edit/settings', (err, response, body) => {
        if (err || !body) return;
        const acc = getAccount(username);
        if (!acc) return;
        
        acc.privacy = acc.privacy || {};
        const findPrivacy = (name) => { const m = body.match(new RegExp(`name="${name}"[^>]*value="(\\d+)"[^>]*checked`)); return m ? parseInt(m[1]) : null; };

        const p = findPrivacy('privacySetting\\[privacyProfile\\]'); if(p) acc.privacy.profile = p;
        const i = findPrivacy('privacySetting\\[privacyInventory\\]'); if(i) acc.privacy.inventory = i;
        const g = findPrivacy('privacySetting\\[privacyOwnedGames\\]'); if(g) acc.privacy.ownedGames = g;
        saveAccount(acc);
    });
}

function updateProfile(username, { nickname, avatar, realName, customURL, privacy }) {
    const bot = activeBots[username];
    if (!bot || !bot.client || bot.status !== 'Running') {
        throw new Error("Bot must be running to edit profile");
    }
    
    const community = bot.community;
    const acc = getAccount(username);
    
    if (nickname && nickname !== acc.nickname) {
        bot.client.setPersona(acc.personaState || 1, nickname);
        acc.nickname = nickname;
        saveAccount(acc);
        log(`${username} changed nickname to ${nickname}`, "PROFILE", username);
    }
    
    if (avatar) {
        const matches = avatar.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
            const buffer = Buffer.from(matches[2], 'base64');
            bot.client.uploadAvatar(buffer, (err) => {
                if (err) log(`${username} avatar upload failed: ${err.message}`, "ERROR", username);
                else log(`${username} avatar updated`, "PROFILE", username);
            });
        }
    }

    if (community) {
        if (realName || customURL) {
            const settings = {};
            if (realName !== undefined) { settings.realName = realName; acc.realName = realName; }
            if (customURL !== undefined) { settings.customURL = customURL; acc.customURL = customURL; }
            
            community.editProfile(settings, (err) => { 
                if(err) log(`${username} profile edit failed: ${err.message}`, "ERROR", username); 
                else { log(`${username} profile details updated`, "PROFILE", username); saveAccount(acc); }
            });
        }
        if (privacy && (privacy.profile || privacy.inventory || privacy.ownedGames)) {
            const pSettings = {};
            if (privacy.profile) { pSettings.privacyProfile = parseInt(privacy.profile); acc.privacy = acc.privacy || {}; acc.privacy.profile = pSettings.privacyProfile; }
            if (privacy.inventory) { pSettings.privacyInventory = parseInt(privacy.inventory); acc.privacy = acc.privacy || {}; acc.privacy.inventory = pSettings.privacyInventory; }
            if (privacy.ownedGames) { pSettings.privacyOwnedGames = parseInt(privacy.ownedGames); acc.privacy = acc.privacy || {}; acc.privacy.ownedGames = pSettings.privacyOwnedGames; }
            
            community.profileSettings(pSettings, (err) => { 
                if(err) log(`${username} privacy update failed: ${err.message}`, "ERROR", username); 
                else { log(`${username} privacy settings updated`, "PROFILE", username); saveAccount(acc); }
            });
        }
    }
}

function stopBot(u) { const b = activeBots[u]; if (b) { if (b.rotationInterval) { clearInterval(b.rotationInterval); b.rotationInterval = null; } if (b.crashTimeout) { clearTimeout(b.crashTimeout); b.crashTimeout = null; } b.nextRotation = null; if (b.client) { b.client.logOff(); b.client = null; log(`${u} stopped.`, "BOT", u); } b.status = 'Stopped'; b.guardCallback = null; b.lastError = null; } }

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
        if (bot && bot.status === 'Running') {
            if (!bot.client || !bot.client.steamID) {
                 log(`${acc.username} watchdog: Bot offline. Restarting...`, "WATCHDOG", acc.username);
                 bot.status = 'Restarting...';
                 if(bot.client) { try { bot.client.logOff(); } catch(e){} bot.client = null; }
                 sendDiscordWebhook("Watchdog Restart", `Bot **${acc.username}** detected offline. Restarting...`, 15105570);
                 setTimeout(() => startBotProcess(acc), 5000);
            } else {
                // Refresh game session to ensure online status
                // We don't force gamesPlayed here anymore to avoid resetting rotation timer logic, 
                // but if we wanted to be safe we could check if rotation is active.
                // For now, relying on the rotation interval or the initial set is fine.
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
                    if (!bot.client) return resolve({ result: 'error', msg: 'Bot disconnected during verification' });
                    
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

module.exports = { startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, updateProfile, getGamePayload, updateBotGames, requestFreeGames, queueFreeGames };