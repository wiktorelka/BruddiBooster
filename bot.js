const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');
const { log } = require('./utils');
const { getAllAccounts, getAccount, saveAccount } = require('./data');

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

function startBotProcess(account) {
    const { username, password, sharedSecret } = account;
    if (activeBots[username] && activeBots[username].client) return;

    if (!activeBots[username]) activeBots[username] = { client: null, status: 'Stopped', guardCallback: null, lastError: null };
    activeBots[username].lastError = null;

    const client = new SteamUser();
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

    client.on('loggedOn', () => {
        const state = account.personaState !== undefined ? account.personaState : SteamUser.EPersonaState.Online;
        client.setPersona(state);
        client.gamesPlayed(getGamePayload(account.games, account.customStatus));
        activeBots[username].status = 'Running';
        activeBots[username].lastError = null;
        log(`${username} successfully logged in.`, "SUCCESS", username);
        
        updateHours(username, client);
        if (client.steamID) { account.steamId = client.steamID.getSteamID64(); saveAccount(account); }
        
        client.getPersonas([client.steamID], () => { setTimeout(() => { if (!client.steamID) return; const u = client.users[client.steamID.getSteamID64()]; if (u) { if(u.player_name) account.nickname = u.player_name; if(u.avatar_hash) account.avatarHash = u.avatar_hash.toString('hex'); saveAccount(account); } }, 1000); });
    });

    client.on('steamGuard', (d, cb) => { 
        log(`${username} needs Guard Code`, "AUTH", username);
        activeBots[username].status = 'Need Guard'; 
        activeBots[username].guardCallback = cb; 
    });

    client.on('error', (e) => {
        const errorDetails = e.eresult ? `(Steam Code: ${e.eresult})` : '';
        const fullMsg = `${e.message} ${errorDetails}`;
        log(`${username} Error: ${fullMsg}`, "ERROR", username);

        if (e.eresult === 84) {
            activeBots[username].status = 'Rate Limit (5m)';
            activeBots[username].lastError = 'Steam Rate Limit (IP/Account). Cooldown active.';
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
}

function stopBot(u) { const b = activeBots[u]; if (b && b.client) { b.client.logOff(); b.client = null; log(`${u} stopped.`, "BOT", u); } if (b) { b.status = 'Stopped'; b.guardCallback = null; b.lastError = null; } }

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
        if (activeBots[acc.username] && activeBots[acc.username].status === 'Running' && (acc.games||[]).length > 0) {
            acc.boostedHours = (acc.boostedHours || 0) + ((1/60) * acc.games.length);
            saveAccount(acc);
        }
    });
}, 60000);

module.exports = { startBotProcess, stopBot, getActiveBots, getGameName, searchGames };