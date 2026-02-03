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
let spareProxies = [];
let hideOwnedAccounts = false;
let currentSort = { column: null, direction: 'asc' };

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
    initGameSearch();
    initBundleGameSearch();
    document.getElementById('btnBulk').addEventListener('click', openBulkModal);
    document.getElementById('btnAdd').addEventListener('click', openAddModal);

    // Search Listeners
    document.getElementById('accountSearch').addEventListener('input', () => applyAccountFilter());
    document.getElementById('bundleSearch').addEventListener('input', () => renderBundlesView());
    document.getElementById('logSearch').addEventListener('input', () => renderLogs());
    
    // Setup UI based on role
    document.getElementById('nav-users').style.display = currentUserRole === 'admin' ? 'flex' : 'none';
    
    // Start polling
    fetchAccounts();
    setInterval(() => { 
        if(!authToken) return; 
        if(activeTab === 'dash' || activeTab === 'statistics') fetchAccounts(); 
        if(activeTab === 'logs') fetchLogs();
    }, 3000);

    // Socket.io Live Logs
    if (typeof io !== 'undefined') {
        socket = io();
        socket.on('new_log', (logEntry) => {
            if (currentUserRole !== 'admin') {
                if (!logEntry.relatedUser || !cachedAccounts.some(a => a.username === logEntry.relatedUser)) return;
            }
            cachedLogs.unshift(logEntry.text);
            if (cachedLogs.length > 100) cachedLogs.pop();
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

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active')); document.getElementById(`nav-${tab}`).classList.add('active');
    ['dash','users','logs','settings','bundles','proxies','freegames','statistics','faq'].forEach(v => document.getElementById(`view-${v}`).style.display='none');
    document.getElementById(`view-${tab}`).style.display='block';
    if(tab==='dash') fetchAccounts(); if(tab==='users') fetchUsers(); if(tab==='logs') fetchLogs(); if(tab==='settings') renderSettings(); if(tab==='bundles') fetchBundlesView(); if(tab==='proxies') fetchProxiesView(); if(tab==='freegames') renderFreeGamesView(); if(tab==='statistics') renderStatisticsView(); if(tab==='faq') renderFaqView();
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
        list.innerHTML = noGuardAccs.map(a => `<div class="tag" style="background:var(--bg-secondary);border:1px solid var(--border);padding:5px 10px;border-radius:4px;">${a.username}</div>`).join('');
    }

    const running = cachedAccounts.filter(a => a.status === 'Running').length;
    const errored = cachedAccounts.filter(a => a.status === 'Error' || a.status.includes('Rate Limit') || a.status === 'Need Guard').length;
    const stopped = total - running - errored;
    const ctx = document.getElementById('statusChart').getContext('2d');
    if (typeof Chart === 'undefined') return;
    
    if (statusChartInstance) {
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

function renderFaqView() {
    const codes = [
        { code: 5, name: 'InvalidPassword', desc: 'Your password is incorrect. Please update it in the dashboard.' },
        { code: 6, name: 'LoggedInElsewhere', desc: 'This account is logged in somewhere else (or you launched the game on your PC). The bot will reconnect automatically.' },
        { code: 43, name: 'VACCheckTimedOut', desc: 'Often indicates a "zombie" session or account issue. The system will automatically disable accounts with this error to prevent loops. Try changing the password or logging in manually.' },
        { code: 63, name: 'AccountLogonDenied', desc: 'Steam Guard is required. Check your email for the code.' },
        { code: 84, name: 'RateLimitExceeded', desc: 'Too many login attempts from this IP. The bot will pause for 5 minutes and retry.' },
        { code: 87, name: 'InvalidLoginAuthCode', desc: 'The 2FA/Steam Guard code provided was invalid.' },
        { code: 88, name: 'AccountLogonDeniedNoMail', desc: 'Steam Guard needed but no email was sent. Usually means you need to log in manually once.' }
    ];

    const faqs = [
        { q: "Why are my accounts stopping?", a: "Check the 'Last Error' column or the Logs tab. Common reasons include invalid passwords, Steam Guard requirements, or Steam server issues." },
        { q: "What does Error 43 mean?", a: "It's a generic Steam error often related to connection issues or account flags. BruddiBooster disables these accounts automatically to prevent infinite restart loops." },
        { q: "How do I add proxies?", a: "Go to the 'Proxies' tab. You can assign a proxy to each account individually or use the Bulk Import tool." },
        { q: "Can I farm more than 32 games?", a: "Yes! If you add more than 32 games to an account, the bot will automatically rotate through them in batches every hour." },
        { q: "Why can't I add some free games?", a: "Some games are region-locked. If the bot says 'Possible Region Lock', the game is likely not available in the account's store country." }
    ];

    document.getElementById('faqCodesBody').innerHTML = codes.map(c => `<tr><td><span class="tag" style="background:var(--bg-input);">${c.code}</span></td><td style="font-weight:600;color:var(--accent);">${c.name}</td><td style="color:var(--text-muted);">${c.desc}</td></tr>`).join('');
    
    document.getElementById('faqList').innerHTML = faqs.map(f => `
        <div style="background:var(--bg-input);padding:15px;border-radius:8px;border:1px solid var(--border);">
            <div style="font-weight:600;color:var(--text-main);margin-bottom:5px;"><i class="fa-solid fa-q"></i> ${f.q}</div>
            <div style="color:var(--text-muted);font-size:14px;line-height:1.4;">${f.a}</div>
        </div>
    `).join('');
}

async function logout() { await apiCall('/api/logout', 'POST'); localStorage.removeItem('authToken'); localStorage.removeItem('userRole'); sessionStorage.removeItem('authToken'); sessionStorage.removeItem('userRole'); location.reload(); }
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
            <button class="primary-btn btn-stop-action" onclick="disable2FA()"><i class="fa-solid fa-ban"></i> Disable 2FA</button>
        `;
    } else {
        area.innerHTML = `
            <p class="status-inactive-2fa">Protect your admin panel with Google Authenticator.</p>
            <button class="primary-btn" onclick="start2FASetup()"><i class="fa-solid fa-shield-halved"></i> Setup 2FA</button>
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
    if(acc.status==='Need Guard') return `<span class="st-guard">Guard</span>`;
    if(acc.status==='Logging in...') return `<span class="st-logging">Logging in...</span>`;
    if(acc.status.includes('Rate Limit')) return `<span class="st-guard" style="cursor:help;" title="${(acc.lastError||'').replace(/"/g, '&quot;')}">${acc.status}</span>`;
    if (acc.status === 'Error' && acc.lastError) return `<span class="st-stopped" style="cursor:help;" title="${acc.lastError.replace(/"/g, '&quot;')}">ERROR</span>`;
    return `<span class="st-stopped">${acc.status}</span>`;
}

function getActionsHtml(acc) {
    const isRunning = acc.status === 'Running';
    const gamesJson = JSON.stringify(acc.games).replace(/"/g, '&quot;');
    const profileBtn = acc.steamId ? `<a href="https://steamcommunity.com/profiles/${acc.steamId}" target="_blank" class="icon-btn"><i class="fa-solid fa-up-right-from-square"></i></a>` : '';
    
    const gameCountDisplay = acc.games.length > 32 
        ? `${acc.games.length} <i class="fa-solid fa-circle-info" title="Rotation Active"></i>` 
        : `${acc.games.length}/32`;

    return `${isRunning?`<button class="icon-btn btn-stop-action" onclick="handleAction('stop','${acc.username}')"><i class="fa-solid fa-stop"></i></button><button class="icon-btn" onclick="handleAction('restart','${acc.username}')"><i class="fa-solid fa-rotate-right"></i></button>`:`<button class="icon-btn btn-play" onclick="handleAction('start','${acc.username}')"><i class="fa-solid fa-play"></i></button>`}<button class="icon-btn" style="width:auto;padding:0 12px;gap:6px;" onclick="openGamesModal('${acc.username}', ${gamesJson}, '${acc.customStatus||''}', ${acc.personaState})"><i class="fa-solid fa-gamepad"></i> <span style="font-size:11px;font-weight:600;">${gameCountDisplay}</span></button><button class="icon-btn" onclick="openStats('${acc.addedAt}', ${acc.boostedHours})"><i class="fa-solid fa-chart-line"></i></button>${profileBtn}<button class="icon-btn" onclick="openProfileModal('${acc.username}', '${(acc.nickname||"").replace(/'/g, "\\'")}')" title="Edit Profile"><i class="fa-solid fa-user-pen"></i></button><button class="icon-btn" onclick="openEditModal('${acc.username}', '${acc.category||''}', ${acc.autoStart})"><i class="fa-solid fa-pen"></i></button><button class="icon-btn btn-trash" onclick="deleteAccount('${acc.username}')"><i class="fa-solid fa-trash"></i></button>${acc.status==='Need Guard'?`<button class="icon-btn" style="color:var(--status-yellow);border-color:var(--status-yellow);" onclick="openGuard('${acc.username}')"><i class="fa-solid fa-key"></i></button>`:''}`;
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

    let rebuild = false;
    if (currentSort.column) rebuild = true;
    const existing = document.querySelectorAll('tr[id^="tr-"]');
    if (!rebuild && existing.length !== accounts.length) rebuild = true;
    else { for (const acc of accounts) { const row = document.getElementById(`tr-${acc.username}`); if (!row || row.dataset.category !== (acc.category || 'Default')) { rebuild = true; break; } } }

    if (!rebuild) {
        accounts.forEach(acc => {
            const row = document.getElementById(`tr-${acc.username}`);
            if (row) {
                const newStatus = getStatusHtml(acc); if (row.cells[2].innerHTML !== newStatus) row.cells[2].innerHTML = newStatus;
                const newHours = `${parseFloat(acc.grandTotal).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h`; if (row.cells[3].innerText !== newHours) row.cells[3].innerText = newHours;
                const hasStopBtn = row.querySelector('.btn-stop-action'); const isRunning = acc.status === 'Running';
                if ((isRunning && !hasStopBtn) || (!isRunning && hasStopBtn)) row.cells[5].innerHTML = `<div class="actions">${getActionsHtml(acc)}</div>`;
            }
        });
        return;
    }

    const container = document.getElementById('accountsContainer'); container.innerHTML = '';
    const groups = {};
    accounts.forEach(acc => { const cat = acc.category || 'Default'; if(!groups[cat]) groups[cat] = []; groups[cat].push(acc); });
    
    // Sort within groups
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

    sortedCats.forEach((cat, index) => {
        const safeId = index;
        const isExpanded = categoryStates[safeId] !== undefined ? categoryStates[safeId] : true;
        const section = document.createElement('div');
        
        const getSortIcon = (col) => {
            if (currentSort.column !== col) return '<i class="fa-solid fa-sort" style="color:var(--text-muted);font-size:10px;margin-left:5px;"></i>';
            return currentSort.direction === 'asc' ? '<i class="fa-solid fa-sort-up" style="color:var(--accent);font-size:10px;margin-left:5px;"></i>' : '<i class="fa-solid fa-sort-down" style="color:var(--accent);font-size:10px;margin-left:5px;"></i>';
        };

        section.className = 'category-section';
        section.innerHTML = `<div class="category-header" onclick="toggleCategory(${safeId})"><span><i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${cat} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="cat-body-${safeId}"><div class="panel"><table><thead><tr><th style="width:40px;text-align:center;"><input type="checkbox" onchange="toggleCategorySelect(this, ${safeId})"></th><th>User</th><th onclick="sortAccounts('status')" style="cursor:pointer">Status ${getSortIcon('status')}</th><th onclick="sortAccounts('hours')" style="cursor:pointer">Hours ${getSortIcon('hours')}</th><th>IP</th><th>Actions</th></tr></thead><tbody id="tbody-${safeId}"></tbody></table></div></div>`;
        container.appendChild(section);
        const tbody = document.getElementById(`tbody-${safeId}`);
        groups[cat].forEach(acc => tbody.appendChild(createAccountRow(acc)));
    });
}

function createAccountRow(acc) {
        const avatarUrl = acc.avatarHash ? `https://avatars.steamstatic.com/${acc.avatarHash}_full.jpg` : 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
        const autoStartIcon = acc.autoStart ? `<i class="fa-solid fa-bolt autostart-icon" title="Auto-start Enabled"></i>` : '';
        const tr = document.createElement('tr');
        tr.id = `tr-${acc.username}`;
        tr.dataset.category = acc.category || 'Default';
        const showEye = (acc.ip && acc.ip !== "Server IP" && acc.ip !== "Loading...") ? '' : 'style="display:none;"';
        tr.innerHTML = `<td style="text-align:center;"><input type="checkbox" class="acc-select" value="${acc.username}" onchange="updateBulkUI()"></td><td><div class="user-cell"><img src="${avatarUrl}" class="user-avatar" alt="Avatar"><div class="user-details"><div><span class="user-nick">${acc.nickname||acc.username}</span>${autoStartIcon}</div><span class="user-name">${acc.username}</span></div></div></td><td>${getStatusHtml(acc)}</td><td style="color:var(--text-main);font-weight:600;">${parseFloat(acc.grandTotal).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h</td><td><div class="ip-cell"><span data-ip="${acc.ip}">${maskIp(acc.ip)}</span><i class="fa-solid fa-eye ip-icon" onclick="toggleIp(this)" ${showEye}></i></div></td><td><div class="actions">${getActionsHtml(acc)}</div></td>`;
        return tr;
}

function applyAccountFilter() {
    const q = document.getElementById('accountSearch').value.toLowerCase();
    const filtered = cachedAccounts.filter(a => a.username.toLowerCase().includes(q));
    renderTable(filtered);
}

async function fetchAccounts() { 
    const d = await apiCall('/api/accounts'); 
    if(d) { 
        cachedAccounts = d; 
        if (activeTab === 'dash') applyAccountFilter(); 
        else if (activeTab === 'freegames') renderFreeAccountsUI();
        else if (activeTab === 'statistics') renderStatisticsView();
    } 
}
async function fetchLogs() { cachedLogs = await apiCall('/api/logs'); renderLogs(); }
async function fetchUsers() { const u = await apiCall('/api/users'); document.getElementById('usersTableBody').innerHTML = u.map(x=>`<tr><td style="color:var(--text-main);">${x.username}</td><td style="color:#888;">${x.role}</td><td>${x.role!=='admin'?`<button class="icon-btn btn-trash" onclick="delUser('${x.username}')"><i class="fa-solid fa-trash"></i></button>`:''}</td></tr>`).join(''); }

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
        return `<div class="game-card ${isSel?'selected':''}" onclick="toggleFreeGame(${g.id})"><img src="https://steamcdn-a.akamaihd.net/steam/apps/${g.id}/capsule_sm_120.jpg" onerror="this.style.display='none'"><div class="game-card-overlay"><div class="game-card-title">${g.name}</div></div>${ownershipBadge}<div class="game-check"><i class="fa-solid fa-check"></i></div></div>`;
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
        section.innerHTML = `<div class="category-header" onclick="toggleFreeGameCategory(${safeId})"><span><input type="checkbox" onclick="event.stopPropagation(); toggleFreeGameCategorySelect(this, '${cat.replace(/'/g, "\\'")}')" ${allSelected?'checked':''} style="margin-right:10px;"> <i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${cat} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="free-cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="free-cat-body-${safeId}"><div class="account-selector-list">${groups[cat].map(a => {
            const isSel = selectedFreeAccounts.includes(a.username);
            const avatar = a.avatarHash ? `https://avatars.steamstatic.com/${a.avatarHash}_full.jpg` : 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
            
            let ownershipIcon = '';
            if (selectedFreeGames.length > 0) {
                const ownsAll = selectedFreeGames.every(gid => (a.ownedGames || []).includes(gid));
                if (ownsAll) ownershipIcon = '<i class="fa-solid fa-check-double" style="color:var(--status-green);margin-left:auto;font-size:12px;" title="Already owns all selected games"></i>';
            }
            return `<div class="account-select-item ${isSel?'selected':''}" onclick="toggleFreeAccount('${a.username}')"><img src="${avatar}"><span class="account-select-name">${a.username}</span>${ownershipIcon}</div>`;
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
async function openProfileModal(u, nick) { 
    const d = await apiCall('/api/get_account', 'POST', { username: u });
    document.getElementById('profileUsername').value = u; 
    document.getElementById('profileNickname').value = nick; 
    document.getElementById('profileRealName').value = d.realName || ''; 
    document.getElementById('profileCustomURL').value = d.customURL || ''; 
    document.getElementById('profileAvatar').value = ''; 
    document.getElementById('profileModal').style.display = 'flex'; 
}
function openGuard(u) { document.getElementById('guardUsername').value = u; document.getElementById('guardModal').style.display = 'flex'; }
function openStats(date, hours) { document.getElementById('statAdded').innerText = new Date(parseInt(date)).toLocaleDateString(); document.getElementById('statBoosted').innerText = parseFloat(hours).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); document.getElementById('statsModal').style.display = 'flex'; }

async function openEditModal(u, cat, auto) { const d = await apiCall('/api/get_account', 'POST', { username: u }); document.getElementById('editOldUsername').value = d.username; document.getElementById('editUsername').value = d.username; document.getElementById('editPassword').value = ''; document.getElementById('editPassword').placeholder = '(Unchanged)'; document.getElementById('editSharedSecret').value = d.sharedSecret; document.getElementById('editProxy').value = d.proxy || ''; document.getElementById('editCategory').value = d.category || cat; document.getElementById('editAutoStart').checked = d.autoStart; document.getElementById('editModal').style.display = 'flex'; }
async function addAccount() { await apiCall('/api/accounts', 'POST', { username: document.getElementById('newUsername').value, password: document.getElementById('newPassword').value, sharedSecret: document.getElementById('newSharedSecret').value, category: document.getElementById('newCategory').value, autoStart: document.getElementById('newAutoStart').checked }); closeModals(); fetchAccounts(); }
async function bulkAddAccounts() { const data = document.getElementById('bulkData').value; const cat = document.getElementById('bulkCategory').value; let auto = document.getElementById('bulkAutoStart').checked; const wait = document.getElementById('bulkProxyWait').checked; const bundle = document.getElementById('bulkBundle').value; if(wait) auto = false; const res = await apiCall('/api/accounts/bulk', 'POST', { data, category: cat, autoStart: auto, bundle }); if(res && res.success) { showToast(`Imported ${res.count} accounts${res.skipped > 0 ? ` (${res.skipped} skipped)` : ''}${wait ? '. Add proxies now.' : ''}`, 'fa-check'); closeModals(); fetchAccounts(); } }
async function saveEdit() { await apiCall('/api/edit', 'POST', { oldUsername: document.getElementById('editOldUsername').value, newUsername: document.getElementById('editUsername').value, newPassword: document.getElementById('editPassword').value, newSharedSecret: document.getElementById('editSharedSecret').value, newCategory: document.getElementById('editCategory').value, newAutoStart: document.getElementById('editAutoStart').checked }); closeModals(); fetchAccounts(); }
async function deleteAccount(u) { if(await showConfirm('Delete Account?')) await apiCall('/api/delete', 'POST', { username: u }); fetchAccounts(); }
async function submitGuard() { await apiCall('/api/steamguard', 'POST', { username: document.getElementById('guardUsername').value, code: document.getElementById('guardCode').value }); closeModals(); fetchAccounts(); }
async function addPanelUser() { await apiCall('/api/users', 'POST', { username: document.getElementById('friendUser').value, password: document.getElementById('friendPass').value }); closeModals(); fetchUsers(); }
async function delUser(u) { if(await showConfirm('Delete User?')) await apiCall('/api/users/delete', 'POST', { username: u }); fetchUsers(); }

async function saveProfile() {
    const u = document.getElementById('profileUsername').value;
    const nick = document.getElementById('profileNickname').value;
    const realName = document.getElementById('profileRealName').value;
    const customURL = document.getElementById('profileCustomURL').value;

    const fileInput = document.getElementById('profileAvatar');
    const payload = { username: u, nickname: nick, realName, customURL };
    
    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        const reader = new FileReader();
        reader.onload = async function(e) { payload.avatar = e.target.result; await sendProfileUpdate(payload); };
        reader.readAsDataURL(file);
    } else { await sendProfileUpdate(payload); }
}

async function sendProfileUpdate(payload) {
    showToast('Updating Profile...', 'fa-spinner fa-spin');
    const res = await apiCall('/api/profile', 'POST', payload);
    if (res && res.success) { showToast('Profile Updated', 'fa-check'); closeModals(); fetchAccounts(); }
    else { alert(res ? res.error : "Error"); }
}

async function changePassword() { const d = await apiCall('/api/settings/password', 'POST', { currentPass: document.getElementById('setOldPass').value, newPass: document.getElementById('setNewPass').value }); alert(d&&d.success?"Updated":"Error"); }
async function start2FASetup() { const d = await apiCall('/api/settings/2fa/generate', 'POST'); tempSecret = d.secret; document.getElementById('qrCodeContainer').innerHTML = `<img src="${d.qr}" width="150">`; document.getElementById('modal2FA').style.display = 'flex'; }
async function enable2FA() { const d = await apiCall('/api/settings/2fa/enable', 'POST', { token: document.getElementById('verify2faInput').value, secret: tempSecret }); if(d&&d.success) { userHas2FA = true; renderSettings(); document.getElementById('modal2FA').style.display = 'none'; showToast('2FA Enabled', 'fa-check'); } else alert("Invalid Code"); }

async function fetchLibrary(u) {
    const list = document.getElementById('myLibraryList');
    list.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;">Loading owned games...</p>';
    const res = await apiCall('/api/library', 'POST', { username: u });
    list.innerHTML = '';
    ownedGames = res.games || [];
    
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
    b.innerHTML = currentSelectedGames.map(g => `<div class="tag"><span>${g.name}</span><span class="tag-id">${g.id}</span><span class="tag-x" onclick="removeGame(${g.id})">&times;</span></div>`).join('');
    const count = currentSelectedGames.length;
    const el = document.getElementById('gameCounter');
    if (count > 32) {
        el.innerHTML = `${count} <i class="fa-solid fa-circle-info" style="margin-left:5px;cursor:help;" title="Game Rotation Active: Steam allows idling max 32 games at once. Since you selected more, the bot will rotate through them in batches of 32 every hour."></i>`;
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
                    rb.innerHTML += `<div class="search-item" onclick="addGame(${g.id}, '${g.name.replace(/'/g, "\\'")}')"><span style="color:var(--status-green)">${g.name}</span> <span style="color:#666;">${g.id}</span></div>`;
                });
            }

            if (res.length > 0) {
                rb.innerHTML += `<div style="padding:5px 10px;font-size:10px;color:#666;text-transform:uppercase;font-weight:bold;border-top:1px solid #333;margin-top:5px;">Global Steam DB</div>`;
                res.forEach(g => { 
                    if (!libraryMatches.find(l => l.id === g.appid)) {
                        rb.innerHTML += `<div class="search-item" onclick="addGame(${g.appid}, '${g.name.replace(/'/g, "\\'")}')"><span>${g.name}</span><span style="color:#666;">${g.appid}</span></div>`; 
                    }
                }); 
            }
            
            if(rb.innerHTML === '') rb.innerHTML = '<div style="padding:10px;color:#666;text-align:center;font-size:12px;">No results</div>';
            rb.style.display='block'; 
        }, 300); 
    });
}

async function saveGames() { await apiCall('/api/games', 'POST', { username: document.getElementById('manageGameUsername').value, games: currentSelectedGames.map(g=>g.id), customStatus: document.getElementById('customStatus').value, personaState: document.getElementById('personaState').value }); closeModals(); fetchAccounts(); }

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
        card.innerHTML = `<h4>${k}</h4><span>${cachedBundles[k].length} Games</span><div class="bundle-actions"><button class="icon-btn" onclick="openBundleModal('${k}')"><i class="fa-solid fa-pen"></i></button><button class="icon-btn btn-trash" onclick="deleteBundleFromTab('${k}')"><i class="fa-solid fa-trash"></i></button></div>`;
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
    b.innerHTML = currentBundleGames.map(g => `<div class="tag"><span>${g.name}</span><span class="tag-id">${g.id}</span><span class="tag-x" onclick="removeBundleGame(${g.id})">&times;</span></div>`).join('');
    const count = currentBundleGames.length;
    const el = document.getElementById('bundleGameCounter');
    if (count > 32) {
        el.innerHTML = `${count} <i class="fa-solid fa-circle-info" style="margin-left:5px;cursor:help;" title="Game Rotation Active: Steam allows idling max 32 games at once. Since this bundle has more, bots will rotate through them in batches of 32 every hour."></i>`;
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
            if (res.length > 0) res.forEach(g => { rb.innerHTML += `<div class="search-item" onclick="addBundleGame(${g.appid}, '${g.name.replace(/'/g, "\\'")}')"><span>${g.name}</span><span style="color:#666;">${g.appid}</span></div>`; }); 
            else rb.innerHTML = '<div style="padding:10px;color:#666;text-align:center;font-size:12px;">No results</div>';
            rb.style.display='block'; 
        }, 300); 
    });
}

function renderLogs() {
    const q = document.getElementById('logSearch').value.toLowerCase();
    const filtered = cachedLogs.filter(l => l.toLowerCase().includes(q));
    document.getElementById('logsContainer').innerHTML = filtered.map(m=>`<div class="log-line">${m}</div>`).join('');
}

function exportLogs() {
    const text = cachedLogs.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bruddibooster_logs_${Date.now()}.txt`;
    a.click();
}

async function clearLogs() {
    if(await showConfirm("Clear all system logs?")) {
        await apiCall('/api/logs/clear', 'POST');
        fetchLogs();
    }
}

function toggleCategorySelect(cb, id) {
    const tbody = document.getElementById(`tbody-${id}`);
    if(tbody) {
        const checkboxes = tbody.querySelectorAll('.acc-select');
        checkboxes.forEach(c => c.checked = cb.checked);
        updateBulkUI();
    }
}

function updateBulkUI() {
    const selected = document.querySelectorAll('.acc-select:checked');
    const bar = document.getElementById('bulkActionsBar');
    if (selected.length > 0) {
        bar.style.display = 'flex';
        document.getElementById('selectedCount').innerText = selected.length;
    } else {
        bar.style.display = 'none';
    }
}

async function bulkAction(action) {
    const selected = Array.from(document.querySelectorAll('.acc-select:checked')).map(c => c.value);
    if (selected.length === 0) return;
    if (action === 'delete' && !await showConfirm(`Delete ${selected.length} accounts?`)) return;
    showToast(`Processing ${action} for ${selected.length} accounts...`, 'fa-gear');
    try {
        for (const username of selected) { await apiCall(`/api/${action}`, 'POST', { username }); }
    } catch (e) {
        console.error(e);
        showToast("Some actions failed. Check logs.", "fa-circle-exclamation");
    }
    document.querySelectorAll('.acc-select').forEach(c => c.checked = false);
    document.querySelectorAll('input[onchange^="toggleCategorySelect"]').forEach(c => c.checked = false);
    updateBulkUI();
    fetchAccounts();
}

async function submitBulkEdit() {
    const selected = Array.from(document.querySelectorAll('.acc-select:checked')).map(c => c.value);
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
        section.innerHTML = `<div class="category-header" onclick="toggleProxyCategory(${safeId})"><span><i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${cat} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="proxy-cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="proxy-cat-body-${safeId}"><div class="panel"><table><thead><tr><th>Username</th><th>Proxy (http://user:pass@ip:port)</th><th>Action</th></tr></thead><tbody>${groups[cat].map(a => `<tr><td style="color:var(--text-main);">${a.username}</td><td><input type="text" class="form-input proxy-input" id="proxy-${a.username}" data-user="${a.username}" data-category="${a.category||'Default'}" value="${a.proxy || ''}" placeholder="http://user:pass@ip:port"></td><td><div class="actions"><button class="icon-btn" onclick="checkProxy('${a.username}')" title="Check Proxy"><i class="fa-solid fa-stethoscope"></i></button><button class="icon-btn" onclick="saveProxy('${a.username}')" title="Apply Proxy"><i class="fa-solid fa-check"></i></button><button class="icon-btn btn-trash" onclick="deleteProxy('${a.username}')" title="Remove Proxy"><i class="fa-solid fa-trash"></i></button></div></td></tr>`).join('')}</tbody></table></div></div>`;
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
        if(!silent) showToast(`Success! IP: ${res.ip}`, 'fa-check');
        input.style.borderColor = 'var(--status-green)';
        return true;
    } else {
        if (spareProxies.length > 0) {
            const newProxy = spareProxies.shift();
            input.value = newProxy;
            showToast(`Proxy failed for ${username}. Replaced with spare.`, 'fa-rotate');
            return await checkProxy(username, silent);
        }
        if(!silent) showToast(`Failed: ${res ? res.msg : 'Error'}`, 'fa-circle-xmark');
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

async function testAllProxies() {
    const inputs = Array.from(document.querySelectorAll('.proxy-input')).filter(i => i.value.trim());
    if(inputs.length === 0) return showToast("No proxies to test", "fa-circle-exclamation");
    
    showToast(`Testing ${inputs.length} proxies (5 threads)...`, "fa-stethoscope");
    
    let successCount = 0;
    let removedCount = 0;
    const CONCURRENCY = 5;
    const queue = [...inputs];
    const workers = [];

    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const input = queue.shift();
                const result = await checkProxy(input.dataset.user, true);
                if (result) {
                    successCount++;
                } else {
                    input.value = '';
                    input.style.borderColor = '';
                    removedCount++;
                }
            }
        })());
    }
    
    await Promise.all(workers);
    await saveAllProxies();
    
    showToast(`Testing Complete. ${successCount} working, ${removedCount} removed & saved.`, "fa-check-double");
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
    const res = await apiCall('/api/accounts/export');
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