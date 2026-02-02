const https = require('https');
const { log } = require('../utils/utils');
const { getSettings } = require('../db/database');
const botManager = require('./botManager');

let allSteamApps = [];
const TOP_GAMES_FALLBACK = { 730: "Counter-Strike 2", 440: "Team Fortress 2", 570: "Dota 2", 252490: "Rust", 271590: "GTA V" };

function updateAppList() {
    https.get('https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json', (res) => {
        if (res.statusCode !== 200) return;
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { allSteamApps = JSON.parse(data); log(`Loaded ${allSteamApps.length} games.`, "SUCCESS"); } catch(e){ console.error("Failed to parse steam app list", e); } });
    }).on('error', (e) => { console.error("Failed to fetch steam app list", e); });
}
updateAppList();
setInterval(updateAppList, 24 * 60 * 60 * 1000);

function getGameName(id) {
    const game = allSteamApps.find(a => a.appid == id);
    return game ? game.name : (TOP_GAMES_FALLBACK[id] || "Unknown Game");
}

function searchGames(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return allSteamApps.filter(a => a.name && a.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, 20);
}

function getGamePayload(games, customStatus) {
    const payload = [];
    if (customStatus && typeof customStatus === 'string' && customStatus.trim().length > 0) {
        payload.push(customStatus);
    }
    if (Array.isArray(games)) {
        payload.push(...games);
    }
    return payload;
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

    const req = https.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    });

    req.on('error', (e) => {
        log(`Discord webhook error: ${e.message}`, 'ERROR');
    });

    req.write(payload);
    req.end();
}

// The rest of the functions are now handled by the botManager and Bot class.
// We just need to export the botManager functions and the helper functions.

module.exports = {
    ...botManager,
    getGameName,
    searchGames,
    getGamePayload,
    sendDiscordWebhook
};