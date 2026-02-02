const { fork } = require('child_process');
const path = require('path');
const { getAccount, getAllAccounts, updateAccount } = require('../db/database');
const { log } = require('../utils/utils');

const activeBots = new Map();

function startBot(username) {
    if (activeBots.has(username)) {
        log(`Bot ${username} is already running.`, 'WARN');
        return;
    }

    const account = getAccount(username);
    if (!account) {
        log(`Account ${username} not found.`, 'ERROR');
        return;
    }

    const botProcess = fork(path.join(__dirname, 'bot-process.js'));
    activeBots.set(username, { process: botProcess, status: 'Starting...' });

    botProcess.send({ type: 'start', account });

    botProcess.on('message', (msg) => {
        switch (msg.type) {
            case 'log':
                log(msg.message, msg.level, username);
                break;
            case 'status':
                activeBots.get(username).status = msg.status;
                break;
            case 'steamGuard':
                // This needs to be handled by the web server
                break;
            case 'loggedOn':
                updateAccount(username, { steamId: msg.steamId });
                break;
            case 'stat':
                require('../db/database').recordHourlyStat(username, msg.hoursBoosted);
                break;
        }
    });

    botProcess.on('exit', (code) => {
        log(`Bot ${username} exited with code ${code}`, 'WARN');
        activeBots.delete(username);
    });
}

function stopBot(username) {
    const bot = activeBots.get(username);
    if (bot) {
        bot.process.send({ type: 'stop' });
        activeBots.delete(username);
    }
}

function getBotStatus(username) {
    const bot = activeBots.get(username);
    return bot ? bot.status : 'Stopped';
}

function startAllAutoStartBots() {
    const accounts = getAllAccounts();
    accounts.forEach(acc => {
        if (acc.autoStart) {
            startBot(acc.username);
        }
    });
}

function getActiveBots() {
    return Array.from(activeBots.keys());
}

module.exports = {
    startBot,
    stopBot,
    getBotStatus,
    startAllAutoStartBots,
    getActiveBots
};
