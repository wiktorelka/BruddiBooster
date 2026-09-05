<div align="center">

# BruddiBooster

**Self-hosted Steam hour booster.** Runs hundreds of accounts from one dashboard, with
encrypted credentials, proxy rotation, scheduling and 2FA on the panel itself.

![Node](https://img.shields.io/badge/Node.js-18%20LTS-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Encryption](https://img.shields.io/badge/Credentials-AES--256--CBC-red?style=for-the-badge&logo=auth0&logoColor=white)
![2FA](https://img.shields.io/badge/Panel-TOTP%202FA-7c5cff?style=for-the-badge&logo=keycdn&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-passing-4ade80?style=for-the-badge)

</div>

---

## Showcase

| **Dashboard** | **Mobile** |
|:---:|:---:|
| ![Dashboard Preview](https://i.imgur.com/cmiF90W.png) | ![Mobile Preview](https://i.imgur.com/XDnbyrZ.png) |
| *Live status, hours and errors for every account* | *Fully responsive* |

| **Proxy Manager** | **Free Games** |
|:---:|:---:|
| ![Proxy Manager](https://i.imgur.com/6gxqkUD.png) | ![Free Games](https://i.imgur.com/Jwl5IQo.png) |
| *Bulk import and test proxies with live results* | *Add free licences in bulk* |

| **Settings & Security** | **Bundles** |
|:---:|:---:|
| ![Settings Page](https://i.imgur.com/M5cEBe6.png) | ![Bundles](https://i.imgur.com/vYxC9DB.png) |
| *2FA, backups and Discord alerts* | *Reusable game presets* |

---

## Features

### Boosting
- **Game rotation** — Steam caps an account at 32 concurrent games, so above that the
  bot plays them in batches and swaps on a configurable interval. Every game keeps
  accruing hours.
- **Blocked-session detection** — if you launch a game on your own PC, Steam takes the
  play session and the account silently stops earning. The panel shows this as
  `Blocked`, and can optionally reclaim the session (per-account, off by default).
- **Schedules** — restrict an account to a daily window, including windows that cross
  midnight. Accounts start and stop themselves on the boundary.
- **Real hours** — playtime comes from Steam itself, not an uptime estimate. The
  Statistics tab charts the daily trend.
- **Free licences** — add free-to-play games in bulk; already-owned and region-locked
  titles are detected and skipped.
- **Token sign-in** — after the first login each account reuses a Steam-issued refresh
  token instead of its password, which sharply cuts rate limits and Guard emails.

### Management
- **Bulk everything** — import, edit, start, stop and delete across many accounts.
- **Bundles** — named game presets applied to any number of accounts.
- **Categories** — group accounts into Main, Smurfs, Storage, or whatever you like.
- **Proxy manager** — per-account proxies plus a shared pool the bot rotates into after
  rate limits, with a bulk tester showing live pass/fail counts.
- **Needs-attention filter** — one click to show everything that isn't quietly running.
- **Backup & restore** — export settings, games, schedules and history as JSON.
  Credentials are never included, so the file is safe to store off-box.
- **Watchdog** — detects offline bots and dead proxies and restarts them safely.
- **Panic button** — stop everything at once.

### Visibility
- **Live dashboard** — pushed over WebSockets; no polling.
- **Logs** — real-time, filterable by text and by account. Errors from Steam and from
  the panel both appear.
- **Discord webhooks** — Guard prompts, crashes, rate limits, VAC bans, new sign-in
  locations and high memory.
- **Resource monitor** — heap usage against the process limit, with alerts before it
  becomes a problem.
- **Audit log** — logins, failed logins, lockouts, exports and deletions, written to
  disk so they survive restarts.

---

## Security

| Area | How it works |
|---|---|
| **Steam credentials** | `AES-256-CBC` on disk. Passwords, shared secrets and refresh tokens are all encrypted with `secret.key`. |
| **Panel passwords** | `bcrypt`, cost 12. Never stored reversibly. |
| **Sessions** | httpOnly + SameSite cookies the page cannot read, stored **hashed** — a leaked `sessions.json` yields nothing usable. |
| **CSRF** | Double-submit token required on every state-changing request. |
| **Panel 2FA** | TOTP. Exporting credentials requires a fresh code on top of the session. |
| **Brute force** | Per-IP *and* per-account throttling with escalating lockouts, so rotating IPs doesn't help an attacker. |
| **XSS** | All untrusted values escaped; CSP forbids inline script entirely (`script-src-attr 'none'`). |
| **File permissions** | Secrets and account data are forced to `0600` / `0700` on startup. |
| **Privacy** | Nothing leaves your server except Steam traffic and any Discord webhook you configure. |

> **Note:** `users.json` holds bcrypt *hashes*, not recoverable passwords. Older
> versions of this README described it as "encrypted", which was misleading.

---

## Requirements

| | Minimum (1–5 accounts) | Recommended (50+ accounts) |
|---|---|---|
| **OS** | Linux or Windows | Ubuntu 22.04+ |
| **Node.js** | 18 LTS | 18 or 20 LTS |
| **RAM** | 512 MB | 2 GB+ |
| **CPU** | 1 vCore | 2 vCores |
| **Storage** | 300 MB | 1 GB |

Memory scales with account count and library size. The app list alone is ~12 MB
resident, and each connected account adds a few MB.

---

## Quick start

```bash
git clone https://github.com/wiktorelka/BruddiBooster.git
cd BruddiBooster
npm install
npm start
```

Then open `http://localhost:3000`.

> Use `npm start`, not `node server.js` — the script sets the heap limit the app
> expects.

### First login

| | |
|---|---|
| Username | `admin` |
| Password | `password` |

**Change this immediately** in Settings and enable 2FA. The server warns on every boot
until you do.

---

## Configuration

Settings live in a `.env` file next to the app, created on first setup. `npm start`
reads it automatically — no environment variables to remember.

```ini
PORT=3000
HOST=0.0.0.0     # all interfaces; use 127.0.0.1 only if the proxy is on this machine
TRUST_PROXY=1    # set when a reverse proxy is in front
```

Copy `.env.example` to `.env` and edit. Real environment variables override the file,
so `PORT=8080 npm start` still works for one-offs.

### Behind Nginx Proxy Manager

| Field | Value |
|---|---|
| Forward Hostname / IP | the machine running this app |
| Forward Port | `3000` |
| Websockets Support | **on** — the dashboard is push-based and will not update without it |
| Force SSL | on |

`HOST` must stay `0.0.0.0` when NPM runs on a different machine or in Docker;
`127.0.0.1` is unreachable from anywhere but this host.

`TRUST_PROXY=1` matters: without it every visitor appears to come from the proxy's own
address, so they all share one rate-limit bucket and one attacker's failed logins would
lock you out too.

Because the port is open on the network, restrict it to the proxy:

```bash
sudo ufw allow from <proxy-ip> to any port 3000 proto tcp
sudo ufw deny 3000/tcp
```

## Running as a service (optional)

Ready-made configs are in [`deploy/`](deploy/).

**1. systemd** — hardened unit with `ProtectSystem=strict`, no capabilities, a syscall
filter and a memory cap. It also sends `SIGTERM` on stop, which lets the app log every
bot off cleanly and flush pending hours.

```bash
sudo cp deploy/bruddibooster.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bruddibooster
journalctl -u bruddibooster -f
```

**2. nginx + TLS** — terminates HTTPS, proxies WebSockets, and rate-limits `/api/login`
at the edge.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/bruddibooster
sudo ln -s /etc/nginx/sites-available/bruddibooster /etc/nginx/sites-enabled/
sudo certbot --nginx -d panel.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Two settings matter here and are easy to get wrong:

- **`TRUST_PROXY=1`** — without it every visitor looks like nginx's own address, so all
  users share one rate-limit bucket and an attacker's failed logins lock *you* out.
- **`HOST=127.0.0.1`** — otherwise port 3000 stays reachable directly, letting anyone
  bypass the TLS and rate limiting nginx provides.

---

### All settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | `127.0.0.1` only when the proxy is on this same machine. |
| `TRUST_PROXY` | unset | `1` when a reverse proxy is in front. |
| `HB_DATA_DIR` | app directory | Where accounts, users and sessions live. |

Panel settings (Discord webhook, rotation interval) live in the Settings tab.

---

## Testing

```bash
npm test          # all three suites
npm run test:api    # every endpoint the UI calls exists on the server
npm run test:client # login, CSRF and retry behaviour
npm run test:boost  # hour-boosting behaviour (35 assertions)
npm run test:leak   # memory leak harness
```

The boost and leak suites stub `steam-user` and run on a virtual clock, so they need no
Steam credentials and finish in seconds. Run `npm test` after touching `bot.js`,
`server.js` or the dashboard's API calls.

---

## Project structure

```
server.js       Express app, API routes, socket.io, auth
bot.js          Steam clients: login, idling, rotation, schedules, watchdog
data.js         Atomic JSON persistence + in-memory cache
security.js     Login throttling, cookies, CSRF, token hashing
utils.js        Encryption, logging, audit trail
public/         Dashboard (vanilla JS, no build step)
test/           API contract, boosting behaviour, leak harness
deploy/         systemd unit and nginx config
accounts/       Encrypted account data  (gitignored)
users.json      Panel users, bcrypt hashes  (gitignored)
secret.key      AES key for stored credentials  (gitignored)
audit.log       Persistent security events  (gitignored)
```

---

## Roadmap

- [x] Proxy support with per-account assignment and a shared pool
- [x] Discord webhooks
- [x] Game rotation beyond 32 games
- [x] Auto-accept friend requests
- [x] Scheduling / quiet hours
- [x] Backup & restore
- [x] Hours history and charts
- [ ] Steam chat from the dashboard
- [ ] Docker image
- [ ] Worker pool so one bad account can't stall the others

---

## Origin

This started as an experiment in AI-assisted development — the first working version was
generated by Google's Gemini in a few hours. It has been iterated on substantially
since, particularly around memory behaviour, Steam session handling and security.

Bug reports and suggestions are welcome in the [Issues tab](../../issues).

---

## Disclaimer

Hour boosting may violate Steam's Terms of Service. This tool is provided for
educational purposes; you use it at your own risk.
