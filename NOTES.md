# BruddiBooster — changes & notes

`npm test` runs four suites: the API contract check (every endpoint the UI calls
exists), client plumbing (login button, CSRF, retries — 11 assertions), hour-boosting
behaviour (47 assertions), and the memory leak harness. Run it after any change to `bot.js`, `server.js` or the
dashboard's API calls.

---

## Your question: was the lockout per-IP or per-account?

**Per-IP only.** Measured, not guessed:

| Attack | Before | Now |
|---|---|---|
| 14 IPs, one account (credential stuffing) | 14 attempts, **never blocked** | locked after 5 |
| One IP, many accounts | blocked after 10 | blocked after 10 |

`express-rate-limit` keys on `req.ip`, so rotating IPs defeated it entirely. Added
per-account throttling in `security.js`: 5 failures → 1 min, 8 → 5 min, 12 → 30 min,
20 → 1 hour. Wrong 2FA codes count too, or 2FA becomes a free oracle. Other accounts
are unaffected, so one user being attacked can't lock everyone out.

---

## Security

- **Session token moved to an httpOnly cookie.** It is no longer in `localStorage` or
  the login response body, so a future XSS can't steal a 7-day token. CSRF via
  double-submit (`bb_csrf` cookie echoed in `X-CSRF-Token`); `SameSite=Lax`; `Secure`
  set automatically when the request arrives over HTTPS. Old tokens in storage are
  purged on load. The `Authorization` header still works for scripts/curl.
- **socket.io had no authentication at all** — anyone who could reach the port could
  connect and receive every log line (account names, Steam errors). Sockets now
  authenticate with the session cookie and join per-user rooms; non-admins only get
  events for accounts they own. Verified: an unauthenticated handshake is rejected.
- **`/api/accounts/export` now requires a fresh 2FA code** when the admin has 2FA on,
  and is `POST` instead of `GET` (it was reachable by URL). Failures are audited.
- Per-account lockout (above), plus the earlier fixes: XFF rate-limit bypass, timing
  enumeration, session revocation on password change and user deletion.

## Reliability

- **All persistence writes are atomic** (temp file + `rename`). Previously a crash or
  power loss mid-write truncated the file — losing an account, or `users.json`.
- **`boostedHours` is measured, not estimated.** It used to add `games.length/60` per
  minute of uptime, counting hours Steam may never have credited. It is now derived
  from Steam's own playtime: hours gained since the account was first seen. Existing
  values are preserved by back-dating the baseline on first refresh, so nothing
  resets to zero.

## Performance / UX

- **Polling replaced with push.** Each open tab used to re-fetch all 245 accounts
  every few seconds. The server now builds each user's payload once per tick and
  emits only when it actually changed; an idle panel costs nothing. REST polling
  remains as a 15s fallback if the socket drops.
- **Bulk selection survives refreshes.** The table rebuild silently cleared every
  checkbox mid-operation. Selection is now kept in a `Set` and re-applied on render.
- **Destructive bulk deletes require typing the count**, not a yes/no.
- **Status filter chips** — All / Running / Needs attention / Stopped, with live
  counts. "Needs attention" is everything neither running nor deliberately stopped.
- **Per-account log filter** — `relatedUser` was already recorded on every line but
  the UI couldn't use it. `/api/logs` now returns objects rather than bare strings.
- Account search also matches the Steam nickname.

## Earlier passes (summary)

- **OOM root cause**: `enablePicsCache: true` made steam-user cache full parsed
  appinfo for every app in every owned package. On a 1017-app account that exceeded
  the 2 GB heap. Ownership now comes from `getUserOwnedApps` instead.
- **Memory leaks**: 300 orphaned clients / 152 MB after 300 start-stop cycles, and 27
  MB permanently leaked per batch of watchdog restarts. Now zero.
- **Bug**: editing an account silently wiped its proxy and shared secret.
- Console capture so library errors reach the dashboard log, graceful shutdown,
  memory watchdog, `PORT`/`TRUST_PROXY`/`HB_DATA_DIR` env vars, full UI redesign.

---

## Latest pass — features & hardening

### Things that were costing you hours
- **Blocked-session detection.** steam-user emits `playingState` when another device
  takes over the account (you launching a game on your own PC). It was not subscribed,
  so the bot showed "Running" while earning **nothing**. Now surfaced as a distinct
  `Blocked` status, counted under "Needs attention", and optionally reclaimed:
  `gamesPlayed(apps, force)` takes a kick flag both call sites were omitting.
  Per-account toggle, **off by default**, so it never boots you out of your own game
  unless you ask it to.
- **Refresh-token logins.** Steam issues a token on first sign-in; reusing it skips the
  password entirely. It was never stored, so every restart, crash, watchdog trip and
  proxy rotation was a full password login — the exact thing that triggers rate limits
  (84/88) and Guard emails. Tokens are encrypted at rest, and an expired one falls back
  to the password instead of looping.

### Reliability
- **eresult 87 (InvalidLoginAuthCode)** was in the FAQ but unhandled — it fell into the
  generic crash loop with a misleading reason. Now stops cleanly as "Bad Guard Code".
- **VAC ban detection** (`vacBans`) with a Discord alert, flagged in the account list.
- **Account limitations** (`accountLimitations`) — locked accounts stop and report;
  limited accounts are flagged.

### Features
- **Scheduling / quiet hours** — per-account daily window, correctly handling windows
  that wrap past midnight. Accounts start and stop themselves on the boundary.
- **Hours history** — one datapoint per account per day (90-day cap) feeding a real
  trend chart in Statistics. Previously only a single cumulative number existed.
- **Backup & restore** — download everything (categories, games, bundles, proxies,
  schedules, history) as JSON and restore it. **Credentials are deliberately excluded**,
  so the file is safe to keep off-box.

### CSP hardened properly
`script-src` allowed `'unsafe-inline'` with a comment claiming an inline script needed
it — **there were no inline `<script>` blocks at all**, so that was pure exposure.
Removed, meaning an injected `<script>` tag now cannot execute.

Then all **108 inline `on*=` handlers** were replaced with `data-act` attributes and a
single delegated dispatcher, letting `script-src-attr` go to `'none'`. Action names run
through an allow-list resolved at dispatch, so a crafted attribute can't reach
arbitrary globals. Verified: zero inline handlers in the served markup, and all 79
allow-listed actions resolve to real functions under real browser load order.

Final policy: `script-src 'self' cdn.jsdelivr.net; script-src-attr 'none';
object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`.

## Proxy manager & in-app help

**Proxy testing had no feedback.** Test All showed one toast at the start and one at
the end; with 245 rows you had to scroll the list reading border colours to learn
anything. Now there's a live panel above the list: `tested / total`, a progress bar,
separate tallies for **working / replaced / failed**, a running ETA derived from actual
throughput, and a list of which proxies failed. Each row also gets a status badge
(testing / working / replaced / removed), so scrolling is informative too.

Two things it now distinguishes that it previously conflated: a proxy that passed on
its own, versus one that only passed after being swapped for a spare from the pool.
The old code counted both as plain successes. A second Test All also cancels the first
rather than letting two runs fight over the same rows.

**Tooltips replaced with real explanations.** The "Rotation Active" info button was
typical: technically true, explained nothing. Native `title=` tooltips are slow and
can't wrap, which is why the copy was so terse. There's now a styled hint popup
(`HINTS` in dashboard.js, one place for all the copy) with a proper paragraph for each
feature - rotation, auto-start, auto-accept, reclaim, schedules, persona state, custom
status, proxies, the proxy pool, bundles, free games, token sign-in, blocked sessions,
the memory bar and backups.

**The FAQ tab is now "Features & FAQ"** and leads with a card per feature explaining
what it does and where to find it, then the error codes (65 and 87 added, descriptions
corrected to match what the bot now actually does), then the FAQ - with new entries for
the two questions this codebase most invites: "it says Running but hours aren't going
up" and "why do I keep getting rate limited".

## Two dead endpoints (found from the Refresh button report)

The Refresh button in Manage Games called `POST /api/library/refresh`, which **has
never existed on this server**. Chasing it turned up a second, worse one.

**Saving games silently did nothing.** The Save button in Manage Games posted to
`/api/accounts/<user>/games`, also non-existent, then called `closeModals()` and
`fetchAccounts()` regardless of the result. The modal closed and the list refreshed, so
it looked like it saved -- but the games were never written. The working route is
`POST /api/games` with the username in the body.

Both are leftovers from the abandoned `src/` refactor (commit da01c7c removed those
REST-style routes; the client kept calling them). A 404 from `fetch` is not an
exception, so nothing ever surfaced.

Fixed:
- `POST /api/library/refresh` implemented -- forces a re-read of the account's owned
  games from Steam, with a clear 409 if the bot isn't running (Steam only reports a
  library to a signed-in session).
- `saveGames` now calls the real route and only closes the modal on success, reporting
  the failure otherwise.
- `apiCall` surfaces the server's error body on any non-2xx instead of returning null
  silently -- a 404 now shows what went wrong rather than a bare "Error".
- `refreshLibraryAPI` and `fetchLibrary` no longer dereference a null response (that
  TypeError was the "Error" toast you were seeing).

**`npm run test:api` guards this.** It cross-checks every endpoint the UI calls against
the routes server.js registers. Verified by reintroducing the original bug: the test
fails and names the exact call.

## Security hardening pass

Three findings from inspecting the running system, not the code:

1. **Session tokens were stored in plaintext.** `sessions.json` held working bearer
   tokens — anyone who could read that file had account takeover without the password,
   and the file was mode 664. Sessions are now keyed by `sha256(token)`; the raw token
   exists only in the browser cookie. Verified: the on-disk key is the hash of the
   cookie value. Existing sessions are purged on first start (one re-login), because a
   raw token and a SHA-256 are both 64 hex chars and can't be told apart.
2. **Secrets were world-readable.** `secret.key` (decrypts every stored password),
   `users.json` (bcrypt hashes + 2FA secrets), `sessions.json` and `accounts/` were all
   at the process umask — 664/775. Now forced to 0600/0700 on startup, and applied to
   your existing files. Verified all 245 accounts still load.
3. **The audit trail didn't survive a restart.** Logins, failed logins, lockouts,
   exports and deletions went only to the 1000-entry in-memory ring buffer. They now
   also append to `audit.log` (0600, 5 MB cap with one rotation), readable by admins at
   `/api/audit` and deliberately not clearable from the UI.

Also added:
- **New sign-in location alerts.** A login from an address an account hasn't used
  before is logged as SECURITY and sent to Discord.
- **`HOST` binding.** Behind nginx, set `HOST=127.0.0.1` so port 3000 isn't reachable
  directly — otherwise the TLS and edge rate limiting can simply be bypassed. The
  server warns if it's listening on all interfaces while `TRUST_PROXY` is set.
- **Audit coverage** for account deletion and bulk import, which weren't recorded.

### Deployment configs (`deploy/`)
- `bruddibooster.service` — hardened systemd unit: `ProtectSystem=strict`,
  `ProtectHome=read-only`, empty capability set, syscall filter, `UMask=0077`, 4 GB
  memory cap, and `TimeoutStopSec=30` so the graceful shutdown can finish.
- `nginx.conf` — TLS, HSTS, WebSocket upgrade, and a `limit_req` zone on `/api/login`,
  with the `X-Forwarded-For` headers that make `TRUST_PROXY=1` safe.

### Dependency vulnerabilities (16 reported, resolved)

**Do not run `npm audit fix --force` on this project.** It resolves the adm-zip and
protobufjs advisories by installing **steam-user@3.15.0** — a two-major downgrade that
would destroy refresh-token sign-in, blocked-session detection, VAC alerts and account
limitations, i.e. most of the last two passes. steam-user stays at 5.3.0.

Fixed without breaking anything:

| package | was | now | advisory |
|---|---|---|---|
| express-rate-limit | 8.2.1 | 8.7.0 | IPv4-mapped IPv6 bypass of per-client limits |
| ws | 8.18.3 | 8.21.3 | uninitialised memory disclosure, fragment DoS |
| engine.io | 6.6.5 | 6.6.10 | polling connection exhaustion, WebTransport SID DoS |
| socket.io-parser | 4.2.5 | 4.2.7 | unbounded binary attachments |
| path-to-regexp | 0.1.12 | 0.1.13 | ReDoS |
| express | 4.21 | 4.22.2 | transitive |
| protobufjs | 6.11.4 / 7.5.4 | **7.6.6** | RCE (critical) + 11 others |

The express-rate-limit one mattered most: on a dual-stack host an IPv4-mapped IPv6
address bypassed per-client limiting, which is exactly the login protection this panel
relies on.

protobufjs was resolved with an `overrides` entry rather than a downgrade — steam-user
declares `^7.2.4`, so the patched 7.6.6 satisfies it. All three copies (steam-user,
steam-session, steam-appticket) now dedupe to 7.6.6. Verified steam-user still loads
all 2523 compiled schemas and round-trips a real `CMsgClientGamesPlayed` message.

Also ran `npm prune`, which removed the stale `globaloffensive` tree left behind when
that dependency was dropped.

**Accepted, with reasoning:**
- `adm-zip` 0.5.18 (crafted ZIP → 4 GB allocation). Only reachable through
  steam-user's `cdn_compression.js`, used for depot/CDN content downloads. This app
  never downloads depot content, so the code path is unreachable here. No patched
  version exists that keeps steam-user 5.x.
- `qs` 6.15.3 (DoS). Fixing it requires express 5, a breaking change. express 4.22.2
  carries the other fixes.

**Caveat:** npm's audit endpoint returned 503 on my final re-check, so the residual
count is from comparing installed versions against the advisory ranges rather than a
clean `npm audit` run. Worth re-running when the registry is healthy.

## "Bad CSRF token" on every action

A page left open across a re-login kept sending the CSRF token it captured at load,
while the server had issued a new one. Every state-changing request then failed until
the tab was reloaded. Triggered by anything that starts a new session behind an open
page: signing in from a second tab, or a server restart followed by a fresh login.

The bug was mine, in `apiCall`:

```js
headers['X-CSRF-Token'] = csrfToken || readCookie('bb_csrf') || '';
```

The in-memory value won over the cookie, so a page never picked up a reissued token.

Fixed in three places:
- The cookie is now the source of truth (`currentCsrf()`), since the server rewrites it
  on every login.
- A 403 re-syncs from `/api/verify_session` and retries **once**, using the token the
  server just returned rather than re-reading the cookie — the cookie is what may have
  been stale. A genuinely forbidden action still fails after that single retry.
- `/api/verify_session` now re-issues the `bb_csrf` cookie, so a browser holding an old
  copy converges instead of staying broken.

My first attempt at this only did the first point, and still sent the stale token on
the retry. `npm run test:client` caught it — 8 assertions covering cookie priority,
memory fallback, the retry path, retry-once (no loop), and that GET carries no token.

## Login button dead + full re-audit

**The Login button did nothing; Enter worked.** My CSP conversion put the delegated
click dispatcher in `dashboard.js` — which is only fetched *after* a successful login.
The Login button carries `data-act`, so on the login screen nothing was listening.
Enter kept working because the inputs bind `keypress` directly.

Moved the dispatcher (`ACTIONS`, `resolveAction`, `runAction`, `initDelegatedEvents`)
into `login.js`, which always loads, and bound it at `DOMContentLoaded`. Removed the
now-duplicate binding in `dashboard.js` — leaving both would have fired every action
twice. Covered by three new assertions in `npm run test:client`.

### Other bugs found in the sweep

- **`/api/games`, `/api/start`, `/api/restart` returned 500 for an unknown account.**
  `verifyOwner` short-circuits to `true` for admins without checking existence, so the
  account came back null and was dereferenced. `/api/restart` was worse: the throw
  happened inside a `setTimeout`, making it an uncaught exception rather than a failed
  request. All three now 404, and `startBotProcess` ignores a null account (it is also
  called from timers and the watchdog).
- **Any non-string `username` 500'd every account route.** `getAccount` called
  `.toLowerCase()` on whatever arrived in the JSON body. Fixed once in `data.js` via a
  `normaliseUsername` helper, which covers `getAccount`, `saveAccount` and
  `deleteAccountFile`. Verified: 9 routes × 6 hostile bodies, no 500s.
- **Bulk import 500'd** on a missing or non-string `data` field (`data.split`). Now a
  400 with a useful message.

### Checked and clean
- All 79 `data-act` names resolve under real browser load order, and every name in the
  markup is in the allow-list.
- No element carries both `data-act` and a direct listener (no double-firing).
- No `apiCall` result dereferenced without a null guard.
- Every `getAccount` dereference guarded.
- No inline `on*=` handlers anywhere; CSP still `script-src-attr 'none'`.
- Zero uncaught exceptions across the whole hostile-input sweep.

## Playing on a boosted account yourself

Two bugs here, and the second is why the account appeared to "turn off".

**1. It retried every 30 seconds, forever.** The `LoggedInElsewhere` handler used a
fixed 30s delay with no ceiling, so for as long as you played it attempted 120 logins
an hour. That is precisely the behaviour that earns an eresult 84/88 rate limit, which
then costs you a 5-minute cooldown on top. Replaced with a ladder:
**30s -> 1 min -> 2 min -> 5 min -> 10 min**, then holding at 10 minutes indefinitely.
It still recovers on its own the moment you close the game; it just stops hammering
Steam while you play. A successful reconnect resets the ladder.

**2. Being kicked mid-session was treated as a crash.** `client.on('disconnected')`
ignored the eresult and sent everything to `handleCrash`, which restarts three times
and then parks the account at `Crashed`. So launching a game while the bot was already
connected burned the restart budget and switched the account off. EResult 6 on
disconnect now routes to the same in-use handling and no longer counts as a crash.

**3. A `Crashed` bot was never retried.** `handleCrash` returns early on `Crashed`, the
scheduler skips it, and the watchdog only inspected running bots — so once an account
gave up it stayed dead until someone noticed. The watchdog now retries a crashed
account 30 minutes after it gave up, so a transient problem (Steam maintenance, a flaky
proxy) heals itself.

The status is now **"In use"** with a "Resumes in Nm" countdown rather than an
error-looking "Logged In Elsewhere", and it is excluded from the *Needs attention*
filter because it is expected and self-healing.

Covered by 12 new assertions: the ladder escalates, never gives up, resets on
reconnect, a manual stop cancels it, repeated kicks never reach `Crashed`, a real crash
still stops after its budget, and the watchdog revives it afterwards.

## Capacity and scaling

Measured on this box (4 cores, 7.8 GB RAM, 3120 MB heap):

| | cost | at 245 accounts |
|---|---|---|
| Account cache | 8 KB each | 1.9 MB |
| steam-user object | ~5 KB each | ~1.2 MB |
| App list (fixed) | — | 12 MB |
| Push loop CPU | 3.3 ms/tick | negligible (27 ms at 2000) |

**Software is not the limiting factor.** Allowing 1-3 MB per live connection, 500
accounts sits around 0.5-1.5 GB against a 3120 MB heap.

**The limit is IP reputation.** Steam rate-limits logins per IP. Current layout: 59
proxies at ~3 accounts each (healthy), but **71 accounts on the bare server IP**, which
is the real exposure. The **global proxy pool is empty**, so `rotateProxy` returns
immediately and the automatic recovery after a rate limit never actually runs — worth
populating, it is the safety net for exactly this.

Rough guide: ~5 accounts per IP is comfortable, so 59 proxies supports ~300 accounts
once the bare-IP group is spread out.

### Two optimisations from these measurements

**Delta push.** The dashboard was sent the whole account list every 3s whether or not
anything changed: 320 KB per tick, ~6.2 MB/min per open tab, ~370 MB/hour. That is
painful over mobile data, which matters since the panel is reached from outside the
network. The server now diffs per user and emits `accounts_delta` with only the changed
accounts (plus removals); an idle panel sends **nothing at all**. One account changing
is 1.3 KB instead of 320 KB — 99.6% less. Clients still get a full snapshot on connect.

**Per-IP startup pacing.** Auto-start staggered every account by 5s globally, so 245
accounts took 20 minutes. Rate limits are per IP, so global pacing bought nothing.
Accounts are now grouped by proxy and paced within each group, with jitter between
groups: **20 min -> ~6 min** on the current layout, and the remaining bottleneck is
correctly the 71 accounts sharing the server IP. The server also warns at boot when 20+
auto-start accounts share a single IP.

## Still worth doing

1. **Move `secret.key` out of the app directory.** It is now 0600, but still sits
   next to the data it encrypts. An env var or systemd credential would separate them.
3. **Worker pool for bots.** One process still runs all 245; a single bad account can
   stall the others. The biggest job on this list.
3. **SQLite instead of JSON files.** Atomic writes fixed corruption, but every save
   still rewrites a whole file and there are no transactions.
4. **Server-side pagination** if you go much past ~1000 accounts.

## Operational notes

- `TRUST_PROXY=1` — **set this**, you are behind nginx. Without it every visitor looks
  like nginx's IP and they all share one rate-limit bucket.
  Ensure nginx sends `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  and `proxy_set_header X-Real-IP $remote_addr;`.
- `PORT` — defaults to 3000.
- `HB_DATA_DIR` — relocates accounts/users/sessions (used by the tests).
- `npm start` runs with `--max-old-space-size=3072`; the boot line prints the limit.
- `npm test` — API contract, behaviour, and leak suites.
- If memory ever runs away again:
  `node --heapsnapshot-near-heap-limit=1 --max-old-space-size=1024 server.js`
