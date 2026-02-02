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
    setInterval(() => { if(authToken && activeTab === 'dash') fetchAccounts(); }, 3000);
};

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active')); document.getElementById(`nav-${tab}`).classList.add('active');
    ['dash','users','logs','settings','bundles'].forEach(v => document.getElementById(`view-${v}`).style.display='none');
    document.getElementById(`view-${tab}`).style.display='block';
    if(tab==='dash') fetchAccounts(); if(tab==='users') fetchUsers(); if(tab==='logs') fetchLogs(); if(tab==='settings') renderSettings(); if(tab==='bundles') fetchBundlesView();
}

async function logout() { await apiCall('/api/logout', 'POST'); localStorage.removeItem('authToken'); localStorage.removeItem('userRole'); sessionStorage.removeItem('authToken'); sessionStorage.removeItem('userRole'); location.reload(); }
async function handleAction(action, username) { showToast(`${action} ${username}...`, 'fa-gear'); await apiCall(`/api/${action}`, 'POST', { username }); fetchAccounts(); }

// RENDER SETTINGS based on 2FA status
function renderSettings() {
    const area = document.getElementById('2fa-content-area');
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

async function disable2FA() {
    if(confirm("Disable 2FA?")) {
        const res = await apiCall('/api/settings/2fa/disable', 'POST');
        if(res && res.success) { userHas2FA = false; renderSettings(); showToast('2FA Disabled', 'fa-shield-halved'); }
    }
}

function toggleCategory(id) {
    const body = document.getElementById(`cat-body-${id}`);
    const icon = document.getElementById(`cat-icon-${id}`);
    const isHidden = body.classList.contains('hidden');
    if (isHidden) { body.classList.remove('hidden'); icon.classList.remove('rotated'); categoryStates[id] = true; }
    else { body.classList.add('hidden'); icon.classList.add('rotated'); categoryStates[id] = false; }
}

function getStatusHtml(acc) {
    const isRunning = acc.status === 'Running';
    if(isRunning) return `<span class="st-running">Running</span>`;
    if(acc.status==='Need Guard') return `<span class="st-guard">Guard</span>`;
    if(acc.status==='Logging in...') return `<span class="st-logging">Logging in...</span>`;
    if(acc.status.includes('Rate Limit')) return `<span class="st-guard" style="cursor:help; border-bottom:1px dotted var(--status-yellow);" title="${(acc.lastError||'').replace(/"/g, '&quot;')}">${acc.status}</span>`;
    if (acc.status === 'Error' && acc.lastError) return `<span class="st-stopped" style="cursor:help; border-bottom:1px dotted var(--btn-red);" title="${acc.lastError.replace(/"/g, '&quot;')}">ERROR</span>`;
    return `<span class="st-stopped">${acc.status}</span>`;
}

function getActionsHtml(acc) {
    const isRunning = acc.status === 'Running';
    const gamesJson = JSON.stringify(acc.games).replace(/"/g, '&quot;');
    const profileBtn = acc.steamId ? `<a href="https://steamcommunity.com/profiles/${acc.steamId}" target="_blank" class="icon-btn"><i class="fa-solid fa-up-right-from-square"></i></a>` : '';
    return `${isRunning?`<button class="icon-btn btn-stop-action" onclick="handleAction('stop','${acc.username}')"><i class="fa-solid fa-stop"></i></button><button class="icon-btn" onclick="handleAction('restart','${acc.username}')"><i class="fa-solid fa-rotate-right"></i></button>`:`<button class="icon-btn btn-play" onclick="handleAction('start','${acc.username}')"><i class="fa-solid fa-play"></i></button>`}<button class="icon-btn" style="width:auto;padding:0 12px;gap:6px;" onclick="openGamesModal('${acc.username}', ${gamesJson}, '${acc.customStatus||''}', ${acc.personaState})"><i class="fa-solid fa-gamepad"></i> <span style="font-size:11px;font-weight:600;">${acc.games.length}/32</span></button><button class="icon-btn" onclick="openStats('${acc.addedAt}', ${acc.boostedHours})"><i class="fa-solid fa-chart-line"></i></button>${profileBtn}<button class="icon-btn" onclick="openEditModal('${acc.username}', '${acc.category||''}', ${acc.autoStart})"><i class="fa-solid fa-pen"></i></button><button class="icon-btn btn-trash" onclick="deleteAccount('${acc.username}')"><i class="fa-solid fa-trash"></i></button>${acc.status==='Need Guard'?`<button class="icon-btn" style="color:var(--status-yellow);border-color:var(--status-yellow);" onclick="openGuard('${acc.username}')"><i class="fa-solid fa-key"></i></button>`:''}`;
}

function renderTable(accounts) {
    document.getElementById('totalAccounts').innerText = accounts.length;
    document.getElementById('activeBoosters').innerText = accounts.filter(a => a.status==='Running').length;
    document.getElementById('totalHours').innerText = accounts.reduce((a,c) => a + parseFloat(c.grandTotal||0), 0).toFixed(1) + 'h';

    let rebuild = false;
    const existing = document.querySelectorAll('tr[id^="tr-"]');
    if (existing.length !== accounts.length) rebuild = true;
    else { for (const acc of accounts) { const row = document.getElementById(`tr-${acc.username}`); if (!row || row.dataset.category !== (acc.category || 'Default')) { rebuild = true; break; } } }

    if (!rebuild) {
        accounts.forEach(acc => {
            const row = document.getElementById(`tr-${acc.username}`);
                    const newStatus = getStatusHtml(acc); if (row.cells[2].innerHTML !== newStatus) row.cells[2].innerHTML = newStatus;
                    const newHours = `${acc.grandTotal}h`; if (row.cells[3].innerText !== newHours) row.cells[3].innerText = newHours;
            const hasStopBtn = row.querySelector('.btn-stop-action'); const isRunning = acc.status === 'Running';
                    if ((isRunning && !hasStopBtn) || (!isRunning && hasStopBtn)) row.cells[4].innerHTML = `<div class="actions">${getActionsHtml(acc)}</div>`;
        });
        return;
    }

    const container = document.getElementById('accountsContainer'); container.innerHTML = '';
    const groups = {};
    accounts.forEach(acc => { const cat = acc.category || 'Default'; if(!groups[cat]) groups[cat] = []; groups[cat].push(acc); });
    const sortedCats = Object.keys(groups).sort((a,b) => { if(a==='Default') return -1; if(b==='Default') return 1; return a.localeCompare(b); });

    sortedCats.forEach((cat, index) => {
        const safeId = index;
        const isExpanded = categoryStates[safeId] !== undefined ? categoryStates[safeId] : true;
        const section = document.createElement('div');
        section.className = 'category-section';
        section.innerHTML = `<div class="category-header" onclick="toggleCategory(${safeId})"><span><i class="fa-solid fa-folder-open" style="color:var(--accent);margin-right:10px;"></i> ${cat} <span style="color:var(--text-muted);font-size:12px;margin-left:5px;">(${groups[cat].length})</span></span><i class="fa-solid fa-chevron-up cat-icon ${!isExpanded?'rotated':''}" id="cat-icon-${safeId}"></i></div><div class="category-body ${!isExpanded?'hidden':''}" id="cat-body-${safeId}"><div class="panel"><table><thead><tr><th style="width:40px;text-align:center;"><input type="checkbox" onchange="toggleCategorySelect(this, ${safeId})"></th><th>User</th><th>Status</th><th>Hours</th><th>Actions</th></tr></thead><tbody id="tbody-${safeId}"></tbody></table></div></div>`;
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
        tr.innerHTML = `<td style="text-align:center;"><input type="checkbox" class="acc-select" value="${acc.username}" onchange="updateBulkUI()"></td><td><div class="user-cell"><img src="${avatarUrl}" class="user-avatar" alt="Avatar"><div class="user-details"><div><span class="user-nick">${acc.nickname||acc.username}</span>${autoStartIcon}</div><span class="user-name">${acc.username}</span></div></div></td><td>${getStatusHtml(acc)}</td><td style="color:white;font-weight:600;">${acc.grandTotal}h</td><td><div class="actions">${getActionsHtml(acc)}</div></td>`;
        return tr;
}

function applyAccountFilter() {
    const q = document.getElementById('accountSearch').value.toLowerCase();
    const filtered = cachedAccounts.filter(a => a.username.toLowerCase().includes(q));
    renderTable(filtered);
}

async function fetchAccounts() { const d = await apiCall('/api/accounts'); if(d) { cachedAccounts = d; applyAccountFilter(); } }
async function fetchLogs() { cachedLogs = await apiCall('/api/logs'); renderLogs(); }
async function fetchUsers() { const u = await apiCall('/api/users'); document.getElementById('usersTableBody').innerHTML = u.map(x=>`<tr><td style="color:white;">${x.username}</td><td style="color:#888;">${x.role}</td><td>${x.role!=='admin'?`<button class="icon-btn btn-trash" onclick="delUser('${x.username}')"><i class="fa-solid fa-trash"></i></button>`:''}</td></tr>`).join(''); }

function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none'); }
function openAddModal() { document.getElementById('newUsername').value=''; document.getElementById('newPassword').value=''; document.getElementById('newCategory').value=''; document.getElementById('newAutoStart').checked=false; document.getElementById('addModal').style.display='flex'; }
async function openBulkModal() { document.getElementById('bulkData').value=''; document.getElementById('bulkCategory').value=''; document.getElementById('bulkAutoStart').checked=false; const b = await apiCall('/api/bundles'); const s = document.getElementById('bulkBundle'); s.innerHTML='<option value="">Default (CS2)</option>'; for(const k in b) { const o=document.createElement('option'); o.value=k; o.innerText=`${k} (${b[k].length})`; s.appendChild(o); } document.getElementById('bulkModal').style.display='flex'; }
function openUserModal() { document.getElementById('friendUser').value=''; document.getElementById('friendPass').value=''; document.getElementById('addUserModal').style.display='flex'; }
function openGuard(u) { document.getElementById('guardUsername').value = u; document.getElementById('guardModal').style.display = 'flex'; }
function openStats(date, hours) { document.getElementById('statAdded').innerText = new Date(parseInt(date)).toLocaleDateString(); document.getElementById('statBoosted').innerText = parseFloat(hours).toFixed(1); document.getElementById('statsModal').style.display = 'flex'; }

async function openEditModal(u, cat, auto) { const d = await apiCall('/api/get_account', 'POST', { username: u }); document.getElementById('editOldUsername').value = d.username; document.getElementById('editUsername').value = d.username; document.getElementById('editPassword').value = d.password; document.getElementById('editSharedSecret').value = d.sharedSecret; document.getElementById('editCategory').value = d.category || cat; document.getElementById('editAutoStart').checked = d.autoStart; document.getElementById('editModal').style.display = 'flex'; }
async function addAccount() { await apiCall('/api/accounts', 'POST', { username: document.getElementById('newUsername').value, password: document.getElementById('newPassword').value, sharedSecret: document.getElementById('newSharedSecret').value, category: document.getElementById('newCategory').value, autoStart: document.getElementById('newAutoStart').checked }); closeModals(); fetchAccounts(); }
async function bulkAddAccounts() { const data = document.getElementById('bulkData').value; const cat = document.getElementById('bulkCategory').value; const auto = document.getElementById('bulkAutoStart').checked; const bundle = document.getElementById('bulkBundle').value; const res = await apiCall('/api/accounts/bulk', 'POST', { data, category: cat, autoStart: auto, bundle }); if(res && res.success) { showToast(`Imported ${res.count} accounts`, 'fa-check'); closeModals(); fetchAccounts(); } }
async function saveEdit() { await apiCall('/api/edit', 'POST', { oldUsername: document.getElementById('editOldUsername').value, newUsername: document.getElementById('editUsername').value, newPassword: document.getElementById('editPassword').value, newSharedSecret: document.getElementById('editSharedSecret').value, newCategory: document.getElementById('editCategory').value, newAutoStart: document.getElementById('editAutoStart').checked }); closeModals(); fetchAccounts(); }
async function deleteAccount(u) { if(confirm('Delete Account?')) await apiCall('/api/delete', 'POST', { username: u }); fetchAccounts(); }
async function submitGuard() { await apiCall('/api/steamguard', 'POST', { username: document.getElementById('guardUsername').value, code: document.getElementById('guardCode').value }); closeModals(); fetchAccounts(); }
async function addPanelUser() { await apiCall('/api/users', 'POST', { username: document.getElementById('friendUser').value, password: document.getElementById('friendPass').value }); closeModals(); fetchUsers(); }
async function delUser(u) { if(confirm('Delete User?')) await apiCall('/api/users/delete', 'POST', { username: u }); fetchUsers(); }

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
    const b = document.getElementById('selectedGamesBox'); b.innerHTML = ''; 
    currentSelectedGames.forEach(g => b.innerHTML += `<div class="tag"><span>${g.name}</span><span class="tag-id">${g.id}</span><span class="tag-x" onclick="removeGame(${g.id})">&times;</span></div>`);
    document.getElementById('gameCounter').innerText = `${currentSelectedGames.length}/32`;
    document.getElementById('gameCounter').style.color = currentSelectedGames.length >= 32 ? 'var(--btn-red)' : 'var(--text-muted)';
}
function removeGame(id) { currentSelectedGames = currentSelectedGames.filter(g=>g.id!==id); renderTags(); }
function addGame(id, name) { if(currentSelectedGames.length>=32) return alert('Max 32'); if(!currentSelectedGames.find(g=>g.id===id)) currentSelectedGames.push({id,name}); renderTags(); document.getElementById('gameSearch').value=''; document.getElementById('searchResults').style.display='none'; }

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
    currentSelectedGames = [...availableBundles[name]].slice(0, 32);
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
    if (confirm(`Delete bundle "${name}"?`)) { await apiCall('/api/bundles/delete', 'POST', { name }); fetchBundlesView(); }
}

function renderBundleTags() {
    const b = document.getElementById('selectedBundleGamesBox'); b.innerHTML = '';
    currentBundleGames.forEach(g => b.innerHTML += `<div class="tag"><span>${g.name}</span><span class="tag-id">${g.id}</span><span class="tag-x" onclick="removeBundleGame(${g.id})">&times;</span></div>`);
    document.getElementById('bundleGameCounter').innerText = `${currentBundleGames.length}/32`;
}
function removeBundleGame(id) { currentBundleGames = currentBundleGames.filter(g=>g.id!==id); renderBundleTags(); }
function addBundleGame(id, name) { if(currentBundleGames.length>=32) return alert('Max 32'); if(!currentBundleGames.find(g=>g.id===id)) currentBundleGames.push({id,name}); renderBundleTags(); document.getElementById('bundleGameSearch').value=''; document.getElementById('bundleSearchResults').style.display='none'; }

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
    if (action === 'delete' && !confirm(`Delete ${selected.length} accounts?`)) return;
    showToast(`Processing ${action} for ${selected.length} accounts...`, 'fa-gear');
    for (const username of selected) { await apiCall(`/api/${action}`, 'POST', { username }); }
    document.querySelectorAll('.acc-select').forEach(c => c.checked = false);
    document.querySelectorAll('input[onchange^="toggleCategorySelect"]').forEach(c => c.checked = false);
    updateBulkUI();
    fetchAccounts();
}