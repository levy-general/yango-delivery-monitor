"""
Surf Park multi-user monitor.

Runs every cron tick (≤15 min). On each run:
  1. Scrape the SRF Park sessions page (Cloudflare blocks SRF, so the scrape
     happens here rather than in the Worker).
  2. POST sessions to the Surf bot Worker so /today /all /date have data.
  3. Pull the list of subscribed users from the Worker.
  4. For each user: compute alerts (1:45m & 1:15m before sessions matching
     their prefs) and the daily 20:00 summary; send via the surf bot.

Per-user alert state is persisted in srf_state.json keyed by chat_id, so
each user is only notified once per (session_id, lead) pair.

Env vars:
  SURF_BOT_TOKEN      required
  SURF_WORKER_URL     required (e.g. https://surf-bot.shayko22.workers.dev)
  SURF_PUSH_SECRET    required
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from travel import driving_eta, SURF_PARK_COORDS

TZ = ZoneInfo("Asia/Jerusalem")

URL = "https://www.srfparktlv.co.il/sessions/?show-children=false&show-adults=false&zone=reef-left"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

BOT_TOKEN = os.environ.get("SURF_BOT_TOKEN", "")
WORKER_URL = os.environ.get("SURF_WORKER_URL", "https://surf-bot.shayko22.workers.dev").rstrip("/")
PUSH_SECRET = os.environ.get("SURF_PUSH_SECRET", "")

STATE_PATH = Path(os.environ.get("STATE_PATH", "srf_state.json"))

# Lead times in minutes before session start. Threshold (spots strictly
# greater than) is read from each user's prefs.spots_threshold.
LEADS = [105, 75]
WINDOW_MIN = 8

# Session block regex (same as before).
SESSION_RE = re.compile(
    r'<div class="box_session[^"]*"\s*[^>]*?'
    r'data-id="(?P<id>\d+)"[^>]*?'
    r'data-area="(?P<area>[^"]+)"[^>]*?'
    r'data-level="(?P<level>\d+)"'
    r'(?P<rest>.*?)</div>\s*</div>\s*</div>',
    re.S,
)
DATES_RE = re.compile(r'data-dates="(\d{8}T\d{6})/(\d{8}T\d{6})"')
SPOTS_RE = re.compile(r'נותרו\s+(\d+)\s+מקומות')
TITLE_RE = re.compile(r'<div class="title">\s*([^<]+?)\s*<')


# ---------- HTTP helpers ----------
def http_request(url: str, *, data=None, headers=None, method=None) -> bytes:
    req = urllib.request.Request(
        url,
        data=(json.dumps(data).encode() if data is not None else None),
        headers=headers or {"User-Agent": "monitor-srf/1.0"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def http_json(url: str, **kwargs) -> dict:
    body = http_request(url, **kwargs)
    return json.loads(body) if body else {}


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def fetch_html() -> str:
    """Fetch the default 3-day window (today + 2)."""
    return _fetch(URL)


def fetch_all_windows(days_ahead: int = 9) -> list[dict]:
    """SRF returns 3 days per page. Paginate via ?from_date= to cover
    `days_ahead` days. Sessions across all windows are de-duplicated by id."""
    by_id: dict[str, dict] = {}
    today = datetime.now(TZ).date()
    for offset in range(0, days_ahead, 3):
        d = today + timedelta(days=offset)
        if offset == 0:
            url = URL
        else:
            from_date = d.strftime("%d/%m/%y")
            url = f"{URL}&from_date={urllib.parse.quote(from_date)}"
        try:
            html = _fetch(url)
        except Exception as e:
            print(f"window from_date={d.isoformat()} failed: {e}", file=sys.stderr)
            continue
        for s in parse_sessions(html):
            by_id[s["id"]] = s
    return sorted(by_id.values(), key=lambda s: s["start"])


def parse_sessions(html: str) -> list[dict]:
    out = []
    for m in SESSION_RE.finditer(html):
        block = m.group(0)
        rest = m.group("rest")
        d = DATES_RE.search(block)
        if not d:
            continue
        try:
            start = datetime.strptime(d.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=TZ)
        except ValueError:
            continue
        s = SPOTS_RE.search(rest)
        t = TITLE_RE.search(rest)
        out.append({
            "id": m.group("id"),
            "area": m.group("area").strip(),
            "level": int(m.group("level")),
            "start": start,
            "spots": int(s.group(1)) if s else 0,
            "title": t.group(1).strip() if t else "",
        })
    return out


def push_sessions(sessions: list[dict]) -> None:
    if not PUSH_SECRET:
        print("SURF_PUSH_SECRET not set — skipping push.", file=sys.stderr)
        return
    payload = [
        {
            "id": s["id"],
            "level": s["level"],
            "area": s["area"],
            "start": int(s["start"].timestamp() * 1000),
            "spots": s["spots"],
            "title": s["title"],
        }
        for s in sessions
    ]
    try:
        http_request(
            f"{WORKER_URL}/sessions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Auth": PUSH_SECRET,
                "User-Agent": "monitor-srf/1.0",
            },
            method="POST",
        )
        print(f"Pushed {len(payload)} sessions to worker.")
    except Exception as e:
        print(f"push failed: {e}", file=sys.stderr)


def fetch_users() -> list[dict]:
    try:
        return http_json(f"{WORKER_URL}/users").get("users", [])
    except Exception as e:
        print(f"fetch users failed: {e}", file=sys.stderr)
        return []


# ---------- Telegram ----------
def telegram_send(chat_id: int, text: str) -> None:
    if not BOT_TOKEN:
        print(f"[no bot token] would send to {chat_id}: {text[:100]}", file=sys.stderr)
        return
    try:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }).encode()
        with urllib.request.urlopen(url, data=data, timeout=15) as r:
            r.read()
    except Exception as e:
        print(f"send to {chat_id} failed: {e}", file=sys.stderr)


# ---------- State ----------
def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ---------- Filters ----------
def matches_prefs(s: dict, prefs: dict) -> bool:
    if s["level"] != prefs.get("level"):
        return False
    direction = prefs.get("direction", "left")
    area = s["area"].lower()
    if direction == "left":
        return "left" in area
    if direction == "right":
        return "right" in area
    return True


# ---------- Alerts ----------
def process_user_alerts(user: dict, sessions: list[dict], state: dict) -> None:
    chat_id = user["chat_id"]
    prefs = user.get("prefs") or {}
    if not prefs.get("level"):
        return  # not yet onboarded

    user_state = state.setdefault(str(chat_id), {})
    alerted = set(user_state.get("alerted_ids", []))
    threshold = int(prefs.get("spots_threshold", 10))

    now = datetime.now(TZ)
    window = timedelta(minutes=WINDOW_MIN)

    for s in sessions:
        if not matches_prefs(s, prefs):
            continue
        time_until = s["start"] - now
        for lead in LEADS:
            target = timedelta(minutes=lead)
            in_window = (target - window) <= time_until <= (target + window)
            key = f"{s['id']}_{lead}"
            if not in_window or s["spots"] <= threshold or key in alerted:
                continue

            mins_to = int(time_until.total_seconds() / 60)
            travel_line = ""
            if lead <= 90 and prefs.get("lat") and prefs.get("lon"):
                eta = driving_eta((prefs["lat"], prefs["lon"]), SURF_PARK_COORDS)
                if eta:
                    travel_line = f"זמן נסיעה: {eta}\n"

            msg = (
                f"🏄 <b>Surf Park</b>\n"
                f"שם הסשן: {s['title']}\n"
                f"שעה: {s['start'].strftime('%H:%M')} ({s['start'].strftime('%d/%m')}) — בעוד ~{mins_to} דק'\n"
                f"מקומות פנויים: {s['spots']}\n"
                f"{travel_line}"
                f"<a href=\"{URL}\">לרשום עכשיו →</a>"
            )
            telegram_send(chat_id, msg)
            alerted.add(key)
            print(f"  → ALERT to {chat_id} for {key}")

    # Prune past sessions from alerted set.
    cutoff = now - timedelta(hours=6)
    by_id = {s["id"]: s for s in sessions}
    keep = set()
    for key in alerted:
        sid = key.split("_")[0]
        s = by_id.get(sid)
        if s and s["start"] > cutoff:
            keep.add(key)
    user_state["alerted_ids"] = sorted(keep)


def process_user_summary(user: dict, sessions: list[dict], state: dict, force: bool = False) -> None:
    """Send tomorrow's L? sessions summary to one user at ~20:00 IL."""
    chat_id = user["chat_id"]
    prefs = user.get("prefs") or {}
    if not prefs.get("level"):
        return

    now = datetime.now(TZ)
    user_state = state.setdefault(str(chat_id), {})

    if not force:
        h, m = now.hour, now.minute
        in_window = (h == 19 and m >= 55) or (h == 20 and m <= 30)
        if not in_window:
            return
        if now.weekday() in (3, 4):  # Thu (Fri=no sessions) or Fri (Sat=no sessions)
            return
        today_iso = now.date().isoformat()
        if user_state.get("last_summary_date") == today_iso:
            return

    tomorrow = (now + timedelta(days=1)).date()
    matching = [
        s for s in sessions
        if matches_prefs(s, prefs) and s["start"].date() == tomorrow
    ]
    matching.sort(key=lambda s: s["start"])

    side_he = {"right": "ימין", "left": "שמאל", "both": "ימין+שמאל"}[prefs.get("direction", "left")]
    weekday_he = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"][tomorrow.weekday()]
    header = f"📅 <b>Surf Park — סשני L{prefs['level']} {side_he} ליום {weekday_he} ({tomorrow.strftime('%d/%m')})</b>\n"
    body = (
        "\n".join(
            f"• {s['start'].strftime('%H:%M')} — {s['title']} — נותרו {s['spots']} מקומות"
            for s in matching
        )
        if matching else "אין סשנים מחר."
    )
    telegram_send(chat_id, header + body)
    user_state["last_summary_date"] = now.date().isoformat()
    print(f"  → SUMMARY to {chat_id} ({len(matching)} sessions)")


# ---------- Main ----------
def alerts_disabled_today() -> bool:
    """No alerts on Friday/Saturday (no sessions). Summary still allowed Sat 20:00."""
    return datetime.now(TZ).weekday() in (4, 5)


def in_quiet_hours() -> bool:
    """Active 08:00–18:00 Asia/Jerusalem."""
    h = datetime.now(TZ).hour
    return h >= 18 or h < 8


def main():
    state = load_state()

    try:
        sessions = fetch_all_windows(days_ahead=9)
    except Exception as e:
        print(f"scrape failed: {e}", file=sys.stderr)
        return
    print(f"Parsed {len(sessions)} sessions across windows.")

    push_sessions(sessions)
    users = fetch_users()
    print(f"Subscribed users: {len(users)}")

    # Daily summary path runs always (it self-gates by time/day).
    for user in users:
        process_user_summary(user, sessions, state)

    if alerts_disabled_today():
        print("Fri/Sat — alerts disabled.")
        save_state(state)
        return
    if in_quiet_hours():
        print("Quiet hours — alerts skipped.")
        save_state(state)
        return

    for user in users:
        process_user_alerts(user, sessions, state)

    save_state(state)


if __name__ == "__main__":
    main()
