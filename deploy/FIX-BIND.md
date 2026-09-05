# Back to `npm start`, working through Nginx Proxy Manager

## 1. Stop systemd from holding the port

The unit is currently running and bound to `127.0.0.1`, which no other machine can
reach. Remove it:

```bash
sudo systemctl disable --now bruddibooster
sudo rm /etc/systemd/system/bruddibooster.service
sudo systemctl daemon-reload
```

## 2. Start it the old way

```bash
cd ~/hourboosttest
npm start
```

Configuration now lives in `.env`, so there is nothing else to remember:

```ini
PORT=3000
HOST=0.0.0.0
TRUST_PROXY=1
```

The startup line confirms it:

```
[..] [SYSTEM] BruddiBooster v18 Running on 0.0.0.0:3000 (heap limit 3120 MB, Node v18.19.1)
```

## 3. Nginx Proxy Manager

| Field | Value |
|---|---|
| Forward Hostname / IP | `192.168.50.40` |
| Forward Port | `3000` |
| **Websockets Support** | **on** |
| Force SSL | on |
| Block Common Exploits | on |

Websockets must be on — the dashboard is push-based, so without it the page loads but
never updates.

Force SSL matters too: the session cookie is marked `Secure` when NPM reports an https
request, and browsers discard `Secure` cookies sent over plain http. Reaching the panel
over `http://` would log you straight back out.

## 4. Keep it running after you close the terminal

`npm start` dies with your SSH session, and Ctrl+Z will suspend it while it still holds
the port — which is what happened before. Use tmux:

```bash
tmux new -s booster
cd ~/hourboosttest && npm start
# detach with Ctrl+B then D
```

Reattach later with `tmux attach -t booster`.

## 5. Close the port to everything except the proxy

`HOST=0.0.0.0` means any machine on your network can reach `:3000` directly and skip
NPM's TLS. Restrict it:

```bash
sudo ufw allow from <NPM-IP> to any port 3000 proto tcp
sudo ufw deny 3000/tcp
sudo ufw status numbered
```

Do **not** forward port 3000 on your router. Remote access should go to NPM's 443 only.
