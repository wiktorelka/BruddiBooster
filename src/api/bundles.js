const express = require('express');
const Joi = require('joi');
const { getBundles, createBundle, deleteBundle } = require('../db/database');
const { getGameName } = require('../bot/bot');

const router = express.Router();

const bundleSchema = Joi.object({
    name: Joi.string().required(),
    games: Joi.array().items(Joi.number()).required()
});

router.get('/', (req, res) => {
    const bundles = getBundles();
    const resolved = {};
    for (const [name, games] of Object.entries(bundles)) {
        resolved[name] = games.map(id => ({ id, name: getGameName(id) }));
    }
    res.json(resolved);
});

router.post('/', (req, res) => {
    const { error, value } = bundleSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    createBundle(value.name, value.games);
    res.status(201).json(value);
});

router.delete('/:name', (req, res) => {
    deleteBundle(req.params.name);
    res.status(204).send();
});

module.exports = router;
