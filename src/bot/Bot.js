const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const EventEmitter = require('events');
const { getGamePayload } = require('./bot');

class Bot extends EventEmitter {
    constructor(account) {
        super();
        this.account = account;
        this.client = new SteamUser({ httpProxy: account.proxy });
        this.community = new SteamCommunity();
        this.status = 'Stopped';
        this.rotationInterval = null;
        this.statInterval = null;

        this.client.on('loggedOn', () => this.onLoggedOn());
        this.client.on('webSession', (sessionID, cookies) => this.onWebSession(sessionID, cookies));
        this.client.on('steamGuard', (domain, callback) => this.onSteamGuard(domain, callback));
        this.client.on('error', (err) => this.onError(err));
        this.client.on('disconnected', (eresult, msg) => this.onDisconnected(eresult, msg));
        this.client.on('friendRelationship', (sid, relationship) => this.onFriendRelationship(sid, relationship));
    }

    log(message, type = 'BOT') {
        this.emit('log', `[${this.account.username}] ${message}`, type);
    }

    start() {
        this.status = 'Logging in...';
        this.emit('status', this.status);
        this.log('Starting...');
        const logonDetails = {
            accountName: this.account.username,
            password: this.account.password,
        };
        if (this.account.sharedSecret) {
            try {
                logonDetails.twoFactorCode = SteamTotp.generateAuthCode(this.account.sharedSecret);
            } catch (e) {
                this.onError(new Error(`Invalid Shared Secret: ${e.message}`));
                return;
            }
        }
        this.client.logOn(logonDetails);
    }

    stop() {
        if (this.rotationInterval) clearInterval(this.rotationInterval);
        if (this.statInterval) clearInterval(this.statInterval);
        if (this.client.steamID) this.client.logOff();
        this.status = 'Stopped';
        this.emit('status', this.status);
        this.log('Stopped.');
    }

    onLoggedOn() {
        this.status = 'Running';
        this.emit('status', this.status);
        this.log('Successfully logged in.');
        this.client.setPersona(this.account.personaState || SteamUser.EPersonaState.Online);
        this.updateGames();
        this.emit('loggedOn', this.client.steamID.getSteamID64());

        this.statInterval = setInterval(() => {
            const hoursBoosted = (this.account.games || []).length;
            this.emit('stat', hoursBoosted);
        }, 60 * 60 * 1000);
    }

    onWebSession(sessionID, cookies) {
        this.community.setCookies(cookies);
        this.emit('webSession', cookies);
    }

    onSteamGuard(domain, callback) {
        this.status = 'Need Guard';
        this.emit('status', this.status);
        this.log(`Steam Guard code required${domain ? ` from ${domain}` : ''}.`);
        this.emit('steamGuard', callback);
    }

    onError(err) {
        this.status = 'Error';
        this.emit('status', this.status);
        this.log(`Error: ${err.message}`, 'ERROR');
        if (this.client.steamID) this.client.logOff();
    }

    onDisconnected(eresult, msg) {
        this.status = 'Disconnected';
        this.emit('status', this.status);
        this.log(`Disconnected: ${msg} (${eresult})`, 'WARN');
    }

    onFriendRelationship(sid, relationship) {
        if (relationship === SteamUser.EFriendRelationship.RequestRecipient && this.account.autoAccept) {
            this.client.addFriend(sid);
            this.log(`Accepted friend request from ${sid.getSteamID64()}`);
        }
    }

    updateGames() {
        if (this.rotationInterval) clearInterval(this.rotationInterval);

        const games = this.account.games || [];
        const customStatus = this.account.customStatus;

        if (games.length > 32) {
            let currentIndex = 0;
            const rotate = () => {
                const gamesToPlay = games.slice(currentIndex, currentIndex + 32);
                this.client.gamesPlayed(getGamePayload(gamesToPlay, customStatus));
                this.log(`Now playing ${gamesToPlay.length} games (rotation).`);
                currentIndex = (currentIndex + 32) % games.length;
            };
            this.rotationInterval = setInterval(rotate, 3600 * 1000);
            rotate();
        } else {
            this.client.gamesPlayed(getGamePayload(games, customStatus));
            this.log(`Now playing ${games.length} games.`);
        }
    }
}

module.exports = Bot;
