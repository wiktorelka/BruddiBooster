const EventEmitter = require('events');

// Every instance carries a chunk of ballast standing in for the PICS cache, so a
// client that is retained after teardown shows up loudly in heapUsed.
const BALLAST_BYTES = 512 * 1024;

let liveCount = 0;
let createdCount = 0;
const registry = new FinalizationRegistry(() => { liveCount--; });

class FakeSteamUser extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.steamID = null;
        this.users = {};
        this.picsCache = { apps: {} };
        this._ballast = Buffer.alloc(BALLAST_BYTES);
        this._loggedOff = false;
        this._id = ++createdCount;

        liveCount++;
        registry.register(this, this._id);
        FakeSteamUser.instances.add(new WeakRef(this));
    }

    // --- surface used by bot.js ---

    // Mirrors steam-user: a refresh token logs in without accountName/password.
    get usedRefreshToken() { return !!(this._logOnOpts && this._logOnOpts.refreshToken); }

    logOn(opts) {
        this._logOnOpts = opts || {};
        this._logOnCalled = true;
        // steam-user keeps retrying the connection on a self-referencing timer
        // (_reconnectForCloseDuringAuthTimeout -> _doConnection). That closure is
        // what keeps a wedged client alive, so model it exactly.
        this._reconnectTimer = setInterval(() => { this._attempts = (this._attempts || 0) + 1; }, 1000);
        // The harness decides whether this client ever reaches 'loggedOn', so the
        // stuck-on-a-dead-proxy case is reproducible.
    }

    logOff() {
        this._loggedOff = true;
        // Mirrors steam-user's _disconnect(): with no steamID it only does
        // `this._connection && this._connection.end(true)`. A client that never
        // finished connecting has no _connection, so nothing is torn down and the
        // reconnect timer keeps the object alive indefinitely.
        if (this.steamID) {
            this.steamID = null;
            clearInterval(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _disconnect() {
        this._loggedOff = true;
        this.steamID = null;
        clearInterval(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    setPersona(state) { this._persona = state; this._personaCalled = true; }
    gamesPlayed(payload, force) { this._playing = payload; this._lastForce = !!force; if (force) this._kicked = true; }
    kickPlayingSession(cb) { this._kicked = true; if (cb) process.nextTick(() => cb(null, { playingApp: 0 })); }
    ownsApp() { return true; }
    addFriend() {}

    getUserOwnedApps(steamID, opts, cb) {
        process.nextTick(() => cb(null, { apps: [{ appid: 730, name: 'Counter-Strike 2', playtime_forever: 60 }] }));
    }

    requestFreeLicense(appids, cb) {
        process.nextTick(() => cb(null, [], appids));
    }

    getPersonas(ids, cb) {
        const id64 = ids[0] && ids[0].getSteamID64 ? ids[0].getSteamID64() : '0';
        this.users[id64] = { player_name: 'fake', avatar_hash: Buffer.alloc(20) };
        process.nextTick(() => cb(null, this.users));
    }

    // --- harness helpers ---

    becomeLoggedOn(id64 = '76561190000000000') {
        this.steamID = { getSteamID64: () => id64 };
        this.emit('loggedOn');
    }
}

FakeSteamUser.instances = new Set();
FakeSteamUser.EPersonaState = { Offline: 0, Online: 1, Busy: 2, Away: 3 };
FakeSteamUser.EFriendRelationship = { None: 0, RequestRecipient: 2 };

FakeSteamUser.stats = () => ({ live: liveCount, created: createdCount });
FakeSteamUser.resetCounters = () => { createdCount = 0; };

// Counts instances still reachable through their WeakRefs, pruning dead ones.
// More reliable than the FinalizationRegistry alone, which is best-effort.
FakeSteamUser.liveInstances = () => {
    const alive = [];
    for (const ref of FakeSteamUser.instances) {
        if (ref.deref()) alive.push(ref);
        else FakeSteamUser.instances.delete(ref);
    }
    return alive;
};

module.exports = FakeSteamUser;
