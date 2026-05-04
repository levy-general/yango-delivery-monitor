"""
Surf Park TLV — L6 reef-left session monitor.

Fetches the sessions page, finds upcoming L6 שמאל sessions, and sends a
Telegram alert ~1h45m before a session starts if it has more than 12 spots
available. Each session is alerted at most once.

Active hours: 08:00–18:00 Asia/Jerusalem.

Env vars:
  TELEGRAM_BOT_TOKEN    required
  TELEGRAM_CHAT_ID      required
  SRF_THRESHOLD         default 12 (alert when spots > this)
  SRF_LEAD_MINUTES      default 105 (1h45m before start)
  SRF_WINDOW_MINUTES    default 8  (cron tolerance, half-window)
  STATE_PATH            default srf_state.json
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

URL = "https://www.srfparktlv.co.il/sessions/?show-children=false&show-adults=false&zone=reef-left"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Travel: from אליהו חכים 8 -> איתן לבני 30, both Tel Aviv.
# OSRM public demo: free, no key, but uses a static road graph (no live traffic).
TRAVEL_FROM = (32.126347, 34.801369)   # (lat, lon)
TRAVEL_TO = (32.043798, 34.802307)
OSRM_URL = (
    f"https://router.project-osrm.org/route/v1/driving/"
    f"{TRAVEL_FROM[1]},{TRAVEL_FROM[0]};{TRAVEL_TO[1]},{TRAVEL_TO[0]}?overview=false"
)

# (lead minutes before session, minimum spots to alert at that lead)
# 105m = 1h45 → > 12 spots; 75m = 1h15 → > 10 spots
LEADS = [
    (int(p.split(":")[0]), int(p.split(":")[1]))
    for p in os.environ.get("SRF_LEADS", "105:12,75:10").split(",")
]
WINDOW_MIN = int(os.environ.get("SRF_WINDOW_MINUTES", "8"))  # ±8 min around each lead time
STATE_PATH = Path(os.environ.get("STATE_PATH", "srf_state.json"))

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

TZ = ZoneInfo("Asia/Jerusalem")

# Matches one session block. We rely on data-id, data-area, data-level, data-dates
# being on the opening tag, and "נותרו N מקומות" / hour text appearing inside.
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
HOUR_RE = re.compile(r'<div class="hour">([^<]+)</div>')
TITLE_RE = re.compile(r'<div class="title">\s*([^<]+?)\s*<')


def in_quiet_hours() -> bool:
    """Active 08:00–18:00 Asia/Jerusalem; quiet otherwise."""
    hour = datetime.now(TZ).hour
    return hour >= 18 or hour < 8


def fetch_travel() -> str:
    """Return human-readable travel-time string, or empty string on failure."""
    try:
        req = urllib.request.Request(OSRM_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        route = (data.get("routes") or [{}])[0]
        secs = route.get("duration")
        meters = route.get("distance")
        if secs is None:
            return ""
        mins = round(secs / 60)
        km = (meters or 0) / 1000
        return f"~{mins} דק' ({km:.1f} ק\"מ, ללא תנועה)"
    except Exception as e:
        print(f"travel error: {e}", file=sys.stderr)
        return ""


def fetch_html() -> str:
    req = urllib.request.Request(URL, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_sessions(html: str) -> list[dict]:
    sessions = []
    for m in SESSION_RE.finditer(html):
        block = m.group(0)
        rest = m.group("rest")
        d = DATES_RE.search(block)
        s = SPOTS_RE.search(rest)
        h = HOUR_RE.search(rest)
        t = TITLE_RE.search(rest)
        if not d:
            continue
        try:
            start = datetime.strptime(d.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=TZ)
        except ValueError:
            continue
        sessions.append({
            "id": m.group("id"),
            "area": m.group("area").strip(),
            "level": int(m.group("level")),
            "start": start,
            "spots": int(s.group(1)) if s else 0,
            "hour_text": (h.group(1).strip() if h else ""),
            "title": (t.group(1).strip() if t else ""),
        })
    return sessions


def telegram_send(text: str) -> None:
    if not (BOT_TOKEN and CHAT_ID):
        print(f"[no telegram creds] {text}", file=sys.stderr)
        return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    with urllib.request.urlopen(url, data=data, timeout=15) as r:
        r.read()


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2))


def main():
    if in_quiet_hours():
        print("Quiet hours (18:00–08:00 Asia/Jerusalem) — skipping.")
        return

    state = load_state()
    alerted = set(state.get("alerted_ids", []))

    html = fetch_html()
    sessions = parse_sessions(html)
    print(f"Parsed {len(sessions)} sessions.")

    now = datetime.now(TZ)
    window = timedelta(minutes=WINDOW_MIN)

    for s in sessions:
        if s["level"] != 6 or "left" not in s["area"].lower():
            continue
        time_until = s["start"] - now
        for lead, threshold in LEADS:
            target = timedelta(minutes=lead)
            in_window = (target - window) <= time_until <= (target + window)
            key = f"{s['id']}_{lead}"
            print(f"  L6-left id={s['id']} start={s['start'].strftime('%Y-%m-%d %H:%M')} "
                  f"spots={s['spots']} lead={lead}m thr>{threshold} "
                  f"in_window={in_window} alerted={key in alerted}")
            if not in_window or s["spots"] <= threshold or key in alerted:
                continue

            mins_to = int(time_until.total_seconds() / 60)
            travel = fetch_travel()
            travel_line = f"זמן נסיעה: {travel}\n" if travel else ""
            msg = (
                f"🏄 <b>Surf Park</b>\n"
                f"שם הסשן: {s['title']}\n"
                f"שעה: {s['start'].strftime('%H:%M')} ({s['start'].strftime('%d/%m')}) — בעוד ~{mins_to} דק'\n"
                f"מקומות פנויים: {s['spots']}\n"
                f"{travel_line}"
                f"<a href=\"{URL}\">לרשום עכשיו →</a>"
            )
            telegram_send(msg)
            alerted.add(key)
            print(f"  → ALERT sent for {key}")

    # Prune keys of sessions that are clearly in the past (>6h ago)
    cutoff = now - timedelta(hours=6)
    by_id = {s["id"]: s for s in sessions}
    keep = set()
    for key in alerted:
        sid = key.split("_")[0]
        s = by_id.get(sid)
        if s and s["start"] > cutoff:
            keep.add(key)
    state["alerted_ids"] = sorted(keep)
    save_state(state)


if __name__ == "__main__":
    main()
