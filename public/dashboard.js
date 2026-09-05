// Dashboard State
let currentSelectedGames = []; 
let currentBundleGames = [];
let ownedGames = [];
const categoryStates = {}; 
let tempSecret = ''; 
let activeTab = 'dash';
let availableBundles = {};
let cachedAccounts = [];
let cachedBundles = {};
let cachedLogs = [];
let socket = null;
let selectedFreeGames = [];
let selectedFreeAccounts = [];
let confirmResolver = null;
let statusChartInstance = null;
let pollTimer = null;
let sysTimer = null;
let socketLive = false;
// Survives table rebuilds. The table used to be recreated on every refresh, silently
// clearing every checkbox mid-operation.
let selectedAccounts = new Set();
let statusFilter = 'all';
let spareProxies = [];
let hideOwnedAccounts = false;
let currentSort = { column: null, direction: 'asc' };

// Steam persona names, game names, log lines and error strings all reach these
// templates from outside the panel and land in innerHTML. Escape anything that
// isn't ours.
//
// esc()   - text nodes and quoted attribute values.
// jsArg() - a value being passed to an inline onclick handler. HTML-escaping alone
//           is not enough there: the browser HTML-decodes the attribute before the
//           JS is parsed, so an escaped &#39; turns back into a quote and breaks out
//           of the string. JSON-encoding first produces a complete, self-delimiting
//           JS literal that survives that decode. Emit it *without* surrounding
//           quotes in the template, e.g. data-a="${jsArg(x)}".
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// --- HINTS ---
// Native title= tooltips are slow to appear, truncate awkwardly and can't wrap, which
// is why the existing ones were single cryptic sentences. This renders a styled
// tooltip that can hold a real explanation.
const HINTS = {
    rotation:
        "Steam only lets an account show 32 games at once. With more than 32 selected the bot plays them in batches of 32 and swaps batches on the rotation interval (Settings > Rotation Interval, default 60 min), so every game keeps accruing hours \u2014 just not simultaneously.",
    autoStart:
        "Start this account automatically when the panel boots, and restart it after a crash. Turn it off for accounts you only run manually.",
    autoAccept:
        "Automatically accept incoming Steam friend requests on this account. Useful for trading or level-boosting accounts; leave off if you don't want strangers added.",
    autoReclaim:
        "If you launch a game on your own PC, Steam hands the play session to that device and this bot silently stops earning hours. With this on, the bot takes the session back \u2014 which will close the game you just started. Leave it off unless the account is purely a bot.",
    schedule:
        "Only boost between these times each day. Windows may cross midnight (e.g. 22:00\u201306:00). The bot starts and stops itself at the boundaries; outside the window it shows 'Off schedule'.",
    personaState:
        "How the account appears to friends while boosting: Online, Away, Busy, Snooze, or Invisible. Invisible still accrues hours but hides the activity.",
    customStatus:
        "A free-text 'non-Steam game' name shown as the title on the profile, above the real games. Leave blank to show only actual games.",
    proxy:
        "Route this account's Steam connection through a proxy, so accounts don't all share one IP. Format: http://user:pass@ip:port. Too many accounts on one IP is what triggers Steam's rate limits.",
    proxyPool:
        "Spare proxies used automatically. When an account is rate-limited or crashes repeatedly, the bot swaps it onto a random proxy from this pool. One per line.",
    bundle:
        "A saved, named list of games you can apply to many accounts at once, instead of picking games per account.",
    freeGames:
        "Adds free-to-play licences to accounts in bulk so they can then be idled. Games already owned are skipped; region-locked ones are reported and dropped.",
    refreshToken:
        "This account signs in with a token Steam issued, so its password is never re-sent. That means far fewer rate limits and Steam Guard emails on restarts.",
    elsewhere:
        "You are signed in to this account somewhere else, so Steam ended the bot's session. Nothing is broken \u2014 the bot keeps checking and starts boosting again on its own once you close Steam or the game. It waits progressively longer between checks (up to 10 minutes) so Steam doesn't rate-limit the account.",
    blocked:
        "The bot is connected but another session owns the play state \u2014 usually you playing on your own PC. No hours are accruing until that session ends, or the bot reclaims it (see 'Reclaim session' in the account's edit dialog).",
    heap:
        "Memory used by the panel process against Node's limit. Turns amber past 70% and red past 85%; you'll also get a log line and a Discord alert at 85%.",
    backup:
        "Downloads categories, games, bundles, proxies, schedules and hour history as JSON. Passwords, shared secrets and login tokens are never included, so the file is safe to store off-box.",
    bulkProxyWait:
        "Import the accounts with auto-start enabled but don't launch them yet, so you can assign proxies first. Prevents a burst of same-IP logins that would rate-limit you.",
    hideOwned:
        "Hide accounts that already own every selected game, so the list only shows accounts the operation would actually change."
};

function hint(key, extraStyle) {
    const text = HINTS[key];
    if (!text) return '';
    return `<i class="fa-solid fa-circle-info hint-icon" data-hint="${esc(text)}"${extraStyle ? ` style="${extraStyle}"` : ''}></i>`;
}

let hintEl = null;
function initHints(root) {
    // Static markup declares data-hint-key so the copy lives in one place (HINTS)
    // rather than being duplicated into index.html.
    root.querySelectorAll('[data-hint-key]').forEach(el => {
        const t = HINTS[el.getAttribute('data-hint-key')];
        if (t) el.setAttribute('data-hint', t);
    });

    const show = (target) => {
        const text = target.getAttribute('data-hint');
        if (!text) return;
        if (!hintEl) {
            hintEl = document.createElement('div');
            hintEl.className = 'hint-pop';
            document.body.appendChild(hintEl);
        }
        hintEl.textContent = text;
        hintEl.style.display = 'block';
        const r = target.getBoundingClientRect();
        const w = Math.min(320, window.innerWidth - 24);
        hintEl.style.width = w + 'px';
        // Keep it on screen near the icon.
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
        hintEl.style.left = left + 'px';
        const h = hintEl.offsetHeight;
        hintEl.style.top = (r.top - h - 10 > 8 ? r.top - h - 10 : r.bottom + 10) + 'px';
    };
    const hide = () => { if (hintEl) hintEl.style.display = 'none'; };

    root.addEventListener('mouseover', e => { const t = e.target.closest('[data-hint]'); if (t) show(t); });
    root.addEventListener('mouseout', e => { if (e.target.closest('[data-hint]')) hide(); });
    root.addEventListener('focusin', e => { const t = e.target.closest('[data-hint]'); if (t) show(t); });
    root.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, true);
}

// --- DELEGATED EVENT DISPATCH ---
// Inline on*= attributes require CSP script-src-attr 'unsafe-inline', which is
// exactly what an injected attribute needs to run. Markup now carries data-act (a
// function name) and data-a (a JSON argument array), and one document-level listener
// dispatches. "$this" and "$event" are substituted with the element and the event.
//
// Only names in ACTIONS can be invoked, so a crafted data-act can't reach arbitrary
// globals.
function act(fn, ...args) {
    let out = ` data-act="${esc(fn)}"`;
    if (args.length) out += ` data-a="${esc(JSON.stringify(args))}"`;
    return out;
}


function jsArg(s) {
    return esc(JSON.stringify(String(s == null ? '' : s)));
}

const POPULAR_FREE_GAMES = [
    { id: 730, name: "Counter-Strike 2" },
    { id: 570, name: "Dota 2" },
    { id: 578080, name: "PUBG: BATTLEGROUNDS" },
    { id: 1172470, name: "Apex Legends" },
    { id: 1085660, name: "Destiny 2" },
    { id: 230410, name: "Warframe" },
    { id: 236390, name: "War Thunder" },
    { id: 440, name: "Team Fortress 2" },
    { id: 304930, name: "Unturned" },
    { id: 1222670, name: "The Sims™ 4" },
    { id: 1449850, name: "Yu-Gi-Oh! Master Duel" },
    { id: 444200, name: "World of Tanks Blitz" },
    { id: 291550, name: "Brawlhalla" },
    { id: 238960, name: "Path of Exile" },
    { id: 386360, name: "SMITE" },
    { id: 444090, name: "Paladins" },
    { id: 1599340, name: "Lost Ark" },
    { id: 1240440, name: "Halo Infinite" },
    { id: 2357570, name: "Overwatch® 2" },
    { id: 2073850, name: "THE FINALS" },
    { id: 761890, name: "Albion Online" },
    { id: 700330, name: "SCP: Secret Laboratory" },
    { id: 438100, name: "VRChat" },
    { id: 552990, name: "World of Warships" },
    { id: 8500, name: "EVE Online" },
    { id: 1782210, name: "Crab Game" },
    { id: 1568590, name: "Goose Goose Duck" },
    { id: 1623660, name: "MIR4" },
    { id: 588430, name: "Fallout Shelter" },
    { id: 304050, name: "Trove" },
    { id: 218230, name: "PlanetSide 2" },
    { id: 24200, name: "DC Universe Online" },
    { id: 9900, name: "Star Trek Online" },
    { id: 109600, name: "Neverwinter" },
    { id: 291480, name: "Warface: Clutch" },
    { id: 386180, name: "Crossout" },
    { id: 1105500, name: "Asphalt 9: Legends" },
    { id: 1938090, name: "Call of Duty®" },
    { id: 1515320, name: "Disney Speedstorm" },
    { id: 1276390, name: "Bloons TD Battles 2" },
    { id: 301520, name: "Robocraft" },
    { id: 1343400, name: "RuneScape" },
    { id: 1284210, name: "Guild Wars 2" },
    { id: 918570, name: "Century: Age of Ashes" },
    { id: 677620, name: "Splitgate" },
    { id: 2133250, name: "Enlisted" },
    { id: 1286830, name: "STAR WARS™: The Old Republic™" },
    { id: 909660, name: "Conqueror's Blade" },
    { id: 380600, name: "Fishing Planet" },
    { id: 1407200, name: "World of Tanks" },
    { id: 767560, name: "War Robots" },
    { id: 471710, name: "Rec Room" },
    { id: 489520, name: "Minion Masters" },
    { id: 212500, name: "The Lord of the Rings Online™" },
    { id: 813820, name: "Realm Royale Reforged" },
    { id: 843380, name: "Super Animal Royale" },
    { id: 784030, name: "CRSED" },
    { id: 611500, name: "Quake Champions" },
    { id: 2420510, name: "HoloCure - Save the Fans!" },
    { id: 714010, name: "Aimlabs" },
    { id: 363970, name: "Clicker Heroes" },
    { id: 346900, name: "AdVenture Capitalist" },
    { id: 627690, name: "Idle Champions" }
];



// Initialize Dashboard
window.onDashboardLoaded = function() {
    initHints(document); // clicks are already delegated from login.js
    initGameSearch();
    initBundleGameSearch();
    document.getElementById('btnBulk').addEventListener('click', openBulkModal);
    document.getElementById('btnAdd').addEventListener('click', openAddModal);

    // Search Listeners
    document.getElementById('accountSearch').addEventListener('input', () => applyAccountFilter());
    document.getElementById('bundleSearch').addEventListener('input', () => renderBundlesView());
    document.getElementById('logSearch').addEventListener('input', () => renderLogs());
    const logAccSel = document.getElementById('logAccountFilter');
    if (logAccSel) logAccSel.addEventListener('change', () => renderLogs());
    
    // Setup UI based on role
    document.getElementById('nav-users').style.display = currentUserRole === 'admin' ? 'flex' : 'none';
    
    // Account state arrives over the socket (see 'accounts' below). This REST call is
    // just the initial paint; the interval is a slow safety net for a dead socket, not
    // the primary path.
    fetchAccounts();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        if (!authToken || document.hidden) return;
        if (!socketLive) fetchAccounts();   // socket down: fall back to polling
        if (activeTab === 'logs' && !socketLive) fetchLogs();
    }, 15000);

    // Server resource readout. Slow poll -- this is a health indicator, not telemetry.
    fetchSystemStats();
    if (sysTimer) clearInterval(sysTimer);
    sysTimer = setInterval(() => { if (authToken && !document.hidden) fetchSystemStats(); }, 15000);

    // Live updates. The session cookie authenticates the socket, and the server only
    // sends events for accounts this user owns.
    if (typeof io !== 'undefined') {
        socket = io({ withCredentials: true });

        socket.on('connect', () => { socketLive = true; });
        socket.on('disconnect', () => { socketLive = false; });
        socket.on('connect_error', () => { socketLive = false; });

        // Full snapshot on connect...
        socket.on('accounts', (d) => applyAccounts(d));

        // ...then only what changed. Saves sending the whole list every few seconds,
        // which matters most when the panel is open over mobile data.
        socket.on('accounts_delta', ({ changed, removed }) => {
            if (!Array.isArray(cachedAccounts)) return;
            const byName = new Map(cachedAccounts.map(a => [a.username, a]));
            (removed || []).forEach(n => byName.delete(n));
            (changed || []).forEach(a => byName.set(a.username, a));
            applyAccounts([...byName.values()]);
        });

        socket.on('new_log', (logEntry) => {
            cachedLogs.unshift(logEntry);
            if (cachedLogs.length > 400) cachedLogs.pop();
            if (activeTab === 'logs') renderLogs();
        });
        
        socket.on('free_games_progress', (data) => {
            const el = document.getElementById('freeGamesProgress');
            const bar = document.getElementById('fgProgBar');
            const txt = document.getElementById('fgProgText');
            if (data.complete) {
                bar.style.width = '100%'; txt.innerText = 'Done!'; setTimeout(() => { el.style.display = 'none'; }, 3000);
            } else {
                el.style.display = 'flex'; 
                const pct = Math.round((data.processed / data.total) * 100); 
                bar.style.width = `${pct}%`; 
                let details = `${data.processed}/${data.total}`;
                if (data.stats) {
                    details += ` (✅ ${data.stats.success} | 🔁 ${data.stats.owned} | ⏳ ${data.stats.queued} | ❌ ${data.stats.failed})`;
                }
                txt.innerText = details;
            }
        });
    }
};

async function fetchSystemStats() {
    const d = await apiCall('/api/system');
    if (!d || typeof d.heapPct !== 'number') return;
    const bar = document.getElementById('sysHeapBar');
    const txt = document.getElementById('sysHeapTxt');
    if (!bar || !txt) return;
    txt.innerText = `${d.heapUsedMB} / ${d.heapLimitMB} MB`;
    bar.style.width = Math.min(100, d.heapPct) + '%';
    bar.className = 'sys-bar-fill' + (d.heapPct > 85 ? ' crit' : d.heapPct > 70 ? ' warn' : '');
    document.getElementById('sysRss').innerText = `RSS ${d.rssMB} MB`;
    document.getElementById('sysBots').innerText = `${d.runningBots}/${d.totalAccounts} running`;
    document.getElementById('sysStats').title =
        `Heap ${d.heapUsedMB} / ${d.heapLimitMB} MB (${d.heapPct}%)\n` +
        `RSS ${d.rssMB} MB | external ${d.externalMB} MB\n` +
        `System ${d.systemFreeMB} MB free of ${d.systemTotalMB} MB\n` +
        `Node ${d.nodeVersion} | up ${Math.floor(d.uptimeSec/3600)}h ${Math.floor((d.uptimeSec%3600)/60)}m`;
}

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active')); document.getElementById(`nav-${tab}`).classList.add('active');
    ['dash','users','logs','settings','bundles','proxies','freegames','statistics','faq'].forEach(v => document.getElementById(`view-${v}`).style.display='none');
    document.getElementById(`view-${tab}`).style.display='block';
    if(tab==='dash') fetchAccounts(); if(tab==='users') fetchUsers(); if(tab==='logs') fetchLogs(); if(tab==='settings') renderSettings(); if(tab==='bundles') fetchBundlesView(); if(tab==='proxies') fetchProxiesView(); if(tab==='freegames') renderFreeGamesView(); if(tab==='statistics') { renderStatisticsView(); renderHoursChart(); } if(tab==='faq') renderFaqView();
    if (window.innerWidth <= 768) {
        document.querySelector('.sidebar .menu').classList.remove('mobile-visible');
        document.querySelector('.sidebar-footer').classList.remove('mobile-visible');
    }
}

function renderStatisticsView() {
    const total = cachedAccounts.length;
    const withGuard = cachedAccounts.filter(a => a.hasSharedSecret).length;
    const withoutGuard = total - withGuard;
    
    document.getElementById('statsTotal').innerText = total;
    document.getElementById('statsGuardYes').innerText = withGuard;
    document.getElementById('statsGuardNo').innerText = withoutGuard;
    
    const list = document.getElementById('noGuardList');
    const noGuardAccs = cachedAccounts.filter(a => !a.hasSharedSecret);
    
    if (noGuardAccs.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted);">All accounts have Steam Guard enabled.</p>';
    } else {
        list.innerHTML = noGuardAccs.map(a => `<div class="tag" style="background:var(--bg-secondary);border:1px solid var(--border);padding:5px 10px;border-radius:4px;">${esc(a.username)}</div>`).join('');
    }

    const running = cachedAccounts.filter(a => a.status === 'Running').length;
    const errored = cachedAccounts.filter(a => a.status === 'Error' || a.status.includes('Rate Limit') || a.status === 'Need Guard').length;
    const stopped = total - running - errored;
    const ctx = document.getElementById('statusChart').getContext('2d');
    if (typeof Chart === 'undefined') return;
    
    if (statusChartInstance) {
        // This runs on every poll while the tab is open; don't re-animate the chart
        // when nothing moved.
        const prev = statusChartInstance.data.datasets[0].data;
        if (prev[0] === running && prev[1] === stopped && prev[2] === errored) return;
        statusChartInstance.data.datasets[0].data = [running, stopped, errored];
        statusChartInstance.update();
        return;
    }
    
    statusChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: ['Running', 'Stopped', 'Errored'],
            datasets: [{ data: [running, stopped, errored], backgroundColor: ['#4ade80', '#ef4444', '#facc15'], borderWidth: 0 }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af' } } }
        }
    });
}

let hoursChartInstance = null;
async function renderHoursChart() {
    const canvas = document.getElementById('hoursChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const d = await apiCall('/api/history', 'POST', {});
    if (!d || !Array.isArray(d.series)) return;

    const labels = d.series.map(p => p.date);
    const values = d.series.map(p => p.hours);

    if (hoursChartInstance) {
        hoursChartInstance.data.labels = labels;
        hoursChartInstance.data.datasets[0].data = values;
        hoursChartInstance.update();
        return;
    }
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, 'rgba(124,92,255,.35)');
    grad.addColorStop(1, 'rgba(124,92,255,0)');
    hoursChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{
            label: 'Total hours', data: values,
            borderColor: '#7c5cff', backgroundColor: grad,
            fill: true, tension: .3, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2
        }]},
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#6f7690', maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(255,255,255,.06)' }, ticks: { color: '#6f7690' } }
            }
        }
    });
}

async function downloadBackup() {
    const d = await apiCall('/api/backup');
    if (!d) return;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bruddibooster-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Backup downloaded (${d.accounts.length} accounts)`, 'fa-download');
}

async function restoreBackup(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch (e) { showToast('That file is not valid JSON.', 'fa-triangle-exclamation'); return; }
    if (!backup || backup.version !== 1 || !Array.isArray(backup.accounts)) {
        showToast('That does not look like a BruddiBooster backup.', 'fa-triangle-exclamation'); return;
    }
    if (!await showConfirm(`Restore settings for ${backup.accounts.length} accounts? This overwrites categories, games, schedules and proxies. Credentials are not affected.`)) return;
    const r = await apiCall('/api/restore', 'POST', { backup });
    if (!r || !r.success) { showToast('Restore failed.', 'fa-triangle-exclamation'); return; }
    showToast(`Restored ${r.updated} accounts${r.missing.length ? `, ${r.missing.length} not found` : ''}`, 'fa-check');
    fetchAccounts();
}

// Small helpers replacing what used to be inline expressions in the markup.
function hideEl(id) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function pickRestoreFile() { document.getElementById('restoreFile').click(); }
function toggleScheduleFields() {
    const on = document.getElementById('editScheduleEnabled').checked;
    document.getElementById('scheduleFields').style.display = on ? 'flex' : 'none';
}

function renderFaqView() {
    const codes = [
        { code: 5, name: 'InvalidPassword', desc: 'Your password is incorrect. Please update it in the dashboard.' },
        { code: 6, name: 'LoggedInElsewhere', desc: 'This account is logged in somewhere else (or you launched the game on your PC). The bot will reconnect automatically.' },
        { code: 43, name: 'VACCheckTimedOut', desc: 'Often indicates a "zombie" session or account issue. The system will automatically disable accounts with this error to prevent loops. Try changing the password or logging in manually.' },
        { code: 63, name: 'AccountLogonDenied', desc: 'Steam Guard is required. Check your email for the code.' },
        { code: 84, name: 'RateLimitExceeded', desc: 'Too many login attempts from this IP. The bot will pause for 5 minutes and retry.' },
        { code: 65, name: 'TwoFactorCodeMismatch', desc: 'The shared secret is wrong or expired. The bot stops and asks you to update it.' },
        { code: 87, name: 'InvalidLoginAuthCode', desc: 'The Steam Guard code was invalid or expired. The bot stops cleanly rather than retrying.' },
        { code: 88, name: 'AccountLogonDeniedNoMail', desc: 'Steam Guard needed but no email was sent. Usually means you need to log in manually once.' }
    ];

    const faqs = [
        { q: "Why are my accounts stopping?", a: "Check the 'Last Error' column or the Logs tab. Common reasons include invalid passwords, Steam Guard requirements, or Steam server issues." },
        { q: "What does Error 43 mean?", a: "It's a generic Steam error often related to connection issues or account flags. BruddiBooster disables these accounts automatically to prevent infinite restart loops." },
        { q: "How do I add proxies?", a: "Go to the 'Proxies' tab. You can assign a proxy to each account individually or use the Bulk Import tool." },
        { q: "Can I farm more than 32 games?", a: "Yes! If you add more than 32 games to an account, the bot will automatically rotate through them in batches every hour." },
        { q: "Why can't I add some free games?", a: "Some games are region-locked. If the bot says 'Possible Region Lock', the game is likely not available in the account's store country." },
        { q: "An account says Running but the hours aren't going up.", a: "Check for a 'Blocked' badge. Steam only lets one session play at a time, so launching a game on your own PC silently takes the session from the bot. Enable 'Reclaim session' on that account if you want the bot to take it back automatically." },
        { q: "Why do I keep getting rate limited?", a: "Too many logins from one IP. Assign proxies in the Proxies tab, and note that after the first successful login each account signs in with a saved token instead of its password, which cuts login volume a lot." },
        { q: "What does 'Boosted' actually measure?", a: "Hours the account has gained since this panel first saw it, taken from Steam's own playtime figures. It is not an estimate based on uptime." },
        { q: "Is my backup file safe to store anywhere?", a: "Yes. Backups contain settings, games, schedules and history but never passwords, shared secrets or login tokens." }
    ];

    const features = [
        { i: 'fa-gamepad', t: 'Game idling', d: "Pick the games an account should idle. Steam credits playtime for anything the account owns and 'plays', which is what accrues hours.", w: 'Dashboard > gamepad button on a row' },
        { i: 'fa-rotate', t: 'Game rotation', d: HINTS.rotation, w: 'Automatic above 32 games' },
        { i: 'fa-layer-group', t: 'Bundles', d: HINTS.bundle, w: 'Bundles tab' },
        { i: 'fa-gift', t: 'Free games', d: HINTS.freeGames, w: 'Free Games tab' },
        { i: 'fa-bolt', t: 'Auto-start', d: HINTS.autoStart, w: "Edit account" },
        { i: 'fa-clock', t: 'Schedules', d: HINTS.schedule, w: 'Edit account > Only boost during set hours' },
        { i: 'fa-shield-halved', t: 'Reclaim session', d: HINTS.autoReclaim, w: 'Edit account > Reclaim session' },
        { i: 'fa-network-wired', t: 'Per-account proxies', d: HINTS.proxy, w: 'Proxies tab' },
        { i: 'fa-earth-americas', t: 'Global proxy pool', d: HINTS.proxyPool, w: 'Proxies tab > Global Proxy Pool' },
        { i: 'fa-user-plus', t: 'Auto-accept friends', d: HINTS.autoAccept, w: 'Edit account' },
        { i: 'fa-user', t: 'Persona state', d: HINTS.personaState, w: 'Manage games dialog' },
        { i: 'fa-pen', t: 'Custom status', d: HINTS.customStatus, w: 'Manage games dialog' },
        { i: 'fa-key', t: 'Token sign-in', d: HINTS.refreshToken, w: 'Automatic after the first login' },
        { i: 'fa-chart-line', t: 'Hours tracking', d: "Hours come from Steam's own playtime, not an estimate. 'Boosted' is what the account has gained since the panel first saw it; the Statistics tab charts the daily trend.", w: 'Statistics tab' },
        { i: 'fa-triangle-exclamation', t: 'Needs attention', d: "Filters the account list to anything that isn't quietly running \u2014 errors, Guard prompts, rate limits, VAC bans and blocked sessions \u2014 so you can find problems without scrolling.", w: 'Dashboard > filter chips' },
        { i: 'fa-memory', t: 'Resource monitor', d: HINTS.heap, w: 'Sidebar' },
        { i: 'fa-floppy-disk', t: 'Backup & restore', d: HINTS.backup, w: 'Settings tab' },
        { i: 'fa-terminal', t: 'Logs', d: 'Live log stream, filterable by text and by account. Errors from Steam and from the panel itself both appear here.', w: 'Logs tab' },
        { i: 'fa-lock', t: 'Panel 2FA', d: 'Time-based 2FA on the panel login itself, separate from any Steam Guard on the bot accounts. Exporting credentials also requires a fresh code.', w: 'Settings tab' }
    ];
    document.getElementById('faqFeatures').innerHTML = features.map(f => `
        <div class="feature-card">
            <h4><i class="fa-solid ${f.i}"></i> ${esc(f.t)}</h4>
            <p>${esc(f.d)}</p>
            <span class="where"><i class="fa-solid fa-location-dot"></i> ${esc(f.w)}</span>
        </div>`).join('');

    document.getElementById('faqCodesBody').innerHTML = codes.map(c => `<tr><td><span class="tag" style="background:var(--bg-input);">${c.code}</span></td><td style="font-weight:600;color:var(--accent);">${c.name}</td><td style="color:var(--text-muted);">${c.desc}</td></tr>`).join('');
    
    document.getElementById('faqList').innerHTML = faqs.map(f => `
        <div style="background:var(--bg-input);padding:15px;border-radius:8px;border:1px solid var(--border);">
            <div style="font-weight:600;color:var(--text-main);margin-bottom:5px;"><i class="fa-solid fa-q"></i> ${f.q}</div>
            <div style="color:var(--text-muted);font-size:14px;line-height:1.4;">${f.a}</div>
        </div>
    `).join('');
}

async function logout() { await apiCall('/api/logout', 'POST'); authToken = null; location.reload(); } // the server clears the httpOnly cookie
async function handleAction(action, username) { showToast(`${action} ${username}...`, 'fa-gear'); await apiCall(`/api/${action}`, 'POST', { username }); fetchAccounts(); }

// RENDER SETTINGS based on 2FA status
function renderSettings() {
    const area = document.getElementById('2fa-content-area');
    fetchGlobalSettings();
    
    const currentTheme = localStorage.getItem('theme') || 'dark';
    const toggle = document.getElementById('themeToggle');
    if(toggle) toggle.checked = currentTheme === 'light';

    if (userHas2FA) {
        area.innerHTML = `
            <div class="status-active-2fa"><i class="fa-solid fa-check-circle"></i> 2FA is Active. Account Secured.</div>
            <button class="primary-btn btn-stop-action" ${act('disable2FA')}><i class="fa-solid fa-ban"></i> Disable 2FA</button>
        `;
    } else {
        area.innerHTML = `
            <p class="status-inactive-2fa">Protect your admin panel with Google Authenticator.</p>
            <button class="primary-btn" ${act('start2FASetup')}><i class="fa-solid fa-shield-halved"></i> Setup 2FA</button>
        `;
    }
}

async function fetchGlobalSettings() {
    const s = await apiCall('/api/settings');
    if(s) document.getElementById('discordWebhook').value = s.discordWebhook || '';
    if(s) document.getElementById('rotationInterval').value = s.rotationInterval || 60;
}

async function saveGlobalSettings() {
    const url = document.getElementById('discordWebhook').value.trim();
    const interval = parseInt(document.getElementById('rotationInterval').value) || 60;
    await apiCall('/api/settings', 'POST', { discordWebhook: url, rotationInterval: interval });
    showToast('Settings Saved', 'fa-check');
}

async function testWebhook() {
    const url = document.getElementById('discordWebhook').value.trim();
    if(!url) return alert("Enter a Webhook URL first");
    await apiCall('/api/settings/test_webhook', 'POST', { discordWebhook: url });
    showToast('Test Sent', 'fa-paper-plane');
}

async function disable2FA() {
    if(await showConfirm("Disable 2FA?")) {
        const res = await apiCall('/api/settings/2fa/disable', 'POST');
        if(res && res.success) { userHas2FA = false; renderSettings(); showToast('2FA Disabled', 'fa-shield-halved'); }
    }
}

function toggleProxyCategory(id) {
    const body = document.getElementById(`proxy-cat-body-${id}`);
    const icon = document.getElementById(`proxy-cat-icon-${id}`);
    const isHidden = body.classList.contains('hidden');
    if (isHidden) { body.classList.remove('hidden'); icon.classList.remove('rotated'); categoryStates[`proxy-${id}`] = true; }
    else { body.classList.add('hidden'); icon.classList.add('rotated'); categoryStates[`proxy-${id}`] = false; }
}

function toggleCategory(id) {
    const body = document.getElementById(`cat-body-${id}`);
    const icon = document.getElementById(`cat-icon-${id}`);
    const isHidden = body.classList.contains('hidden');
    if (isHidden) { body.classList.remove('hidden'); icon.classList.remove('rotated'); categoryStates[id] = true; }
    else { body.classList.add('hidden'); icon.classList.add('rotated'); categoryStates[id] = false; }
}

function toggleFreeGameCategory(id) {
    const body = document.getElementById(`free-cat-body-${id}`);
    const icon = document.getElementById(`free-cat-icon-${id}`);
    const isHidden = body.classList.contains('hidden');
    if (isHidden) { body.classList.remove('hidden'); icon.classList.remove('rotated'); categoryStates[`free-${id}`] = true; }
    else { body.classList.add('hidden'); icon.classList.add('rotated'); categoryStates[`free-${id}`] = false; }
}

function toggleHideOwned() {
    hideOwnedAccounts = !hideOwnedAccounts;
    const btn = document.getElementById('btnHideOwned');
    if (hideOwnedAccounts) {
        btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--accent)';
    } else {
        btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = '';
    }
    renderFreeAccountsUI();
}

function toggleFreeGameCategorySelect(cb, catName) {
    const accountsInCat = cachedAccounts.filter(a => (a.category || 'Default') === catName);
    
    let targetAccounts = accountsInCat;
    if (hideOwnedAccounts && selectedFreeGames.length > 0) {
        targetAccounts = accountsInCat.filter(a => !selectedFreeGames.every(gid => (a.ownedGames || []).includes(gid)));
    }

    const usernames = targetAccounts.map(a => a.username);
    if (cb.checked) {
        usernames.forEach(u => { if (!selectedFreeAccounts.includes(u)) selectedFreeAccounts.push(u); });
    } else {
        selectedFreeAccounts = selectedFreeAccounts.filter(u => !usernames.includes(u));
    }
    renderFreeAccountsUI();
}

function getStatusHtml(acc) {
    const isRunning = acc.status === 'Running';
    if(isRunning) {
        let html = `<span class="st-running">Running</span>`;
        if (acc.nextRotation) {
            const diff = acc.nextRotation - Date.now();
            if (diff > 0) {
                const mins = Math.ceil(diff / 60000);
                html += `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;"><i class="fa-solid fa-clock-rotate-left"></i> Next: ${mins}m</div>`;
            }
        }
        return html;
    }
    if(acc.status && acc.status.startsWith('Blocked')) return `<span class="st-blocked" data-hint="${esc((acc.lastError ? acc.lastError + ' ' : '') + HINTS.blocked)}">Blocked</span>`;
    if(acc.status === 'Playing elsewhere') {
        // Show the countdown so it reads as "waiting to resume", not "broken".
        let sub = '';
        if (acc.nextRetry) {
            const diff = acc.nextRetry - Date.now();
            if (diff > 0) {
                const mins = Math.ceil(diff / 60000);
                sub = `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;"><i class="fa-solid fa-clock-rotate-left"></i> Resumes in ${mins}m</div>`;
            }
        }
        return `<span class="st-elsewhere" data-hint="${esc(HINTS.elsewhere)}">In use</span>${sub}`;
    }
    if(acc.status==='Need Guard') return `<span class="st-guard">Guard</span>`;
    if(acc.status==='Logging in...') return `<span class="st-logging">Logging in...</span>`;
    if(acc.status.includes('Rate Limit')) return `<span class="st-guard" style="cursor:help;" title="${esc(acc.lastError||'')}">${esc(acc.status)}</span>`;
    if (acc.status === 'Error' && acc.lastError) return `<span class="st-stopped" style="cursor:help;" title="${esc(acc.lastError)}">ERROR</span>`;
    return `<span class="st-stopped">${esc(acc.status)}</span>`;
}

function getActionsHtml(acc) {
    const isRunning = acc.status === 'Running';
    const gamesJson = esc(JSON.stringify(acc.games));
    const u = jsArg(acc.username);
    const profileBtn = acc.steamId ? `<a href="https://steamcommunity.com/profiles/${encodeURIComponent(acc.steamId)}" target="_blank" class="icon-btn" title="View Steam Profile"><i class="fa-solid fa-up-right-from-square"></i></a>` : '';

    const gameCountDisplay = acc.games.length > 32
        ? `${acc.games.length} <span class="rot-badge">rot</span>`
        : `${acc.games.length}/32`;

    return `${isRunning?`<button class="icon-btn btn-stop-action" title="Stop Bot" ${act('handleAction', 'stop', acc.username)}><i class="fa-solid fa-stop"></i></button><button class="icon-btn" title="Restart Bot" ${act('handleAction', 'restart', acc.username)}><i class="fa-solid fa-rotate-right"></i></button>`:`<button class="icon-btn btn-play" title="Start Bot" ${act('handleAction', 'start', acc.username)}><i class="fa-solid fa-play"></i></button>`}<button class="icon-btn" style="width:auto;padding:0 12px;gap:6px;" title="Manage Games" ${act('openGamesModal', acc.username, acc.games, acc.customStatus||'', Number(acc.personaState))}><i class="fa-solid fa-gamepad"></i> <span style="font-size:11px;font-weight:600;">${gameCountDisplay}</span></button><button class="icon-btn" title="Boost Statistics" ${act('openStats', acc.addedAt, Number(acc.boostedHours))}><i class="fa-solid fa-chart-line"></i></button>${profileBtn}<button class="icon-btn" title="Edit Account Details" ${act('openEditModal', acc.username, acc.category||'', !!acc.autoStart)}><i class="fa-solid fa-pen"></i></button><button class="icon-btn btn-trash" title="Delete Account" ${act('deleteAccount', acc.username)}><i class="fa-solid fa-trash"></i></button>${acc.status==='Need Guard'?`<button class="icon-btn" style="color:var(--status-yellow);border-color:var(--status-yellow);" title="Enter Steam Guard" ${act('openGuard', acc.username)}><i class="fa-solid fa-key"></i></button>`:''}`;
}

window.sortAccounts = function(col) {
    if (currentSort.column === col) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = col;
        currentSort.direction = 'desc'; // Default to desc for numbers usually
    }
    applyAccountFilter();
}

function renderTable(accounts) {
    document.getElementById('totalAccounts').innerText = accounts.length;
    document.getElementById('activeBoosters').innerText = accounts.filter(a => a.status==='Running').length;
    document.getElementById('totalHours').innerText = accounts.reduce((a,c) => a + parseFloat(c.grandTotal||0), 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'h';

    const groups = {};
    accounts.forEach(acc => { const cat = acc.category || 'Default'; if(!groups[cat]) groups[cat] = []; groups[cat].push(acc); });
    
    if (currentSort.column) {
        for (const cat in groups) {
            groups[cat].sort((a, b) => {
                let valA = currentSort.column === 'hours' ? parseFloat(a.grandTotal) : a.status;
                let valB = currentSort.column === 'hours' ? parseFloat(b.grandTotal) : b.status;
                if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
                if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }
    }

    const sortedCats = Object.keys(groups).sort((a,b) => { if(a==='Default') return -1; if(b==='Default') return 1; return a.localeCompare(b); });

    const existingAccountRows = document.querySelectorAll('tr[id^="tr-"]');
    const existingCategoryHeaders = document.querySelectorAll('.category-header');

    const rebuild = existingAccountRows.length !== accounts.length ||
                    existingCategoryHeaders.length !== sortedCats.length;

    if (!rebuild) {
        // Partial update logic
        accounts.forEach(acc => {
            const row = document.getElementById(`tr-${acc.username}`);
            if (row) {
                const newStatus = getStatusHtml(acc); if (row.cells[2].innerHTML !== newStatus) row.cells[2].innerHTML = newStatus;
                const newHours = `${parseFloat(acc.grandTotal).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h`; if (row.cells[3].innerText !== newHours) row.cells[3].innerText = newHours;
                const hasStopBtn = row.querySelector('.btn-stop-action'); const isRunning = acc.status === 'Running';
                if ((isRunning && !hasStopBtn) || (!isRunning && hasStopBtn)) row.cells[5].innerHTML = `<div class="actions">${getActionsHtml(acc)}</div>`;
            }
        });

        // Re-order rows and update category headers
        sortedCats.forEach((cat, index) => {
            const safeId = index;
            const tbody = document.getElementById(`tbody-${safeId}`);
            if (tbody) {
                groups[cat].forEach(acc => {
                    const row = document.getElementById(`tr-${acc.username}`);
                    if (row) {
                        tbody.appendChild(row);
                    }
                });
                const header = document.querySelector(`#cat-icon-${safeId}`).parentElement;
                if(header) {
                    header.querySelector('span > span').innerText = `(${groups[cat].length})`;
                }
            }
        });

        return;
    }

    const container = document.getElementById('accountsContainer'); container.innerHTML = '';

    sortedCats.forEach((cat, index) => {
        const safeId = index;
        const isExpanded = categoryStates[safeId] !== undefined ? categoryStates[safeId] : true;
        const section = document.createElement('div');
        
        const getSortIcon = (col) => {
            if (currentSort.column !== col) return '<i class="fa-solid fa-sort" style="color:var(--text-muted);font-size:10px;margin-left:5px;"></i>';
            return currentSort.direction === 'asc' ? '<i class="fa-solid fa-sort-up" style="color:var(--accent);font-size:10px;margin-left:5px;"></i>' : '<i class="fa-solid fa-sort-down" style="color:var(--accent);font-size:10px;margin-left:5px;"></i>';
        };

        section.className = 'category-section';
        section.innerHTML = `<div class="category-header" ${act('toggleCategory', safeId)}><span><i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${esc(cat)} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="cat-body-${safeId}"><div class="panel"><table><thead><tr><th style="width:40px;text-align:center;"><input type="checkbox" ${act('toggleCategorySelect', '$this', safeId).replace('data-act=','data-act-change=')}></th><th>User</th><th ${act('sortAccounts', 'status')} style="cursor:pointer">Status ${getSortIcon('status')}</th><th ${act('sortAccounts', 'hours')} style="cursor:pointer">Hours ${getSortIcon('hours')}</th><th>IP</th><th>Actions</th></tr></thead><tbody id="tbody-${safeId}"></tbody></table></div></div>`;
        container.appendChild(section);
        const tbody = document.getElementById(`tbody-${safeId}`);
        groups[cat].forEach(acc => tbody.appendChild(createAccountRow(acc)));
    });
}

function createAccountRow(acc) {
        const avatarUrl = acc.avatarHash ? `https://avatars.steamstatic.com/${acc.avatarHash}_full.jpg` : 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
        const autoStartIcon = acc.autoStart ? `<i class="fa-solid fa-bolt autostart-icon" title="Auto-start Enabled"></i>` : '';
        const flagIcons =
            (acc.vacBanned ? `<i class="fa-solid fa-ban acc-flag danger" title="VAC banned"></i>` : '') +
            (acc.locked ? `<i class="fa-solid fa-lock acc-flag danger" title="Account locked by Steam"></i>` : '') +
            (acc.limited ? `<i class="fa-solid fa-triangle-exclamation acc-flag warn" title="Limited account"></i>` : '') +
            (acc.usingRefreshToken ? `<i class="fa-solid fa-key acc-flag ok" data-hint="${esc(HINTS.refreshToken)}"></i>` : '');
        const tr = document.createElement('tr');
        tr.id = `tr-${acc.username}`;
        tr.dataset.category = acc.category || 'Default';
        const showEye = (acc.ip && acc.ip !== "Server IP" && acc.ip !== "Loading...") ? '' : 'style="display:none;"';
        tr.innerHTML = `<td style="text-align:center;"><input type="checkbox" class="acc-select" value="${esc(acc.username)}" ${selectedAccounts.has(acc.username) ? 'checked' : ''} ${act('onAccSelect', '$this').replace('data-act=','data-act-change=')}></td><td><div class="user-cell"><img src="${esc(avatarUrl)}" class="user-avatar" alt="Avatar"><div class="user-details"><div><span class="user-nick">${esc(acc.nickname||acc.username)}</span>${autoStartIcon}${flagIcons}</div><span class="user-name">${esc(acc.username)}</span></div></div></td><td>${getStatusHtml(acc)}</td><td style="color:var(--text-main);font-weight:600;">${parseFloat(acc.grandTotal).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h</td><td><div class="ip-cell"><span data-ip="${esc(acc.ip)}">${esc(maskIp(acc.ip))}</span><i class="fa-solid fa-eye ip-icon" ${act('toggleIp', '$this')} ${showEye}></i></div></td><td><div class="actions">${getActionsHtml(acc)}</div></td>`;
        return tr;
}

// 'Needs attention' is the view you actually want when something breaks: everything
// that isn't quietly running, with its error visible.
function isHealthy(a) { return a.status === 'Running' && !a.playBlocked; }
// Blocked counts as needing attention: the bot looks alive but earns nothing.
function needsAttention(a) {
    // "In use" is expected and self-healing, so it isn't a problem to chase.
    if (a.status === 'Playing elsewhere') return false;
    if (a.playBlocked || a.vacBanned || a.locked) return true;
    return a.status !== 'Running' && a.status !== 'Stopped';
}

function applyAccountFilter() {
    const q = document.getElementById('accountSearch').value.toLowerCase();
    let filtered = cachedAccounts.filter(a =>
        a.username.toLowerCase().includes(q) || (a.nickname || '').toLowerCase().includes(q));

    if (statusFilter === 'running') filtered = filtered.filter(isHealthy);
    else if (statusFilter === 'stopped') filtered = filtered.filter(a => a.status === 'Stopped');
    else if (statusFilter === 'attention') filtered = filtered.filter(needsAttention);

    renderTable(filtered);
    renderFilterChips();
}

function setStatusFilter(f) { statusFilter = f; applyAccountFilter(); }

function renderFilterChips() {
    const el = document.getElementById('statusFilterBar');
    if (!el) return;
    const counts = {
        all: cachedAccounts.length,
        running: cachedAccounts.filter(isHealthy).length,
        attention: cachedAccounts.filter(needsAttention).length,
        stopped: cachedAccounts.filter(a => a.status === 'Stopped').length
    };
    const chip = (key, label, tone) =>
        `<button class="filter-chip ${statusFilter === key ? 'active' : ''} ${tone || ''}" ${act('setStatusFilter', key)}>${label} <span>${counts[key]}</span></button>`;
    el.innerHTML =
        chip('all', 'All') +
        chip('running', 'Running', 'ok') +
        chip('attention', 'Needs attention', counts.attention ? 'warn' : '') +
        chip('stopped', 'Stopped');
}

// Applies a fresh account list to whatever view is open. Called by the socket push
// and by the REST fallback.
function applyAccounts(d) {
    if (!d) return;
    cachedAccounts = d;
    if (activeTab === 'dash') applyAccountFilter();
    else if (activeTab === 'freegames') renderFreeAccountsUI();
    else if (activeTab === 'statistics') renderStatisticsView();
}

async function fetchAccounts() { applyAccounts(await apiCall('/api/accounts')); }
async function fetchLogs() { const d = await apiCall('/api/logs'); if (d) cachedLogs = d; renderLogs(); }
async function fetchUsers() { const u = await apiCall('/api/users'); document.getElementById('usersTableBody').innerHTML = u.map(x=>`<tr><td style="color:var(--text-main);">${esc(x.username)}</td><td style="color:#888;">${esc(x.role)}</td><td>${x.role!=='admin'?`<button class="icon-btn btn-trash" ${act('delUser', x.username)}><i class="fa-solid fa-trash"></i></button>`:''}</td></tr>`).join(''); }

function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none'); }
function showConfirm(msg, title="Confirmation") {
    document.getElementById('confirmTitle').innerText = title;
    document.getElementById('confirmMessage').innerText = msg;
    document.getElementById('confirmModal').style.display = 'flex';
    return new Promise(resolve => { confirmResolver = resolve; });
}
function resolveConfirm(res) {
    document.getElementById('confirmModal').style.display = 'none';
    if(confirmResolver) { confirmResolver(res); confirmResolver = null; }
}
function openAddModal() { document.getElementById('newUsername').value=''; document.getElementById('newPassword').value=''; document.getElementById('newCategory').value=''; document.getElementById('newAutoStart').checked=false; document.getElementById('addModal').style.display='flex'; }
async function openBulkModal() { document.getElementById('bulkData').value=''; document.getElementById('bulkCategory').value=''; document.getElementById('bulkAutoStart').checked=false; document.getElementById('bulkProxyWait').checked=false; const b = await apiCall('/api/bundles'); const s = document.getElementById('bulkBundle'); s.innerHTML='<option value="">Default (CS2)</option><option value="none">No Games (Online Only)</option>'; for(const k in b) { const o=document.createElement('option'); o.value=k; o.innerText=`${k} (${b[k].length})`; s.appendChild(o); } document.getElementById('bulkModal').style.display='flex'; }
async function openBulkEditModal() { 
    const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
    setVal('bulkEditCategory', '');
    setVal('bulkEditAutoStart', '');
    setVal('bulkEditProxies', '');
    
    const b = await apiCall('/api/bundles'); 
    const s = document.getElementById('bulkEditBundle'); 
    if (s) {
        s.innerHTML='<option value="">No Change</option><option value="none">Clear Games</option>'; 
        for(const k in b) { const o=document.createElement('option'); o.value=k; o.innerText=`${k} (${b[k].length})`; s.appendChild(o); } 
    }
    document.getElementById('bulkEditModal').style.display='flex'; 
}

async function renderFreeGamesView() {
    cachedBundles = await apiCall('/api/bundles');
    const sel = document.getElementById('freeGamesPresetSelect');
    if(sel) {
        sel.innerHTML = '<option value="">Load Preset...</option>';
        for (const k in cachedBundles) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.innerText = `${k} (${cachedBundles[k].length})`;
            sel.appendChild(opt);
        }
    }
    renderFreeGamesUI();
    renderFreeAccountsUI();
}

function renderFreeGamesUI() {
    const grid = document.getElementById('freeGamesGrid');
    const query = document.getElementById('freeGameSearch').value.toLowerCase();
    const filteredGames = POPULAR_FREE_GAMES.filter(g => g.name.toLowerCase().includes(query));

    const selectedAccsData = cachedAccounts.filter(a => selectedFreeAccounts.includes(a.username));

    grid.innerHTML = filteredGames.map(g => {
        const isSel = selectedFreeGames.includes(g.id);
        let ownershipBadge = '';
        if (selectedAccsData.length > 0) {
            const ownedCount = selectedAccsData.filter(a => (a.ownedGames || []).includes(g.id)).length;
            if (ownedCount === selectedAccsData.length) {
                ownershipBadge = `<div style="position:absolute;top:5px;right:5px;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:bold;z-index:2;background:var(--status-green);color:#fff;"><i class="fa-solid fa-check"></i> Owned</div>`;
            } else if (ownedCount > 0) {
                ownershipBadge = `<div style="position:absolute;top:5px;right:5px;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:bold;z-index:2;background:var(--status-yellow);color:#000;">${ownedCount}/${selectedAccsData.length} Owned</div>`;
            }
        }
        return `<div class="game-card ${isSel?'selected':''}" ${act('toggleFreeGame', Number(g.id))}><img src="https://steamcdn-a.akamaihd.net/steam/apps/${Number(g.id)}/capsule_sm_120.jpg" data-hide-on-error="1"><div class="game-card-overlay"><div class="game-card-title">${esc(g.name)}</div></div>${ownershipBadge}<div class="game-check"><i class="fa-solid fa-check"></i></div></div>`;
    }).join('');
}

function renderFreeAccountsUI() {
    const grid = document.getElementById('freeAccountsGrid');
    document.getElementById('freeAccCount').innerText = selectedFreeAccounts.length;
    grid.innerHTML = '';

    const groups = {};
    cachedAccounts.forEach(acc => { 
        if (hideOwnedAccounts && selectedFreeGames.length > 0) {
            const ownsAll = selectedFreeGames.every(gid => (acc.ownedGames || []).includes(gid));
            if (ownsAll) return;
        }
        const cat = acc.category || 'Default'; if(!groups[cat]) groups[cat] = []; groups[cat].push(acc); 
    });
    const sortedCats = Object.keys(groups).sort((a,b) => { if(a==='Default') return -1; if(b==='Default') return 1; return a.localeCompare(b); });

    sortedCats.forEach((cat, index) => {
        const safeId = index;
        const isExpanded = categoryStates[`free-${safeId}`] !== undefined ? categoryStates[`free-${safeId}`] : true;
        const accountsInCat = groups[cat];
        const allSelected = accountsInCat.every(a => selectedFreeAccounts.includes(a.username));
        const section = document.createElement('div');
        section.className = 'category-section';
        section.innerHTML = `<div class="category-header" ${act('toggleFreeGameCategory', safeId)}><span><input type="checkbox" ${act('toggleFreeGameCategorySelect', '$this', cat)} data-stop="1" ${allSelected?'checked':''} style="margin-right:10px;"> <i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${esc(cat)} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="free-cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="free-cat-body-${safeId}"><div class="account-selector-list">${groups[cat].map(a => {
            const isSel = selectedFreeAccounts.includes(a.username);
            const avatar = a.avatarHash ? `https://avatars.steamstatic.com/${a.avatarHash}_full.jpg` : 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
            
            let ownershipIcon = '';
            if (selectedFreeGames.length > 0) {
                const ownsAll = selectedFreeGames.every(gid => (a.ownedGames || []).includes(gid));
                if (ownsAll) ownershipIcon = '<i class="fa-solid fa-check-double" style="color:var(--status-green);margin-left:auto;font-size:12px;" title="Already owns all selected games"></i>';
            }
            return `<div class="account-select-item ${isSel?'selected':''}" ${act('toggleFreeAccount', a.username)}><img src="${esc(avatar)}"><span class="account-select-name">${esc(a.username)}</span>${ownershipIcon}</div>`;
        }).join('')}</div></div>`;
        grid.appendChild(section);
    });
}

window.toggleFreeGame = function(id) {
    if(selectedFreeGames.includes(id)) selectedFreeGames = selectedFreeGames.filter(x => x !== id);
    else selectedFreeGames.push(id);
    renderFreeGamesUI();
    renderFreeAccountsUI();
}
window.toggleAllFreeGames = function() {
    const query = document.getElementById('freeGameSearch').value.toLowerCase();
    const visibleGames = POPULAR_FREE_GAMES.filter(g => g.name.toLowerCase().includes(query)).map(g => g.id);
    const allVisibleSelected = visibleGames.every(id => selectedFreeGames.includes(id));
    if (allVisibleSelected) {
        selectedFreeGames = selectedFreeGames.filter(id => !visibleGames.includes(id));
    } else {
        visibleGames.forEach(id => { if (!selectedFreeGames.includes(id)) selectedFreeGames.push(id); });
    }
    renderFreeGamesUI();
    renderFreeAccountsUI();
}
window.toggleFreeAccount = function(u) {
    if(selectedFreeAccounts.includes(u)) selectedFreeAccounts = selectedFreeAccounts.filter(x => x !== u);
    else selectedFreeAccounts.push(u);
    renderFreeAccountsUI();
    renderFreeGamesUI();
}
window.toggleAllFreeAccounts = function() {
    let visibleAccounts = cachedAccounts;
    if (hideOwnedAccounts && selectedFreeGames.length > 0) {
        visibleAccounts = cachedAccounts.filter(a => !selectedFreeGames.every(gid => (a.ownedGames || []).includes(gid)));
    }
    const visibleUsernames = visibleAccounts.map(a => a.username);
    const allSelected = visibleUsernames.length > 0 && visibleUsernames.every(u => selectedFreeAccounts.includes(u));

    if(allSelected) selectedFreeAccounts = selectedFreeAccounts.filter(u => !visibleUsernames.includes(u));
    else visibleUsernames.forEach(u => { if(!selectedFreeAccounts.includes(u)) selectedFreeAccounts.push(u); });
    
    renderFreeAccountsUI();
}

window.loadFreeGamesPreset = function() {
    const name = document.getElementById('freeGamesPresetSelect').value;
    if (!name || !cachedBundles || !cachedBundles[name]) return;
    selectedFreeGames = cachedBundles[name].map(g => g.id);
    renderFreeGamesUI();
    renderFreeAccountsUI();
}

window.saveFreeGamesPreset = async function() {
    if (selectedFreeGames.length === 0) return alert("No games selected to save.");
    const name = prompt("Enter name for this preset:");
    if (!name) return;
    await apiCall('/api/bundles', 'POST', { name, games: selectedFreeGames });
    showToast("Preset saved!", "fa-check");
    renderFreeGamesView();
}

function openUserModal() { document.getElementById('friendUser').value=''; document.getElementById('friendPass').value=''; document.getElementById('addUserModal').style.display='flex'; }
function openGuard(u) { document.getElementById('guardUsername').value = u; document.getElementById('guardModal').style.display = 'flex'; }
function openStats(date, hours) { document.getElementById('statAdded').innerText = new Date(parseInt(date)).toLocaleDateString(); document.getElementById('statBoosted').innerText = parseFloat(hours).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); document.getElementById('statsModal').style.display = 'flex'; }


async function openEditModal(u, cat, auto) { const d = await apiCall('/api/get_account', 'POST', { username: u }); document.getElementById('editOldUsername').value = d.username; document.getElementById('editUsername').value = d.username; document.getElementById('editPassword').value = ''; document.getElementById('editPassword').placeholder = '(Unchanged)'; document.getElementById('editSharedSecret').value = ''; document.getElementById('editSharedSecret').placeholder = d.hasSharedSecret ? '(Unchanged)' : 'None set'; document.getElementById('editProxy').value = d.proxy || ''; document.getElementById('editCategory').value = d.category || cat; document.getElementById('editAutoStart').checked = d.autoStart; document.getElementById('editAutoReclaim').checked = !!d.autoReclaim;
    document.getElementById('editScheduleEnabled').checked = !!d.scheduleEnabled;
    document.getElementById('editScheduleStart').value = d.scheduleStart || '22:00';
    document.getElementById('editScheduleEnd').value = d.scheduleEnd || '06:00';
    document.getElementById('scheduleFields').style.display = d.scheduleEnabled ? 'flex' : 'none'; document.getElementById('editModal').style.display = 'flex'; }
async function addAccount() { await apiCall('/api/accounts', 'POST', { username: document.getElementById('newUsername').value, password: document.getElementById('newPassword').value, sharedSecret: document.getElementById('newSharedSecret').value, category: document.getElementById('newCategory').value, autoStart: document.getElementById('newAutoStart').checked }); closeModals(); fetchAccounts(); }
async function bulkAddAccounts() { const data = document.getElementById('bulkData').value; const cat = document.getElementById('bulkCategory').value; let auto = document.getElementById('bulkAutoStart').checked; const wait = document.getElementById('bulkProxyWait').checked; const bundle = document.getElementById('bulkBundle').value; if(wait) auto = false; const res = await apiCall('/api/accounts/bulk', 'POST', { data, category: cat, autoStart: auto, bundle }); if(res && res.success) { showToast(`Imported ${res.count} accounts${res.skipped > 0 ? ` (${res.skipped} skipped)` : ''}${wait ? '. Add proxies now.' : ''}`, 'fa-check'); closeModals(); fetchAccounts(); } }
async function saveEdit() { await apiCall('/api/edit', 'POST', { oldUsername: document.getElementById('editOldUsername').value, newUsername: document.getElementById('editUsername').value, newPassword: document.getElementById('editPassword').value, newSharedSecret: document.getElementById('editSharedSecret').value, newCategory: document.getElementById('editCategory').value, newAutoStart: document.getElementById('editAutoStart').checked, newAutoReclaim: document.getElementById('editAutoReclaim').checked,
        newScheduleEnabled: document.getElementById('editScheduleEnabled').checked,
        newScheduleStart: document.getElementById('editScheduleStart').value,
        newScheduleEnd: document.getElementById('editScheduleEnd').value }); closeModals(); fetchAccounts(); }
async function deleteAccount(u) { if(await showConfirm('Delete Account?')) await apiCall('/api/delete', 'POST', { username: u }); fetchAccounts(); }
async function submitGuard() { await apiCall('/api/steamguard', 'POST', { username: document.getElementById('guardUsername').value, code: document.getElementById('guardCode').value }); closeModals(); fetchAccounts(); }
async function addPanelUser() { await apiCall('/api/users', 'POST', { username: document.getElementById('friendUser').value, password: document.getElementById('friendPass').value }); closeModals(); fetchUsers(); }
async function delUser(u) { if(await showConfirm('Delete User?')) await apiCall('/api/users/delete', 'POST', { username: u }); fetchUsers(); }

async function changePassword() { const d = await apiCall('/api/settings/password', 'POST', { currentPass: document.getElementById('setOldPass').value, newPass: document.getElementById('setNewPass').value }); alert(d&&d.success?"Updated":"Error"); }
async function start2FASetup() { const d = await apiCall('/api/settings/2fa/generate', 'POST'); tempSecret = d.secret; document.getElementById('qrCodeContainer').innerHTML = `<img src="${d.qr}" width="150">`; document.getElementById('modal2FA').style.display = 'flex'; }
async function enable2FA() { const d = await apiCall('/api/settings/2fa/enable', 'POST', { token: document.getElementById('verify2faInput').value, secret: tempSecret }); if(d&&d.success) { userHas2FA = true; renderSettings(); document.getElementById('modal2FA').style.display = 'none'; showToast('2FA Enabled', 'fa-check'); } else alert("Invalid Code"); }

async function fetchLibrary(u) {
    const list = document.getElementById('myLibraryList');
    list.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;">Loading owned games...</p>';
    const res = await apiCall('/api/library', 'POST', { username: u });
    list.innerHTML = '';
    ownedGames = (res && res.games) || [];
    
    if(ownedGames.length === 0) {
        list.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;">No games found (Start bot first)</p>';
        return;
    }
    
    ownedGames.forEach(g => {
        const item = document.createElement('div');
        item.className = 'library-item';
        item.innerText = g.name;
        item.onclick = () => addGame(g.id, g.name);
        list.appendChild(item);
    });
}

function openGamesModal(u, g, c, s) { 
    document.getElementById('manageGameUsername').value = u; 
    currentSelectedGames = g; 
    document.getElementById('customStatus').value = c; 
    document.getElementById('personaState').value = s || 1; 
    renderTags(); 
    document.getElementById('gamesModal').style.display='flex'; 
    document.getElementById('gameSearch').value=''; 
    document.getElementById('searchResults').style.display='none'; 
    fetchLibrary(u);
    fetchBundles();
}

function renderTags() { 
    const b = document.getElementById('selectedGamesBox');
    b.innerHTML = currentSelectedGames.map(g => `<div class="tag"><span>${esc(g.name)}</span><span class="tag-id">${Number(g.id)}</span><span class="tag-x" ${act('removeGame', Number(g.id))}>&times;</span></div>`).join('');
    const count = currentSelectedGames.length;
    const el = document.getElementById('gameCounter');
    if (count > 32) {
        el.innerHTML = `${count} <span class="rot-badge">rotating</span>${hint('rotation')}`;
        el.style.color = 'var(--accent)';
    } else {
        el.innerText = `${count}/32`;
        el.style.color = count >= 32 ? 'var(--btn-red)' : 'var(--text-muted)';
    }
}
function removeGame(id) { currentSelectedGames = currentSelectedGames.filter(g=>g.id!==id); renderTags(); }
function addGame(id, name) { if(!currentSelectedGames.find(g=>g.id===id)) currentSelectedGames.push({id,name}); renderTags(); document.getElementById('gameSearch').value=''; document.getElementById('searchResults').style.display='none'; }

function initGameSearch() {
    const si = document.getElementById('gameSearch'); let st;
    si.addEventListener('input', () => { 
        clearTimeout(st); 
        const q = si.value.trim().toLowerCase(); 
        if(q.length<2) { document.getElementById('searchResults').style.display='none'; return; } 
        
        st = setTimeout(async()=>{ 
            const res = await apiCall(`/api/search_games?q=${encodeURIComponent(q)}`); 
            const rb = document.getElementById('searchResults'); 
            rb.innerHTML=''; 
            
            const libraryMatches = ownedGames.filter(g => g.name.toLowerCase().includes(q));
            if (libraryMatches.length > 0) {
                rb.innerHTML += `<div style="padding:5px 10px;font-size:10px;color:#666;text-transform:uppercase;font-weight:bold;">From Library</div>`;
                libraryMatches.forEach(g => {
                    rb.innerHTML += `<div class="search-item" ${act('addGame', Number(g.id), g.name)}><span style="color:var(--status-green)">${esc(g.name)}</span> <span style="color:#666;">${Number(g.id)}</span></div>`;
                });
            }

            if (res.length > 0) {
                rb.innerHTML += `<div style="padding:5px 10px;font-size:10px;color:#666;text-transform:uppercase;font-weight:bold;border-top:1px solid #333;margin-top:5px;">Global Steam DB</div>`;
                res.forEach(g => { 
                    if (!libraryMatches.find(l => l.id === g.appid)) {
                        rb.innerHTML += `<div class="search-item" ${act('addGame', Number(g.appid), g.name)}><span>${esc(g.name)}</span><span style="color:#666;">${Number(g.appid)}</span></div>`; 
                    }
                }); 
            }
            
            if(rb.innerHTML === '') rb.innerHTML = '<div style="padding:10px;color:#666;text-align:center;font-size:12px;">No results</div>';
            rb.style.display='block'; 
        }, 300); 
    });
}

async function saveGames() {
    const username = document.getElementById('manageGameUsername').value;
    const payload = {
        games: currentSelectedGames.map(g => g.id),
        customStatus: document.getElementById('customStatus').value,
        personaState: parseInt(document.getElementById('personaState').value, 10) || 1
    };
    // The real route is /api/games and it takes the username in the body. This used to
    // POST /api/accounts/<user>/games -- a leftover from the abandoned src/ refactor
    // that no longer exists -- then close the modal regardless, so saving silently did
    // nothing while looking like it worked.
    const res = await apiCall('/api/games', 'POST', { username, ...payload });
    if (!res || !res.success) {
        showToast((res && res.error) || 'Could not save games.', 'fa-circle-xmark');
        return;
    }
    showToast(`Saved ${payload.games.length} game${payload.games.length === 1 ? '' : 's'}.`, 'fa-check');
    closeModals();
    fetchAccounts();
}

// --- BUNDLE LOGIC ---
async function fetchBundles() {
    availableBundles = await apiCall('/api/bundles');
    const sel = document.getElementById('bundleSelect');
    sel.innerHTML = '<option value="">Select Bundle...</option>';
    for (const name in availableBundles) {
        const opt = document.createElement('option'); opt.value = name; opt.innerText = `${name} (${availableBundles[name].length})`; sel.appendChild(opt);
    }
}
function loadBundle() {
    const name = document.getElementById('bundleSelect').value;
    if (!name || !availableBundles[name]) return;
    currentSelectedGames = [...availableBundles[name]];
    renderTags();
}
function addBundle() {
    const name = document.getElementById('bundleSelect').value;
    if (!name || !availableBundles[name]) return;
    availableBundles[name].forEach(g => {
        if(!currentSelectedGames.find(ex => ex.id === g.id)) currentSelectedGames.push(g);
    });
    renderTags();
}

async function clearAllGames() {
    if(await showConfirm("Clear all selected games?")) {
        currentSelectedGames = [];
        renderTags();
    }
}

async function addAllLibraryGames() {
    if (ownedGames.length === 0) return;
    if (!await showConfirm(`Add all ${ownedGames.length} games from library?`)) return;
    ownedGames.forEach(g => {
        if(!currentSelectedGames.find(ex => ex.id === g.id)) currentSelectedGames.push(g);
    });
    renderTags();
}

async function refreshLibraryAPI(btn) {
    const u = document.getElementById('manageGameUsername').value;
    const icon = btn ? btn.querySelector('i') : null;
    if (icon) icon.classList.add('fa-spin');
    try {
        const res = await apiCall('/api/library/refresh', 'POST', { username: u });
        if (res && res.success) {
            showToast(`Library refreshed - ${res.count} game${res.count === 1 ? '' : 's'} found.`, 'fa-check');
            await fetchLibrary(u);
        } else {
            // res is null when the request failed outright; don't dereference it.
            showToast((res && res.error) || 'Could not refresh the library.', 'fa-circle-xmark');
        }
    } catch (e) {
        showToast(e.message || 'Could not refresh the library.', 'fa-circle-xmark');
    }
    if (icon) icon.classList.remove('fa-spin');
}

// --- NEW BUNDLE TAB LOGIC ---
async function fetchBundlesView() {
    cachedBundles = await apiCall('/api/bundles');
    renderBundlesView();
}

function renderBundlesView() {
    const q = document.getElementById('bundleSearch').value.toLowerCase();
    const c = document.getElementById('bundlesContainer');
    c.innerHTML = '';
    for (const k in cachedBundles) {
        if (q && !k.toLowerCase().includes(q)) continue;
        const card = document.createElement('div');
        card.className = 'bundle-card';
        card.innerHTML = `<h4>${esc(k)}</h4><span>${cachedBundles[k].length} Games</span><div class="bundle-actions"><button class="icon-btn" ${act('openBundleModal', k)}><i class="fa-solid fa-pen"></i></button><button class="icon-btn btn-trash" ${act('deleteBundleFromTab', k)}><i class="fa-solid fa-trash"></i></button></div>`;
        c.appendChild(card);
    }
}

async function openBundleModal(name = null) {
    document.getElementById('bundleName').value = name || '';
    document.getElementById('bundleName').disabled = !!name; // Disable name edit if updating
    currentBundleGames = [];
    if (name) {
        const b = await apiCall('/api/bundles');
        if (b[name]) currentBundleGames = [...b[name]];
    }
    renderBundleTags();
    document.getElementById('bundleModal').style.display = 'flex';
}

async function saveBundleFromTab() {
    const name = document.getElementById('bundleName').value.trim();
    if (!name) return alert("Enter a name");
    await apiCall('/api/bundles', 'POST', { name, games: currentBundleGames.map(g=>g.id) });
    closeModals();
    fetchBundlesView();
}

async function deleteBundleFromTab(name) {
    if (await showConfirm(`Delete bundle "${name}"?`)) { await apiCall('/api/bundles/delete', 'POST', { name }); fetchBundlesView(); }
}

function renderBundleTags() {
    const b = document.getElementById('selectedBundleGamesBox');
    b.innerHTML = currentBundleGames.map(g => `<div class="tag"><span>${esc(g.name)}</span><span class="tag-id">${Number(g.id)}</span><span class="tag-x" ${act('removeBundleGame', Number(g.id))}>&times;</span></div>`).join('');
    const count = currentBundleGames.length;
    const el = document.getElementById('bundleGameCounter');
    if (count > 32) {
        el.innerHTML = `${count} <span class="rot-badge">rotating</span>${hint('rotation')}`;
        el.style.color = 'var(--accent)';
    } else {
        el.innerText = `${count}/32`;
        el.style.color = count >= 32 ? 'var(--btn-red)' : 'var(--text-muted)';
    }
}
function removeBundleGame(id) { currentBundleGames = currentBundleGames.filter(g=>g.id!==id); renderBundleTags(); }
function addBundleGame(id, name) { if(!currentBundleGames.find(g=>g.id===id)) currentBundleGames.push({id,name}); renderBundleTags(); document.getElementById('bundleGameSearch').value=''; document.getElementById('bundleSearchResults').style.display='none'; }

function initBundleGameSearch() {
    const si = document.getElementById('bundleGameSearch'); let st;
    si.addEventListener('input', () => { 
        clearTimeout(st); const q = si.value.trim().toLowerCase(); 
        if(q.length<2) { document.getElementById('bundleSearchResults').style.display='none'; return; } 
        st = setTimeout(async()=>{ 
            const res = await apiCall(`/api/search_games?q=${encodeURIComponent(q)}`); 
            const rb = document.getElementById('bundleSearchResults'); rb.innerHTML=''; 
            if (res.length > 0) res.forEach(g => { rb.innerHTML += `<div class="search-item" ${act('addBundleGame', Number(g.appid), g.name)}><span>${esc(g.name)}</span><span style="color:#666;">${Number(g.appid)}</span></div>`; }); 
            else rb.innerHTML = '<div style="padding:10px;color:#666;text-align:center;font-size:12px;">No results</div>';
            rb.style.display='block'; 
        }, 300); 
    });
}

// Log entries are {text, relatedUser}; older REST responses were plain strings, so
// normalise either shape.
function logText(l) { return typeof l === 'string' ? l : (l && l.text) || ''; }
function logUser(l) { return typeof l === 'string' ? null : (l && l.relatedUser) || null; }

function renderLogs() {
    const q = document.getElementById('logSearch').value.toLowerCase();
    const accSel = document.getElementById('logAccountFilter');
    const acc = accSel ? accSel.value : '';

    let filtered = cachedLogs.filter(l => logText(l).toLowerCase().includes(q));
    if (acc) filtered = filtered.filter(l => logUser(l) === acc);

    const box = document.getElementById('logsContainer');
    if (filtered.length === 0) {
        box.innerHTML = '<div class="log-line" style="opacity:.6">No log lines match this filter.</div>';
    } else {
        box.innerHTML = filtered.map(l => `<div class="log-line">${esc(logText(l))}</div>`).join('');
    }
    syncLogAccountOptions();
}

// Keep the account dropdown in step with the accounts we know about.
function syncLogAccountOptions() {
    const sel = document.getElementById('logAccountFilter');
    if (!sel) return;
    const want = cachedAccounts.map(a => a.username).sort();
    const have = Array.from(sel.options).slice(1).map(o => o.value);
    if (want.length === have.length && want.every((v, i) => v === have[i])) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">All accounts</option>' +
        want.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    if (want.includes(current)) sel.value = current;
}

function exportLogs() {
    const text = cachedLogs.map(logText).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `bruddibooster_logs_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url); // the blob is retained for the page's lifetime otherwise
}

async function clearLogs() {
    if(await showConfirm("Clear all system logs?")) {
        await apiCall('/api/logs/clear', 'POST');
        fetchLogs();
    }
}

function toggleCategorySelect(cb, id) {
    const tbody = document.getElementById(`tbody-${id}`);
    if (!tbody) return;
    tbody.querySelectorAll('.acc-select').forEach(c => {
        c.checked = cb.checked;
        if (cb.checked) selectedAccounts.add(c.value); else selectedAccounts.delete(c.value);
    });
    updateBulkUI();
}

function onAccSelect(cb) {
    if (cb.checked) selectedAccounts.add(cb.value); else selectedAccounts.delete(cb.value);
    updateBulkUI();
}

// Selection is the source of truth, not the DOM: rows for filtered-out accounts
// aren't rendered, but the user still selected them.
function getSelectedAccounts() {
    const visible = new Set(cachedAccounts.map(a => a.username));
    return [...selectedAccounts].filter(u => visible.has(u));
}

function updateBulkUI() {
    const n = getSelectedAccounts().length;
    const bar = document.getElementById('bulkActionsBar');
    if (n > 0) {
        bar.style.display = 'flex';
        document.getElementById('selectedCount').innerText = n;
    } else {
        bar.style.display = 'none';
    }
}

function clearSelection() {
    selectedAccounts.clear();
    document.querySelectorAll('.acc-select').forEach(c => c.checked = false);
    document.querySelectorAll('input[onchange^="toggleCategorySelect"]').forEach(c => c.checked = false);
    updateBulkUI();
}

async function bulkAction(action) {
    const selected = getSelectedAccounts();
    if (selected.length === 0) return;
    // Deleting accounts is unrecoverable, so make the user type the count rather than
    // click through a yes/no they've stopped reading.
    if (action === 'delete') {
        const typed = prompt(`This permanently deletes ${selected.length} account(s) and cannot be undone.\n\nType ${selected.length} to confirm:`);
        if (typed === null) return;
        if (typed.trim() !== String(selected.length)) { showToast('Cancelled - the number did not match.', 'fa-ban'); return; }
    }
    showToast(`Processing ${action} for ${selected.length} accounts...`, 'fa-gear');
    let failed = 0;
    for (const username of selected) {
        try { const r = await apiCall(`/api/${action}`, 'POST', { username }); if (!r) failed++; }
        catch (e) { failed++; }
    }
    if (failed) showToast(`${failed} of ${selected.length} failed. Check logs.`, 'fa-triangle-exclamation');
    else showToast(`${action} completed for ${selected.length} account(s).`, 'fa-check');
    clearSelection();
    fetchAccounts();
}

async function submitBulkEdit() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) return;
    
    const cat = document.getElementById('bulkEditCategory').value.trim();
    const auto = document.getElementById('bulkEditAutoStart').value;
    const bundle = document.getElementById('bulkEditBundle') ? document.getElementById('bulkEditBundle').value : '';
    const proxies = document.getElementById('bulkEditProxies').value.trim().split(/\r?\n/).filter(l => l.trim() !== '');
    
    const updates = [];
    selected.forEach((u, i) => {
        const update = { username: u };
        if (cat) update.category = cat;
        if (auto !== "") update.autoStart = (auto === "true");
        if (bundle) update.bundle = bundle;
        if (proxies.length > 0) update.proxy = proxies[i % proxies.length]; // Round-robin assignment
        updates.push(update);
    });

    const res = await apiCall('/api/accounts/bulk_update', 'POST', { updates });
    if (res && res.success) { showToast(`Updated ${res.count} accounts`, 'fa-check'); closeModals(); fetchAccounts(); }
}

async function submitFreeGames() {
    if (selectedFreeAccounts.length === 0) return alert("No accounts selected.");
    if (selectedFreeGames.length === 0) return alert("No games selected.");
    
    const offlineAccounts = cachedAccounts.filter(a => selectedFreeAccounts.includes(a.username) && a.status !== 'Running');
    let autoStart = false;

    if (offlineAccounts.length > 0) {
        const msg = `Warning: ${offlineAccounts.length} selected accounts are offline.\n\nThe app will temporarily start them to add the games and then stop them.\n\nContinue?`;
        if (!await showConfirm(msg, "Offline Accounts Detected")) return;
        autoStart = true;
    }

    const accountsWithoutProxy = cachedAccounts.filter(a => selectedFreeAccounts.includes(a.username) && !a.proxy);
    if (selectedFreeAccounts.length > 1 && accountsWithoutProxy.length > 0) {
        if (!await showConfirm(`Warning: ${accountsWithoutProxy.length} selected accounts do not have a proxy. Adding games in bulk from the same IP might trigger rate limits. Continue?`)) return;
    }

    showToast(`Adding games to ${selectedFreeAccounts.length} accounts...`, 'fa-spinner fa-spin');
    const res = await apiCall('/api/games/free_license', 'POST', { usernames: selectedFreeAccounts, games: selectedFreeGames, autoStart });
    if (res && res.success) { 
        if (res.queued === 0 && res.count > 0) {
            showToast(`Failed: None of the ${res.count} selected bots are running.`, 'fa-circle-xmark');
        } else {
            showToast(`Request sent to ${res.queued}/${res.count} running bots. Check logs.`, 'fa-check'); 
            closeModals(); 
        }
    }
}

// --- PROXIES TAB ---
async function fetchProxiesView() {
    if (document.querySelector('.proxy-input:focus')) return;
    const accounts = await apiCall('/api/accounts');
    fetchGlobalPool();
    const container = document.getElementById('proxiesContainer');
    container.innerHTML = '';

    const groups = {};
    accounts.forEach(acc => { const cat = acc.category || 'Default'; if(!groups[cat]) groups[cat] = []; groups[cat].push(acc); });
    const sortedCats = Object.keys(groups).sort((a,b) => { if(a==='Default') return -1; if(b==='Default') return 1; return a.localeCompare(b); });

    sortedCats.forEach((cat, index) => {
        const safeId = index;
        const isExpanded = categoryStates[`proxy-${safeId}`] !== undefined ? categoryStates[`proxy-${safeId}`] : true;
        const section = document.createElement('div');
        section.className = 'category-section';
        section.innerHTML = `<div class="category-header" ${act('toggleProxyCategory', safeId)}><span><i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${esc(cat)} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="proxy-cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="proxy-cat-body-${safeId}"><div class="panel"><table><thead><tr><th>Username</th><th>Proxy (http://user:pass@ip:port)</th><th>Action</th></tr></thead><tbody>${groups[cat].map(a => `<tr><td style="color:var(--text-main);">${esc(a.username)}</td><td><input type="text" class="form-input proxy-input" id="proxy-${esc(a.username)}" data-user="${esc(a.username)}" data-category="${esc(a.category||'Default')}" value="${esc(a.proxy || '')}" placeholder="http://user:pass@ip:port"></td><td><div class="actions"><button class="icon-btn" ${act('checkProxy', a.username)} title="Check Proxy"><i class="fa-solid fa-stethoscope"></i></button><button class="icon-btn" ${act('saveProxy', a.username)} title="Apply Proxy"><i class="fa-solid fa-check"></i></button><button class="icon-btn btn-trash" ${act('deleteProxy', a.username)} title="Remove Proxy"><i class="fa-solid fa-trash"></i></button></div></td></tr>`).join('')}</tbody></table></div></div>`;
        container.appendChild(section);
    });
}

async function fetchGlobalPool() {
    const proxies = await apiCall('/api/proxies/global');
    if (proxies) document.getElementById('globalProxyPoolInput').value = proxies.join('\n');
}

async function saveGlobalPool() {
    const text = document.getElementById('globalProxyPoolInput').value.trim();
    const proxies = text.split(/\r?\n/).filter(l => l.trim() !== '');
    const res = await apiCall('/api/proxies/global', 'POST', { proxies });
    if (res && res.success) showToast('Global Proxy Pool Saved', 'fa-check');
}

async function checkProxy(username, silent = false) {
    const input = document.getElementById(`proxy-${username}`);
    const proxy = input.value.trim();
    if (!proxy) {
        if(!silent) showToast('Enter a proxy first', 'fa-circle-exclamation');
        return false;
    }
    
    if(!silent) showToast('Testing connection...', 'fa-spinner fa-spin');
    const res = await apiCall('/api/proxy/check', 'POST', { proxy });
    
    if (res && res.success) {
        if(!silent) { showToast(`Success! IP: ${res.ip}`, 'fa-check'); setProxyRowState(username, 'ok', 'working'); }
        input.style.borderColor = 'var(--status-green)';
        return true;
    } else {
        if (spareProxies.length > 0) {
            const newProxy = spareProxies.shift();
            input.value = newProxy;
            showToast(`Proxy failed for ${username}. Replaced with spare.`, 'fa-rotate');
            return await checkProxy(username, silent);
        }
        if(!silent) { showToast(`Failed: ${res ? res.msg : 'Error'}`, 'fa-circle-xmark'); setProxyRowState(username, 'bad', res && res.msg ? res.msg : 'failed'); }
        input.style.borderColor = 'var(--btn-red)';
        return false;
    }
}

async function deleteProxy(username) {
    const res = await apiCall('/api/accounts/bulk_update', 'POST', { updates: [{ username, proxy: '' }] });
    if (res && res.success) {
        const input = document.getElementById(`proxy-${username}`);
        if(input) input.value = '';
        showToast('Proxy Removed', 'fa-trash');
    }
}

async function saveProxy(username) {
    const input = document.getElementById(`proxy-${username}`);
    const proxy = input.value.trim();
    const res = await apiCall('/api/accounts/bulk_update', 'POST', { updates: [{ username, proxy }] });
    if (res && res.success) {
        showToast('Proxy Applied', 'fa-check');
        input.style.borderColor = ''; 
    }
}

async function saveAllProxies() {
    const inputs = document.querySelectorAll('.proxy-input');
    const updates = [];
    inputs.forEach(inp => { updates.push({ username: inp.dataset.user, proxy: inp.value.trim() }); });
    const res = await apiCall('/api/accounts/bulk_update', 'POST', { updates });
    if (res && res.success) showToast('Proxies Saved', 'fa-floppy-disk');
}

function openBulkProxyModal() {
    document.getElementById('bulkProxyInput').value = '';
    
    const cats = [...new Set(cachedAccounts.map(a => a.category || 'Default'))].sort();
    const sel = document.getElementById('bulkProxyCategory');
    sel.innerHTML = '<option value="">All Categories</option>';
    cats.forEach(c => { const opt = document.createElement('option'); opt.value = c; opt.innerText = c; sel.appendChild(opt); });

    document.getElementById('bulkProxyRatio').value = '1';
    document.getElementById('bulkProxyModal').style.display = 'flex';
}

async function submitBulkProxyImport() {
    const text = document.getElementById('bulkProxyInput').value.trim();
    if (!text) return alert("Please enter proxies.");
    
    const proxies = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (proxies.length === 0) return alert("No valid proxies found.");

    const targetCat = document.getElementById('bulkProxyCategory').value;
    let inputs = Array.from(document.querySelectorAll('.proxy-input'));
    if (targetCat) inputs = inputs.filter(i => i.dataset.category === targetCat);

    if (inputs.length === 0) return alert("No accounts found in list. Please go to Proxy Manager tab first.");

    const ratio = parseInt(document.getElementById('bulkProxyRatio').value) || 1;

    if (!await showConfirm(`Distribute ${proxies.length} proxies across ${inputs.length} accounts (1 proxy per ${ratio} accounts)? This will update the list below but NOT save to disk yet.`)) return;

    spareProxies = [];
    const usedIndices = new Set();

    inputs.forEach((input, index) => {
        const proxyIndex = Math.floor(index / ratio) % proxies.length;
        input.value = proxies[proxyIndex];
        input.style.borderColor = ''; // Reset status
        usedIndices.add(proxyIndex);
    });

    spareProxies = proxies.filter((_, idx) => !usedIndices.has(idx));

    closeModals();
    let msg = `Distributed proxies to ${inputs.length} accounts.`;
    if (spareProxies.length > 0) msg += ` ${spareProxies.length} spares stored.`;
    showToast(msg, 'fa-info-circle');
}

// Marks a single proxy row so scrolling the list is informative during and after a run.
function setProxyRowState(username, state, label) {
    const input = document.getElementById(`proxy-${username}`);
    if (!input) return;
    const cell = input.closest('td');
    if (!cell) return;
    let tag = cell.querySelector('.proxy-state');
    if (!tag) {
        tag = document.createElement('span');
        tag.className = 'proxy-state';
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.gap = '8px';
        cell.appendChild(tag);
    }
    tag.className = 'proxy-state ' + state;
    tag.textContent = label;
}

let proxyTestRun = 0;
async function testAllProxies() {
    const inputs = Array.from(document.querySelectorAll('.proxy-input')).filter(i => i.value.trim());
    if (inputs.length === 0) return showToast("No proxies to test", "fa-circle-exclamation");

    const runId = ++proxyTestRun;
    const total = inputs.length;
    let done = 0, ok = 0, swapped = 0, failed = 0;
    const failures = [];
    const started = Date.now();

    const panel = document.getElementById('proxyTestPanel');
    const bar = document.getElementById('proxyTestBar');
    const failList = document.getElementById('proxyTestFailList');
    panel.style.display = 'block';
    failList.className = 'test-faillist';
    failList.innerHTML = '';

    const paint = () => {
        document.getElementById('proxyTestCount').innerText = `${done} / ${total}`;
        bar.style.width = (total ? (done / total) * 100 : 0) + '%';
        document.getElementById('proxyTestOk').innerText = ok;
        document.getElementById('proxyTestSwapped').innerText = swapped;
        document.getElementById('proxyTestFail').innerText = failed;
        // Rough ETA from throughput so far — more useful than a spinner on 245 rows.
        const elapsed = (Date.now() - started) / 1000;
        if (done >= 3 && done < total) {
            const remaining = Math.round((elapsed / done) * (total - done));
            document.getElementById('proxyTestEta').innerText = remaining > 60
                ? `~${Math.ceil(remaining / 60)} min left` : `~${remaining}s left`;
        } else if (done >= total) {
            document.getElementById('proxyTestEta').innerText = `done in ${Math.round(elapsed)}s`;
        } else {
            document.getElementById('proxyTestEta').innerText = 'estimating...';
        }
        if (failures.length) {
            failList.className = 'test-faillist show';
            failList.innerHTML = failures.map(f => `<div>${esc(f)}</div>`).join('');
        }
    };
    paint();

    const CONCURRENCY = 5;
    const queue = [...inputs];
    const workers = [];

    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                if (runId !== proxyTestRun) return; // a newer run superseded this one
                const input = queue.shift();
                const user = input.dataset.user;
                const before = input.value.trim();
                setProxyRowState(user, 'testing', 'testing');

                const result = await checkProxy(user, true);
                done++;

                if (result) {
                    // checkProxy swaps in a spare when the original fails, so compare.
                    if (input.value.trim() !== before) { swapped++; setProxyRowState(user, 'swapped', 'replaced'); }
                    else { ok++; setProxyRowState(user, 'ok', 'working'); }
                } else {
                    input.value = '';
                    input.style.borderColor = '';
                    failed++;
                    failures.push(`${user} — ${before}`);
                    setProxyRowState(user, 'bad', 'removed');
                }
                paint();
            }
        })());
    }

    await Promise.all(workers);
    if (runId !== proxyTestRun) return;
    await saveAllProxies();
    paint();

    const summary = `${ok} working` + (swapped ? `, ${swapped} replaced` : '') + (failed ? `, ${failed} removed` : '');
    showToast(`Proxy test complete: ${summary}. Saved.`, failed ? 'fa-triangle-exclamation' : 'fa-check-double');
}

async function restartAllBots() {
    if (await showConfirm("Restart ALL running bots? This will stagger logins to prevent rate limits.")) {
        const res = await apiCall('/api/restart_all', 'POST');
        if (res && res.success) {
            showToast(`Restarting ${res.count} bots...`, 'fa-rotate');
            fetchAccounts();
        }
    }
}

async function panicStop() {
    if (await showConfirm("ARE YOU SURE? This will immediately stop ALL running bots.")) {
        const res = await apiCall('/api/panic', 'POST');
        if (res && res.success) {
            showToast(`Stopped ${res.count} bots`, 'fa-circle-stop');
            fetchAccounts();
        }
    }
}

function maskIp(ip) {
    if (!ip || ip === "Server IP") return ip;
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
    return ip.substring(0, 4) + '...';
}

window.toggleIp = function(btn) {
    const span = btn.previousElementSibling;
    const fullIp = span.getAttribute('data-ip');
    const isHidden = span.innerText.includes('*') || span.innerText.includes('...');
    if (isHidden) {
        span.innerText = fullIp; btn.classList.remove('fa-eye'); btn.classList.add('fa-eye-slash');
    } else {
        span.innerText = maskIp(fullIp); btn.classList.add('fa-eye'); btn.classList.remove('fa-eye-slash');
    }
}

window.toggleMobileMenu = function() {
    document.querySelector('.sidebar .menu').classList.toggle('mobile-visible');
    document.querySelector('.sidebar-footer').classList.toggle('mobile-visible');
}

function toggleTheme() {
    const isLight = document.getElementById('themeToggle').checked;
    const theme = isLight ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
}

async function exportAccounts() {
    if(!await showConfirm("Download backup of all accounts (including passwords)?")) return;
    let payload = {};
    if (userHas2FA) {
        const code = prompt('Enter your 2FA code to export account credentials:');
        if (!code) return;
        payload = { token: code.trim() };
    }
    const res = await apiCall('/api/accounts/export', 'POST', payload);
    if (res && res.requires2fa) { showToast('Invalid 2FA code', 'fa-triangle-exclamation'); return; }
    if(res && res.success) {
        const blob = new Blob([res.data], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bruddibooster_accounts_${Date.now()}.txt`;
        a.click();
        window.URL.revokeObjectURL(url);
    }
}