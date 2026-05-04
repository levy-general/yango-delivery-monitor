"""
Telegram bot poller — handles /reset, /today, /all commands.

Polled by GitHub Actions every cron tick (≤15 min delay between user message
and bot response). Stores per-chat preferences in prefs.json and last seen
update id in bot_state.json so it doesn't reprocess messages.

Commands:
  /reset  - inline-keyboard flow to set wave level + direction.
  /today  - list today's sessions matching prefs.
  /all    - list all upcoming sessions (no filter).
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import monitor_srf as msrf

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TZ = ZoneInfo("Asia/Jerusalem")
STATE_PATH = Path("bot_state.json")
PREFS_PATH = Path("prefs.json")

WAVE_LEVELS = ["L1", "L2", "L3", "L4", "L5", "L6"]
DIRECTIONS = [("ימין", "right"), ("שמאל", "left"), ("שניהם", "both")]


def tg(method: str, **payload) -> dict:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def load_json(path: Path, default: dict) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def wave_keyboard() -> dict:
    return {"inline_keyboard": [
        [{"text": w, "callback_data": f"wave:{w[1]}"} for w in WAVE_LEVELS[:3]],
        [{"text": w, "callback_data": f"wave:{w[1]}"} for w in WAVE_LEVELS[3:]],
    ]}


def direction_keyboard(level: int) -> dict:
    return {"inline_keyboard": [[
        {"text": label, "callback_data": f"dir:{level}:{value}"}
        for label, value in DIRECTIONS
    ]]}


def filter_sessions(sessions: list[dict], prefs: dict) -> list[dict]:
    level = prefs.get("level", 6)
    direction = prefs.get("direction", "left")
    out = []
    for s in sessions:
        if s["level"] != level:
            continue
        area = s["area"].lower()
        if direction == "left" and "left" not in area:
            continue
        if direction == "right" and "right" not in area:
            continue
        # "both" → no direction filter
        out.append(s)
    return out


def fmt_session(s: dict) -> str:
    side = "שמאל" if "left" in s["area"].lower() else "ימין"
    return f"• {s['start'].strftime('%d/%m %H:%M')} {side} — {s['title']} — נותרו {s['spots']} מקומות"


def cmd_today(chat_id: int, sessions: list[dict], prefs: dict) -> None:
    today = datetime.now(TZ).date()
    matching = [s for s in filter_sessions(sessions, prefs) if s["start"].date() == today]
    matching.sort(key=lambda s: s["start"])
    label = describe_prefs(prefs)
    if not matching:
        text = f"📋 <b>סטטוס היום ({label})</b>\nאין סשנים מתאימים היום."
    else:
        text = f"📋 <b>סטטוס היום ({label})</b>\n" + "\n".join(fmt_session(s) for s in matching)
    tg("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", disable_web_page_preview=True)


def cmd_all(chat_id: int, sessions: list[dict]) -> None:
    upcoming = [s for s in sessions if s["start"] > datetime.now(TZ)]
    upcoming.sort(key=lambda s: s["start"])
    if not upcoming:
        tg("sendMessage", chat_id=chat_id, text="אין סשנים קרובים.")
        return
    # Group by day
    lines = ["📋 <b>כל הסשנים הקרובים</b>"]
    last_day = None
    for s in upcoming[:80]:  # cap to avoid Telegram 4096 char limit
        day = s["start"].date()
        if day != last_day:
            lines.append(f"\n<b>{day.strftime('%A %d/%m')}</b>")
            last_day = day
        lvl = f"L{s['level']}"
        side = "שמאל" if "left" in s["area"].lower() else "ימין"
        lines.append(f"• {s['start'].strftime('%H:%M')} {lvl} {side} — נותרו {s['spots']}")
    text = "\n".join(lines)
    tg("sendMessage", chat_id=chat_id, text=text[:4090], parse_mode="HTML", disable_web_page_preview=True)


def cmd_reset(chat_id: int) -> None:
    tg("sendMessage", chat_id=chat_id,
       text="🔄 <b>איפוס הגדרות</b>\nבחר רמת גל:",
       parse_mode="HTML", reply_markup=wave_keyboard())


def describe_prefs(prefs: dict) -> str:
    level = prefs.get("level", 6)
    direction = prefs.get("direction", "left")
    side = {"right": "ימין", "left": "שמאל", "both": "ימין+שמאל"}[direction]
    return f"L{level} {side}"


def handle_callback(cb: dict, prefs: dict) -> None:
    data = cb.get("data", "")
    chat_id = cb["message"]["chat"]["id"]
    msg_id = cb["message"]["message_id"]
    cb_id = cb["id"]

    if data.startswith("wave:"):
        level = int(data.split(":")[1])
        tg("editMessageText", chat_id=chat_id, message_id=msg_id,
           text=f"רמת גל: <b>L{level}</b>\nבחר כיוון:",
           parse_mode="HTML", reply_markup=direction_keyboard(level))
        tg("answerCallbackQuery", callback_query_id=cb_id)

    elif data.startswith("dir:"):
        _, level, direction = data.split(":")
        prefs["level"] = int(level)
        prefs["direction"] = direction
        save_json(PREFS_PATH, prefs)
        tg("editMessageText", chat_id=chat_id, message_id=msg_id,
           text=f"✅ הוגדר: <b>{describe_prefs(prefs)}</b>\n"
                f"התראות 1:45 (>12 מקומות) ו-1:15 (>10 מקומות) יישלחו רק לסשנים אלה.",
           parse_mode="HTML")
        tg("answerCallbackQuery", callback_query_id=cb_id, text="נשמר!")

    else:
        tg("answerCallbackQuery", callback_query_id=cb_id)


def handle_message(msg: dict, sessions: list[dict] | None, prefs: dict) -> None:
    text = (msg.get("text") or "").strip()
    chat_id = msg["chat"]["id"]
    # Strip @BotName suffix from group commands
    cmd = text.split()[0].split("@")[0] if text else ""

    if cmd == "/reset":
        cmd_reset(chat_id)
    elif cmd == "/today":
        cmd_today(chat_id, sessions or [], prefs)
    elif cmd == "/all":
        cmd_all(chat_id, sessions or [])


def main():
    if not BOT_TOKEN:
        print("No TELEGRAM_BOT_TOKEN set", file=sys.stderr)
        return

    state = load_json(STATE_PATH, {})
    prefs = load_json(PREFS_PATH, {"level": 6, "direction": "left"})
    offset = state.get("last_update_id", 0) + 1

    resp = tg("getUpdates", offset=offset, timeout=0, allowed_updates=["message", "callback_query"])
    updates = resp.get("result", [])
    if not updates:
        print("No new updates.")
        return

    # Fetch sessions once if any /today or /all is in the batch.
    needs_sessions = any(
        (u.get("message", {}).get("text", "") or "").startswith(("/today", "/all"))
        for u in updates
    )
    sessions = msrf.parse_sessions(msrf.fetch_html()) if needs_sessions else None

    last_id = offset - 1
    for u in updates:
        last_id = max(last_id, u["update_id"])
        try:
            if "callback_query" in u:
                handle_callback(u["callback_query"], prefs)
            elif "message" in u:
                handle_message(u["message"], sessions, prefs)
        except Exception as e:
            print(f"update {u['update_id']} error: {e}", file=sys.stderr)

    state["last_update_id"] = last_id
    save_json(STATE_PATH, state)
    print(f"Processed {len(updates)} updates.")


if __name__ == "__main__":
    main()
