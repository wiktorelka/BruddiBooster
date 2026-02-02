const express = require('express');
const authRouter = require('./auth');
const accountsRouter = require('./accounts');
const usersRouter = require('./users');
const settingsRouter = require('./settings');
const bundlesRouter = require('./bundles');
const statsRouter = require('./stats');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use('/auth', authRouter);
router.use('/accounts', requireAuth, accountsRouter);
router.use('/users', requireAuth, usersRouter);
router.use('/settings', requireAuth, settingsRouter);
router.use('/bundles', requireAuth, bundlesRouter);
router.use('/stats', requireAuth, statsRouter);

// Other general-purpose routes
router.get('/search_games', requireAuth, (req, res) => {
    const { searchGames } = require('../bot/bot');
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q) return res.json([]);
    res.json(searchGames(q));
});

router.get('/logs', requireAuth, (req, res) => {
    const { getLogs } = require('../utils/utils');
    let logs = getLogs();
    if (req.user.role !== 'admin') {
        const userAccounts = require('../db/database').getAllAccounts().filter(a => a.owner === req.user.username).map(a => a.username);
        logs = logs.filter(l => l.relatedUser && userAccounts.includes(l.relatedUser));
    }
    res.json(logs.map(l => l.text));
});


module.exports = router;
