const express = require('express');
const Joi = require('joi');
const { getSettings, updateSetting } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { sendDiscordWebhook } = require('../bot/bot');

const router = express.Router();

const settingsSchema = Joi.object({
    discordWebhook: Joi.string().uri().allow('')
});

router.get('/', (req, res) => {
    res.json(getSettings());
});

router.post('/', requireAdmin, (req, res) => {
    const { error, value } = settingsSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    for (const [key, val] of Object.entries(value)) {
        updateSetting(key, val);
    }
    res.json(getSettings());
});

router.post('/test_webhook', requireAdmin, (req, res) => {
    const { discordWebhook } = getSettings();
    if (discordWebhook) {
        sendDiscordWebhook("Test Notification", "This is a test message from BruddiBooster.", 5814783, discordWebhook);
        res.json({ success: true });
    } else {
        res.status(400).json({ message: 'Discord webhook URL not set.' });
    }
});

module.exports = router;
