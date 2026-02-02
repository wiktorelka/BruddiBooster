const Bot = require('./Bot');

let bot;

process.on('message', (msg) => {
    switch (msg.type) {
        case 'start':
            bot = new Bot(msg.account);
            bot.on('log', (message, level) => {
                process.send({ type: 'log', message, level });
            });
            bot.on('status', (status) => {
                process.send({ type: 'status', status });
            });
            bot.on('steamGuard', (callback) => {
                // We can't send the callback over IPC, so we'll have to handle this differently.
                // For now, we'll just log it.
                process.send({ type: 'log', message: 'Steam Guard code required.', level: 'AUTH' });
            });
            bot.on('loggedOn', (steamId) => {
                process.send({ type: 'loggedOn', steamId });
            });
            bot.on('stat', (hoursBoosted) => {
                process.send({ type: 'stat', hoursBoosted });
            });
            bot.start();
            break;
        case 'stop':
            if (bot) {
                bot.stop();
                process.exit(0);
            }
            break;
    }
});
