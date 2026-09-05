/*
 * Every endpoint the browser calls must exist on the server.
 *
 * Two buttons ("Refresh" in Manage Games, and Save in Manage Games) posted to routes
 * that were deleted with the abandoned src/ refactor. Saving games looked like it
 * worked -- the modal closed and the list refreshed -- while nothing was persisted.
 * A 404 from a fetch is not an exception, so nothing surfaced.
 *
 * Run: node test/api-contract.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const client = ['public/dashboard.js', 'public/login.js']
    .map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');

// --- what the server actually serves ---
const routes = new Set();
for (const m of server.matchAll(/app\.(get|post|put|delete)\(\s*'([^']+)'/g)) {
    routes.add(`${m[1].toUpperCase()} ${m[2]}`);
}

// --- what the client asks for ---
const calls = new Map(); // "METHOD /path" -> source snippet
function addCall(method, url, snippet) {
    const clean = url.split('?')[0];
    // Template placeholders make a path dynamic; only /api/${action} is legitimately so.
    calls.set(`${method} ${clean}`, snippet);
}
for (const m of client.matchAll(/apiCall\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*['"]([A-Z]+)['"])?/g)) {
    addCall(m[2] || 'GET', m[1], m[0]);
}
for (const m of client.matchAll(/fetch\(\s*['"`](\/api\/[^'"`]+)['"`]\s*,\s*\{[^}]*method:\s*['"]([A-Z]+)['"]/g)) {
    addCall(m[2], m[1], m[0]);
}
for (const m of client.matchAll(/fetch\(\s*['"`](\/api\/[^'"`]+)['"`]\s*,\s*\{\s*credentials/g)) {
    addCall('GET', m[1], m[0]);
}

const failures = [];
for (const [call, snippet] of calls) {
    const [method, url] = call.split(' ');

    // `/api/${action}` is built from a fixed set of verbs; check each concrete value.
    if (url.includes('${')) {
        if (url === '/api/${action}') {
            for (const a of ['start', 'stop', 'restart', 'delete']) {
                if (!routes.has(`POST /api/${a}`)) failures.push(`POST /api/${a} (from bulkAction) has no route`);
            }
            continue;
        }
        failures.push(`${call} is a dynamic path with no matching server route (${snippet.slice(0, 60)})`);
        continue;
    }
    if (!routes.has(call)) failures.push(`${call} is called by the UI but not served`);
}

console.log(`server routes: ${routes.size}`);
console.log(`client calls : ${calls.size}`);
if (failures.length) {
    console.log('\nFAIL');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
console.log('\nPASS - every endpoint the UI calls exists on the server.');
