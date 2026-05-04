# Levy alerts bot

Two monitors that share one Telegram bot and one GitHub Actions cron:

- **Yango Deli** (`monitor.py`) — alert when delivery cost to a fixed address
  crosses below 15 ₪. Active 13:00–23:00 Asia/Jerusalem.
- **Surf Park TLV** (`monitor_srf.py`) — alert ~1h45m before an L6 reef-left
  session that has more than 12 spots available. Active 08:00–18:00.

## How it works

1. `monitor.py` launches a stealth Playwright Chromium, loads `deli.yango.com`
   to obtain anti-bot cookies, then calls the internal `service-info` API for
   the configured coordinates with a logged-in session.
2. The current `deliveryCost` and `minimalCartPrice` are compared against
   `state.json` (committed back to the repo by the workflow).
3. On threshold crossing (above ↔ below 15 ₪), a Telegram message is sent.

## Setup

1. **Login session** — on a local machine where you're logged into Yango Deli
   in regular Chrome, install the [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
   extension, export cookies as JSON, save to `cookies.json`, then:
   ```
   python convert_cookies.py
   base64 -i auth.json | pbcopy
   ```
2. **GitHub secrets** (Settings → Secrets and variables → Actions):
   - `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
   - `TELEGRAM_CHAT_ID` — destination chat id (negative for groups)
   - `AUTH_B64` — base64 of `auth.json`
3. The workflow runs every 15 minutes via cron, or trigger manually from the
   Actions tab.

## Re-login

When the bot reports `auth expired`, re-run Cookie-Editor export, regenerate
`auth.json`, base64-encode it, and update the `AUTH_B64` secret.

## Configuration

Override via env vars or in the workflow:

| Var | Default |
|---|---|
| `ADDR_LAT` | `32.126347` |
| `ADDR_LON` | `34.801369` |
| `ADDR_CITY` | `תל אביב` |
| `ADDR_STREET` | `אליהו חכים` |
| `ADDR_HOUSE` | `8` |
| `THRESHOLD` | `15` |
