const express = require('express');
const Joi = require('joi');
const { getUsers, createUser, updateUser, deleteUser } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const userSchema = Joi.object({
    username: Joi.string().required(),
    password: Joi.string().required(),
    role: Joi.string().valid('admin', 'user').required()
});

router.get('/', requireAdmin, (req, res) => {
    res.json(getUsers().map(u => ({ username: u.username, role: u.role })));
});

router.post('/', requireAdmin, (req, res) => {
    const { error, value } = userSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    if (require('../db/database').getUser(value.username)) {
        return res.status(400).json({ error: 'User already exists.' });
    }

    createUser(value.username, value.password, value.role);
    res.status(201).json(value);
});

router.put('/:username', requireAdmin, (req, res) => {
    const { error, value } = userSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    updateUser(req.params.username, value);
    res.json(value);
});

router.delete('/:username', requireAdmin, (req, res) => {
    if (req.params.username === req.user.username) {
        return res.status(400).json({ error: 'Cannot delete yourself.' });
    }
    deleteUser(req.params.username);
    res.status(204).send();
});

module.exports = router;
