# BruddiBooster — changes & notes

`npm test` runs both suites: hour-boosting behaviour (13 assertions) and the memory
leak harness. Run it after any change to `bot.js`.

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

## Still worth doing

1. **Move `secret.key` out of the app directory.** It currently sits next to the data
   it encrypts, so disk read access gives both. An env var or systemd credential is
   better.
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
- `npm test` — behaviour + leak suites.
- If memory ever runs away again:
  `node --heapsnapshot-near-heap-limit=1 --max-old-space-size=1024 server.js`
