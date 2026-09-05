/*
 * Client-side auth plumbing.
 *
 * A page left open across a re-login (another tab, or a server restart) kept sending
 * the CSRF token it captured at load, while the server had issued a new one in the
 * cookie. Every action then failed with "Bad CSRF token" until a manual refresh.
 * The cookie is authoritative; these assert that, and that a stale token self-heals.
 *
 * Run: node test/client-auth.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { failures.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

function makeEnv({ cookie, fetchImpl }) {
    const els = {};
    const mk = () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        addEventListener(){}, appendChild(){}, remove(){}, value: '', checked: false, innerHTML: '', options: [],
        setAttribute(){}, getAttribute(){ return null; }, hasAttribute(){ return false; },
        querySelectorAll(){ return []; }, querySelector(){ return mk(); }, content: { cloneNode(){ return {}; } } });
    const docListeners = {};
    const sandbox = {
        console,
        document: { cookie, readyState: 'complete', getElementById: id => els[id] || (els[id] = mk()),
            querySelectorAll: () => [], querySelector: () => mk(), createElement: () => mk(),
            body: { appendChild(){} }, contains: () => true,
            addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
            hidden: false },
        localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
        fetch: fetchImpl,
        setTimeout, clearTimeout, setInterval, clearInterval,
    };
    sandbox._listeners = docListeners;
    sandbox.sessionStorage = sandbox.localStorage;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'login.js'), 'utf8'), sandbox, { filename: 'login.js' });
    return sandbox;
}

(async () => {
    console.log('=== client auth plumbing ===\n');

    // 1. The cookie wins over whatever the page captured at load time.
    {
        const env = makeEnv({ cookie: 'bb_csrf=FRESH', fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ success: false }) }) });
        env.csrfToken = 'STALE';
        check('cookie takes priority over the in-memory token',
            env.currentCsrf() === 'FRESH', 'got ' + env.currentCsrf());
    }

    // 2. Falls back to memory when the cookie is unreadable (e.g. a Secure cookie on
    //    a plain-http page). Driven through the real login path, since `let` at script
    //    scope can't be injected from outside.
    {
        const env = makeEnv({
            cookie: '',
            fetchImpl: async (url) => url === '/api/login'
                ? { status: 200, ok: true, json: async () => ({ success: true, csrf: 'FROM-LOGIN', role: 'admin', username: 'admin' }) }
                : { status: 200, ok: true, json: async () => ({ success: false }) }
        });
        await env.performLogin();
        check('falls back to the in-memory token when no cookie is readable',
            env.currentCsrf() === 'FROM-LOGIN', 'got ' + JSON.stringify(env.currentCsrf()));
    }

    // 3. A stale token gets refreshed and the request retried exactly once.
    {
        const calls = [];
        const env = makeEnv({
            cookie: 'bb_csrf=STALE',
            fetchImpl: async (url, opts = {}) => {
                calls.push({ url, csrf: (opts.headers || {})['X-CSRF-Token'] });
                if (url === '/api/verify_session') {
                    return { status: 200, ok: true, json: async () => ({ success: true, csrf: 'REISSUED' }) };
                }
                const sent = (opts.headers || {})['X-CSRF-Token'];
                if (sent !== 'REISSUED') return { status: 403, ok: false, json: async () => ({ error: 'Bad CSRF token' }) };
                return { status: 200, ok: true, json: async () => ({ success: true }) };
            }
        });
        const res = await env.apiCall('/api/library/refresh', 'POST', { username: 'x' });
        check('a stale CSRF token is refreshed and the call retried',
            res && res.success === true, JSON.stringify(res));
        check('it re-syncs via verify_session',
            calls.some(c => c.url === '/api/verify_session'), JSON.stringify(calls.map(c => c.url)));
        check('the retry carries the reissued token',
            calls[calls.length - 1].csrf === 'REISSUED', calls[calls.length - 1].csrf);
        check('it retries only once (no loop)',
            calls.filter(c => c.url === '/api/library/refresh').length === 2,
            calls.filter(c => c.url === '/api/library/refresh').length + ' attempts');
    }

    // 4. A genuine 403 (not a CSRF problem) must not retry forever.
    {
        let attempts = 0;
        const env = makeEnv({
            cookie: 'bb_csrf=GOOD',
            fetchImpl: async (url, opts = {}) => {
                if (url === '/api/verify_session') return { status: 200, ok: true, json: async () => ({ success: true, csrf: 'GOOD' }) };
                attempts++;
                return { status: 403, ok: false, json: async () => ({ error: 'Not allowed' }) };
            }
        });
        await env.apiCall('/api/backup', 'POST', {});
        check('a genuinely forbidden action stops after one retry',
            attempts === 2, attempts + ' attempts');
    }

    // 5. GET requests carry no CSRF header (they are not state-changing).
    {
        let sentHeader = 'unset';
        const env = makeEnv({
            cookie: 'bb_csrf=GOOD',
            fetchImpl: async (url, opts = {}) => {
                sentHeader = (opts.headers || {})['X-CSRF-Token'];
                return { status: 200, ok: true, json: async () => ({}) };
            }
        });
        await env.apiCall('/api/accounts');
        check('GET requests send no CSRF header', sentHeader === undefined, String(sentHeader));
    }

    // 6. The Login button must work before dashboard.js exists.
    //    The dispatcher used to live in dashboard.js, which is only loaded AFTER a
    //    successful login -- so clicking Login did nothing, while Enter still worked
    //    because the inputs bind keypress directly.
    {
        const loginPosts = [];
        const env = makeEnv({
            cookie: '',
            fetchImpl: async (url, opts = {}) => {
                if (url === '/api/login') { loginPosts.push(JSON.parse(opts.body)); return { status: 200, ok: true, json: async () => ({ success: true, csrf: 'C', role: 'admin', username: 'admin' }) }; }
                return { status: 200, ok: true, json: async () => ({ success: false }) };
            }
        });
        const clicks = env._listeners['click'] || [];
        check('a click listener is bound on the login screen', clicks.length === 1, clicks.length + ' listeners');

        const btn = (attrs) => ({ tagName: 'BUTTON', style: {}, _a: attrs,
            getAttribute: n => (n in attrs ? attrs[n] : null),
            hasAttribute: n => n in attrs,
            closest: sel => (sel.replace(/[\[\]]/g, '') in attrs ? btn(attrs) : null) });

        clicks.forEach(h => h({ target: btn({ 'data-act': 'performLogin' }), stopPropagation(){} }));
        await new Promise(r => setTimeout(r, 30));
        check('clicking Login actually submits', loginPosts.length === 1, JSON.stringify(loginPosts));

        loginPosts.length = 0;
        clicks.forEach(h => h({ target: btn({ 'data-act': 'performLogin', 'data-a': '[true]' }), stopPropagation(){} }));
        await new Promise(r => setTimeout(r, 30));
        check('clicking Verify submits with the 2FA code',
            loginPosts.length === 1 && 'token' in loginPosts[0], JSON.stringify(loginPosts));
    }

    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('PASS - CSRF handling is self-healing.');
    process.exit(0); // toast timers from the simulated login would otherwise keep us alive
})();
