const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const https = require('https');
const { log } = require('./utils');
const { getAllAccounts, getAccount, saveAccount, getSettings } = require('./data');

const activeBots = {}; 
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
    setTimeout(() => { if (!activeBots[username] || !activeBots[username].client) return; client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeInfo: true }, (err, res) => { if (res && res.apps) { let m = 0; const owned = res.apps.map(a => ({ id: a.appid, name: a.name })); res.apps.forEach(a => m += a.playtime_forever); const acc = getAccount(username); if (acc) { acc.grandTotal = (m / 60).toFixed(1); acc.ownedGames = owned; saveAccount(acc); } } }); }, 5000);
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

function startBotProcess(account) {
    const { username, password, sharedSecret, proxy } = account;
    if (activeBots[username] && activeBots[username].client) return;

    if (!activeBots[username]) activeBots[username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null };
    activeBots[username].lastError = null;

    const clientOptions = {};
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
        updateBotGames(username); // Initialize games/rotation
        activeBots[username].status = 'Running';
        activeBots[username].lastError = null;
        const proxyMsg = (proxy && proxy.trim().length > 0) ? ` (Proxy: ${proxy})` : '';
        log(`${username} successfully logged in${proxyMsg}.`, "SUCCESS", username);
        
        updateHours(username, client);
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

        activeBots[username].status = 'Error';
        activeBots[username].lastError = fullMsg;
        if(activeBots[username].client) { activeBots[username].client.logOff(); activeBots[username].client = null; }
    });

    client.on('disconnected', (eresult, msg) => {
        log(`${username} disconnected: ${msg} (${eresult})`, "WARN", username);
        if (activeBots[username].status === 'Running') {
             activeBots[username].status = 'Reconnecting...';
             sendDiscordWebhook("Bot Disconnected", `Account **${username}** disconnected. Reason: ${msg} (${eresult})`, 15158332);
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

function updateBotGames(username) {
    const bot = activeBots[username];
    const acc = getAccount(username);
    if (!bot || !bot.client) return;

    // Clear existing rotation if any
    if (bot.rotationInterval) { clearInterval(bot.rotationInterval); bot.rotationInterval = null; }
    bot.nextRotation = null;

    if (acc.games && acc.games.length > 32) {
        bot.rotateIndex = 0;
        const rotate = () => {
            if (!bot.client) return;
            const allGames = acc.games;
            let idx = bot.rotateIndex || 0;
            if (idx >= allGames.length) idx = 0;
            
            const gamesToPlay = allGames.slice(idx, idx + 32);
            bot.rotateIndex = (idx + 32) >= allGames.length ? 0 : idx + 32;
            
            const currentBatch = Math.floor(idx / 32) + 1;
            const totalBatches = Math.ceil(allGames.length / 32);
            log(`${username} rotating games. Playing batch ${currentBatch}/${totalBatches} (Total: ${allGames.length} games).`, "BOT", username);
            bot.client.gamesPlayed(getGamePayload(gamesToPlay, acc.customStatus));
            bot.nextRotation = Date.now() + 3600000;
        };
        rotate(); // Play first set immediately
        bot.rotationInterval = setInterval(rotate, 3600000); // Rotate every 1 hour
    } else {
        bot.client.gamesPlayed(getGamePayload(acc.games, acc.customStatus));
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
            if (privacy.profile) { pSettings.profile = parseInt(privacy.profile); acc.privacy = acc.privacy || {}; acc.privacy.profile = pSettings.profile; }
            if (privacy.inventory) { pSettings.inventory = parseInt(privacy.inventory); acc.privacy = acc.privacy || {}; acc.privacy.inventory = pSettings.inventory; }
            if (privacy.ownedGames) { pSettings.ownedGames = parseInt(privacy.ownedGames); acc.privacy = acc.privacy || {}; acc.privacy.ownedGames = pSettings.ownedGames; }
            
            community.profileSettings(pSettings, (err) => { 
                if(err) log(`${username} privacy update failed: ${err.message}`, "ERROR", username); 
                else { log(`${username} privacy settings updated`, "PROFILE", username); saveAccount(acc); }
            });
        }
    }
}

function stopBot(u) { const b = activeBots[u]; if (b) { if (b.rotationInterval) { clearInterval(b.rotationInterval); b.rotationInterval = null; } b.nextRotation = null; if (b.client) { b.client.logOff(); b.client = null; log(`${u} stopped.`, "BOT", u); } b.status = 'Stopped'; b.guardCallback = null; b.lastError = null; } }

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

module.exports = { startBotProcess, stopBot, getActiveBots, getGameName, searchGames, sendDiscordWebhook, updateProfile, getGamePayload, updateBotGames };