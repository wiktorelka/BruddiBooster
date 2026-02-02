const passport = require('passport');
const { getSession } = require('../db/database');

const requireAuth = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const session = getSession(token);
    if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = {
        username: session.username,
        role: session.role
    };
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Forbidden' });
    }
};

module.exports = {
    requireAuth,
    requireAdmin
};
