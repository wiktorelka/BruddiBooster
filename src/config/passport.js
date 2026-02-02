const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { getUser } = require('../db/database');
const { decrypt } = require('../utils/utils');

passport.use(new LocalStrategy(
    (username, password, done) => {
        const user = getUser(username);
        if (!user) {
            return done(null, false, { message: 'Incorrect username.' });
        }
        if (decrypt(user.password) !== password) {
            return done(null, false, { message: 'Incorrect password.' });
        }
        return done(null, user);
    }
));

passport.serializeUser((user, done) => {
    done(null, user.username);
});

passport.deserializeUser((username, done) => {
    const user = getUser(username);
    done(null, user);
});
