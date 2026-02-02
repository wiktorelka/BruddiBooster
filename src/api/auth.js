const express = require('express');
const passport = require('passport');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const { createSession, deleteSession, getUser, updateUser } = require('../db/database');
const { decrypt } = require('../utils/utils');

const router = express.Router();

router.post('/login', (req, res, next) => {
    passport.authenticate('local', { session: false }, (err, user, info) => {
        if (err || !user) {
            return res.status(400).json({
                message: info ? info.message : 'Login failed',
                user: user
            });
        }

        if (user.twoFactorSecret) {
            const { token } = req.body;
            if (!token) {
                return res.json({ requires2fa: true });
            }
            const verified = speakeasy.totp.verify({
                secret: decrypt(user.twoFactorSecret),
                encoding: 'base32',
                token: token
            });
            if (!verified) {
                return res.status(401).json({ message: 'Invalid 2FA token.' });
            }
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
        createSession(sessionToken, user.username, user.role, expiresAt);

        return res.json({ token: sessionToken, user });
    })(req, res, next);
});

router.post('/logout', (req, res) => {
    const token = req.headers.authorization;
    if (token) {
        deleteSession(token);
    }
    res.json({ success: true });
});

router.get('/verify_session', (req, res) => {
    const token = req.headers.authorization;
    if (!token) return res.json({ success: false });

    const session = require('../db/database').getSession(token);
    if (session && session.expiresAt > Date.now()) {
        const user = getUser(session.username);
        res.json({ success: true, role: user.role, username: user.username, has2FA: !!user.twoFactorSecret });
    } else {
        res.json({ success: false });
    }
});

module.exports = router;
