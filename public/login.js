const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

// The session token now lives in an httpOnly cookie the page cannot read, so there
// is nothing sensitive to keep here. authToken is only a "are we signed in" flag.
let authToken = null;
let csrfToken = null;
let currentUserRole = null;
let currentUsername = null;
let userHas2FA = false;

// Clean up tokens left in storage by the previous version.
try { localStorage.removeItem('authToken'); sessionStorage.removeItem('authToken');
      localStorage.removeItem('userRole'); sessionStorage.removeItem('userRole'); } catch (e) {}

function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
}

(async function init() {
    // The cookie is sent automatically; just ask the server who we are.
    const res = await fetch('/api/verify_session', { credentials: 'same-origin' });
    const d = await res.json();
    if (d.success) {
        authToken = true;
        csrfToken = d.csrf || readCookie('bb_csrf');
        currentUserRole = d.role; currentUsername = d.username; userHas2FA = d.has2FA;
        loadApp();
        document.getElementById('loginOverlay').style.display = 'none';
    } else {
        document.getElementById('loginOverlay').style.display = 'flex';
        const savedUser = localStorage.getItem('rememberedUser');
        if (savedUser) { document.getElementById('panelUser').value = savedUser; document.getElementById('rememberMe').checked = true; }
    }
})();

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// --- DELEGATED EVENT DISPATCH ---
// This lives here rather than in dashboard.js because dashboard.js is only fetched
// after a successful login, while the Login button itself carries data-act. Previously
// the button did nothing (Enter still worked, since the inputs bind keypress directly).
// Delegated on document, so it also covers dashboard markup injected later.

// Allow-list of action names the delegated dispatcher may invoke. Held as strings and
// resolved against the global scope at dispatch time: several handlers are assigned
// via `window.x = function` further down the file, so referencing them directly here
// would throw before those lines run.
const ACTIONS = new Set([
    'addAccount',
    'addAllLibraryGames',
    'addBundle',
    'addBundleGame',
    'addGame',
    'addPanelUser',
    'bulkAction',
    'bulkAddAccounts',
    'changePassword',
    'checkProxy',
    'clearAllGames',
    'clearLogs',
    'closeModals',
    'delUser',
    'deleteAccount',
    'deleteBundleFromTab',
    'deleteProxy',
    'disable2FA',
    'downloadBackup',
    'enable2FA',
    'exportAccounts',
    'exportLogs',
    'fetchLogs',
    'handleAction',
    'hideEl',
    'loadBundle',
    'loadFreeGamesPreset',
    'logout',
    'onAccSelect',
    'openBulkEditModal',
    'openBulkProxyModal',
    'openBundleModal',
    'openEditModal',
    'openGamesModal',
    'openGuard',
    'openStats',
    'openUserModal',
    'panicStop',
    'performLogin',
    'pickRestoreFile',
    'refreshLibraryAPI',
    'removeBundleGame',
    'removeGame',
    'renderFreeGamesUI',
    'resolveConfirm',
    'restartAllBots',
    'restoreBackup',
    'saveAllProxies',
    'saveBundleFromTab',
    'saveEdit',
    'saveFreeGamesPreset',
    'saveGames',
    'saveGlobalPool',
    'saveGlobalSettings',
    'saveProxy',
    'setStatusFilter',
    'sortAccounts',
    'start2FASetup',
    'submitBulkEdit',
    'submitBulkProxyImport',
    'submitFreeGames',
    'submitGuard',
    'switchTab',
    'testAllProxies',
    'testWebhook',
    'toggleAllFreeAccounts',
    'toggleAllFreeGames',
    'toggleCategory',
    'toggleCategorySelect',
    'toggleFreeAccount',
    'toggleFreeGame',
    'toggleFreeGameCategory',
    'toggleFreeGameCategorySelect',
    'toggleHideOwned',
    'toggleIp',
    'toggleMobileMenu',
    'toggleProxyCategory',
    'toggleScheduleFields',
    'toggleTheme',
]);

function resolveAction(name) {
    if (!ACTIONS.has(name)) { console.warn('Blocked unknown action:', name); return null; }
    const fn = window[name];
    if (typeof fn !== 'function') { console.warn('Action not defined:', name); return null; }
    return fn;
}

function runAction(el, ev) {
    const name = el.getAttribute('data-act');
    if (!name) return;
    const fn = resolveAction(name);
    if (!fn) return;
    let args = [];
    const raw = el.getAttribute('data-a');
    if (raw) { try { args = JSON.parse(raw); } catch (e) { args = []; } }
    args = args.map(a => a === '$this' ? el : a === '$event' ? ev : a);
    if (el.hasAttribute('data-stop')) ev.stopPropagation();
    fn.apply(el, args);
}

function initDelegatedEvents(root) {
    root.addEventListener('click', (ev) => {
        const el = ev.target.closest('[data-act]');
        if (el && root.contains(el)) runAction(el, ev);
    });
    root.addEventListener('change', (ev) => {
        const el = ev.target.closest('[data-act-change]');
        if (!el) return;
        const name = el.getAttribute('data-act-change');
        const fn = resolveAction(name);
        if (!fn) return;
        let args = [];
        const raw = el.getAttribute('data-a');
        if (raw) { try { args = JSON.parse(raw); } catch (e) { args = []; } }
        fn.apply(el, args.map(a => a === '$this' ? el : a === '$event' ? ev : a));
    });
    // Broken avatars: error doesn't bubble, so listen in the capture phase.
    root.addEventListener('error', (ev) => {
        const t = ev.target;
        if (t && t.tagName === 'IMG' && t.hasAttribute('data-hide-on-error')) t.style.display = 'none';
    }, true);
}

function showToast(msg, icon='fa-circle-info') { const c = document.getElementById('toast-container'); const t = document.createElement('div'); t.className='toast'; t.innerHTML=`<i class="fa-solid ${icon}"></i><span>${escHtml(msg)}</span>`; c.appendChild(t); setTimeout(()=>{ t.style.animation='slideOut 0.3s ease-in forwards'; setTimeout(()=>t.remove(),300); },3000); }

// The cookie is the source of truth: the server reissues it on every login, so a page
// that has been open across a re-login (another tab, or a server restart) would
// otherwise keep sending a token that no longer matches its session.
function currentCsrf() { return readCookie('bb_csrf') || csrfToken || ''; }

async function apiCall(endpoint, method='GET', body=null, _retryToken=null) {
    const headers = { 'Content-Type': 'application/json' };
    // Double-submit CSRF: the cookie rides along automatically, so we must prove we
    // can read the companion token a cross-site page cannot. On a retry we use the
    // token the server just handed back rather than re-reading the cookie, which may
    // be what was stale in the first place.
    if (method !== 'GET') headers['X-CSRF-Token'] = _retryToken || currentCsrf();
    const res = await fetch(endpoint, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : null });
    if (res.status === 401) {
        authToken = null;
        document.getElementById('loginOverlay').style.display = 'flex';
        return null;
    }
    if (res.status === 403 && !_retryToken) {
        // Re-sync from the server and retry once. A genuinely forbidden action fails
        // again below; only a stale token is fixed by this.
        const vs = await fetch('/api/verify_session', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null);
        if (vs && vs.success && vs.csrf) {
            csrfToken = vs.csrf;
            return apiCall(endpoint, method, body, vs.csrf);
        }
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) { payload = null; }
    if (!res.ok) {
        // Surface what the server said rather than a bare "Error". A 404 here means
        // the client is calling a route that doesn't exist, which is worth seeing.
        const msg = (payload && (payload.error || payload.msg)) || `${res.status} ${res.statusText}`;
        if (typeof showToast === 'function') showToast(msg, 'fa-circle-xmark');
        return payload && typeof payload === 'object' ? { ...payload, ok: false } : null;
    }
    return payload;
}

async function performLogin(is2FA = false) {
    const u = document.getElementById('panelUser').value.trim(); const p = document.getElementById('panelPass').value; const t = document.getElementById('panel2FA').value.trim(); const remember = document.getElementById('rememberMe').checked;
    const res = await fetch('/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'same-origin',
        body: JSON.stringify({ username:u, password:p, token: is2FA ? t : null, remember })
    });
    const d = await res.json();
    if (d.requires2fa) { document.getElementById('loginStep1').classList.add('hidden'); document.getElementById('loginStep2').classList.remove('hidden'); document.getElementById('loginError').style.display='none'; document.getElementById('panel2FA').value = ''; }
    else if (d.success) {
        authToken = true; csrfToken = d.csrf; currentUserRole = d.role; currentUsername = d.username; userHas2FA = d.has2FA;
        if (remember) localStorage.setItem('rememberedUser', u); else localStorage.removeItem('rememberedUser');
        document.getElementById('panelPass').value = ''; document.getElementById('panel2FA').value = '';
        loadApp(); document.getElementById('loginOverlay').style.display='none'; showToast(`Welcome back, ${u}!`, 'fa-door-open');
    } else { document.getElementById('loginError').style.display='block'; document.getElementById('loginError').innerText=d.msg||"Invalid credentials"; }
}

function loadApp() {
    const root = document.getElementById('app-root');
    if (root.innerHTML.trim() !== '') return;
    const tmpl = document.getElementById('protected-view');
    root.appendChild(tmpl.content.cloneNode(true));
    
    // Dynamically load the dashboard logic only after login
    const script = document.createElement('script');
    script.src = '/dashboard.js?v=' + Date.now();
    script.onload = () => { if(window.onDashboardLoaded) window.onDashboardLoaded(); };
    document.body.appendChild(script);
}

document.getElementById('panelPass').addEventListener("keypress", (e) => { if (e.key === "Enter") performLogin(); });
document.getElementById('panel2FA').addEventListener("keypress", (e) => { if (e.key === "Enter") performLogin(true); });

// Bind as soon as the document exists, so the login screen is interactive too.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initDelegatedEvents(document));
} else {
    initDelegatedEvents(document);
}
