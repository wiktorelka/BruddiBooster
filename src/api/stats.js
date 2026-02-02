const express = require('express');
const { getStatsLast30Days } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
    const stats = getStatsLast30Days();
    res.json(stats);
});

module.exports = router;
