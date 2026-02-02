let authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
let currentUserRole = localStorage.getItem('userRole') || sessionStorage.getItem('userRole');
let userHas2FA = false;

(async function init() {
    if (authToken) {
        const res = await fetch('/api/verify_session', { headers: { 'Authorization': authToken } });
        const d = await res.json();
        if (d.success) { loadApp(); document.getElementById('loginOverlay').style.display = 'none'; currentUserRole = d.role; userHas2FA = d.has2FA; }
        else { localStorage.removeItem('authToken'); sessionStorage.removeItem('authToken'); document.getElementById('loginOverlay').style.display = 'flex'; }
    } else {
        const savedUser = localStorage.getItem('rememberedUser');
        if (savedUser) { document.getElementById('panelUser').value = savedUser; document.getElementById('rememberMe').checked = true; }
    }
})();

function showToast(msg, icon='fa-circle-info') { const c = document.getElementById('toast-container'); const t = document.createElement('div'); t.className='toast'; t.innerHTML=`<i class="fa-solid ${icon}"></i><span>${msg}</span>`; c.appendChild(t); setTimeout(()=>{ t.style.animation='slideOut 0.3s ease-in forwards'; setTimeout(()=>t.remove(),300); },3000); }

async function apiCall(endpoint, method='GET', body=null) {
    const headers = { 'Content-Type': 'application/json' }; if(authToken) headers['Authorization'] = authToken;
    const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : null });
    if (res.status === 401) { document.getElementById('loginOverlay').style.display='flex'; localStorage.removeItem('authToken'); sessionStorage.removeItem('authToken'); return null; }
    return res.json();
}

async function performLogin(is2FA = false) {
    const u = document.getElementById('panelUser').value.trim(); const p = document.getElementById('panelPass').value; const t = document.getElementById('panel2FA').value.trim(); const remember = document.getElementById('rememberMe').checked;
    const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username:u, password:p, token: is2FA ? t : null }) });
    const d = await res.json();
    if (d.requires2fa) { document.getElementById('loginStep1').classList.add('hidden'); document.getElementById('loginStep2').classList.remove('hidden'); document.getElementById('loginError').style.display='none'; document.getElementById('panel2FA').value = ''; }
    else if (d.success) {
        authToken = d.token; currentUserRole = d.role; userHas2FA = d.has2FA;
        if(remember) { localStorage.setItem('authToken', authToken); localStorage.setItem('userRole', d.role); localStorage.setItem('rememberedUser', u); }
        else { sessionStorage.setItem('authToken', authToken); sessionStorage.setItem('userRole', d.role); localStorage.removeItem('rememberedUser'); }
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