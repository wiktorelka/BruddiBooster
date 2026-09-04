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
function showToast(msg, icon='fa-circle-info') { const c = document.getElementById('toast-container'); const t = document.createElement('div'); t.className='toast'; t.innerHTML=`<i class="fa-solid ${icon}"></i><span>${escHtml(msg)}</span>`; c.appendChild(t); setTimeout(()=>{ t.style.animation='slideOut 0.3s ease-in forwards'; setTimeout(()=>t.remove(),300); },3000); }

async function apiCall(endpoint, method='GET', body=null) {
    const headers = { 'Content-Type': 'application/json' };
    // Double-submit CSRF: the cookie rides along automatically, so we must prove we
    // can read the companion token a cross-site page cannot.
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken || readCookie('bb_csrf') || '';
    const res = await fetch(endpoint, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : null });
    if (res.status === 401) {
        authToken = null;
        document.getElementById('loginOverlay').style.display = 'flex';
        return null;
    }
    if (res.status === 403) {
        // Usually a stale CSRF token after a re-login in another tab.
        csrfToken = readCookie('bb_csrf');
    }
    try { return await res.json(); } catch (e) { return null; }
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