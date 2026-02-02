const express = require('express');
const Joi = require('joi');
const { getAllAccounts, getAccount, createAccount, updateAccount, deleteAccount } = require('../db/database');
const { startBot, stopBot, getBotStatus } = require('../bot/bot');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const accountSchema = Joi.object({
    username: Joi.string().required(),
    password: Joi.string().required(),
    sharedSecret: Joi.string().allow(''),
    proxy: Joi.string().allow(''),
    category: Joi.string().allow(''),
    autoStart: Joi.boolean(),
    autoAccept: Joi.boolean(),
    games: Joi.array().items(Joi.number()),
    customStatus: Joi.string().allow('')
});

function verifyOwner(req, username) {
    if (req.user.role === 'admin') return true;
    const acc = getAccount(username);
    return acc && acc.owner === req.user.username;
}

router.get('/', (req, res) => {
    let accounts = getAllAccounts();
    if (req.user.role !== 'admin') {
        accounts = accounts.filter(a => a.owner === req.user.username);
    }
    res.json(accounts.map(acc => ({
        ...acc,
        status: getBotStatus(acc.username)
    })));
});

router.post('/', async (req, res) => {
    const { error, value } = accountSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    if (getAccount(value.username)) {
        return res.status(400).json({ error: 'Account already exists.' });
    }

    const newAccount = {
        ...value,
        owner: req.user.username,
        addedAt: Date.now(),
        boostedHours: 0,
        personaState: 1,
    };

    createAccount(newAccount);
    res.status(201).json(newAccount);
});

router.put('/:username', async (req, res) => {
    if (!verifyOwner(req, req.params.username)) return res.status(403).json({ error: 'Forbidden' });

    const { error, value } = accountSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    updateAccount(req.params.username, value);
    res.json(getAccount(value.username));
});

router.delete('/:username', (req, res) => {
    if (!verifyOwner(req, req.params.username)) return res.status(403).json({ error: 'Forbidden' });
    stopBot(req.params.username);
    deleteAccount(req.params.username);
    res.status(204).send();
});

router.post('/:username/start', (req, res) => {
    if (!verifyOwner(req, req.params.username)) return res.status(403).json({ error: 'Forbidden' });
    startBot(req.params.username);
    res.json({ success: true });
});

router.post('/:username/stop', (req, res) => {
    if (!verifyOwner(req, req.params.username)) return res.status(403).json({ error: 'Forbidden' });
    stopBot(req.params.username);
    res.json({ success: true });
});

router.post('/bulk', requireAdmin, (req, res) => {
    const { accounts } = req.body;
    if (!Array.isArray(accounts)) {
        return res.status(400).json({ message: 'Expected an array of accounts.' });
    }

    let count = 0;
    accounts.forEach(acc => {
        const { error, value } = accountSchema.validate(acc);
        if (!error && !getAccount(value.username)) {
            createAccount({
                ...value,
                owner: req.user.username,
                addedAt: Date.now(),
                boostedHours: 0,
                personaState: 1,
            });
            count++;
        }
    });
    res.status(201).json({ count });
});


module.exports = router;
