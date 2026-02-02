const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const http = require('http');
const { Server } = require("socket.io");
const passport = require('passport');
const path = require('path');

const { log, setLogListener } = require('./utils/utils');
const api = require('./api');
const { startAllAutoStartBots } = require('./bot/bot');
require('./config/passport');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MIDDLEWARE ---
app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://avatars.steamstatic.com", "https://raw.githubusercontent.com"],
            connectSrc: ["'self'", "https://raw.githubusercontent.com"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- SOCKET.IO ---
setLogListener((logEntry) => {
    io.emit('new_log', logEntry);
});

// --- API ---
app.use('/api', api);

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
    log(err.stack, 'ERROR');
    res.status(500).send('Something broke!');
});

// --- STARTUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log(`BruddiBooster v2 is running on port ${PORT}`, "SYSTEM");
    startAllAutoStartBots();
});