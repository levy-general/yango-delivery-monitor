"""
Yango Deli delivery-price monitor.

Fetches current delivery cost + minimum cart for the configured address,
compares against the previous run (state.json), and sends a Telegram
notification when the delivery cost crosses the THRESHOLD (default 15 ILS).

Notifications:
  - Triggered the first time delivery cost drops below THRESHOLD.
  - Triggered again when delivery cost returns to/above THRESHOLD.
  - Errors fetching the price are also reported (rate-limited via state).

Env vars:
  TELEGRAM_BOT_TOKEN  required
  TELEGRAM_CHAT_ID    required
  ADDR_LAT, ADDR_LON, ADDR_CITY, ADDR_STREET, ADDR_HOUSE
  THRESHOLD           default 15
  STATE_PATH          default state.json
"""
import asyncio
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.async_api import async_playwright
from playwright_stealth import Stealth

LAT = float(os.environ.get("ADDR_LAT", "32.126347"))
LON = float(os.environ.get("ADDR_LON", "34.801369"))
CITY = os.environ.get("ADDR_CITY", "תל אביב")
STREET = os.environ.get("ADDR_STREET", "אליהו חכים")
HOUSE = os.environ.get("ADDR_HOUSE", "8")
ADDR_LABEL = f"{STREET} {HOUSE}, {CITY}"

THRESHOLD = float(os.environ.get("THRESHOLD", "15"))
STATE_PATH = Path(os.environ.get("STATE_PATH", "state.json"))

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
AUTH_PATH = Path(os.environ.get("AUTH_PATH", "auth.json"))

HOME_URL = "https://deli.yango.com/he-il/"
API_URL = "https://deli.yango.com/api/v1/providers/v2/service-info"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


async def fetch_price() -> dict:
    async with Stealth().use_async(async_playwright()) as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx_kwargs = dict(
            locale="he-IL",
            user_agent=UA,
            geolocation={"latitude": LAT, "longitude": LON},
            permissions=["geolocation"],
            viewport={"width": 1280, "height": 900},
            extra_http_headers={"Accept-Language": "he-IL,he;q=0.9,en;q=0.8"},
        )
        if AUTH_PATH.exists():
            ctx_kwargs["storage_state"] = str(AUTH_PATH)
        ctx = await browser.new_context(**ctx_kwargs)
        page = await ctx.new_page()
        await page.goto(HOME_URL, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)

        params = {
            "additionalData[city]": CITY,
            "additionalData[street]": STREET,
            "additionalData[house]": HOUSE,
            "position[location][0]": str(LON),
            "position[location][1]": str(LAT),
            "fallbackCurrencySign": "₪",
            "depotType": "regular",
        }
        resp = await ctx.request.get(API_URL, params=params)
        if not resp.ok:
            raise RuntimeError(f"API {resp.status}: {(await resp.text())[:300]}")
        data = await resp.json()
        await browser.close()

    pricing = data.get("pricingConditions") or {}
    return {
        "deliveryCost": pricing.get("deliveryCost"),
        "deliveryCostSigned": pricing.get("deliveryCostSigned"),
        "minimalCartPrice": pricing.get("minimalCartPrice"),
        "minimalCartPriceSigned": pricing.get("minimalCartPriceSigned"),
        "status": data.get("status"),
        "isSurge": data.get("isSurge"),
    }


def telegram_send(text: str) -> None:
    if not (BOT_TOKEN and CHAT_ID):
        print(f"[no telegram creds] would send: {text}", file=sys.stderr)
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


def bootstrap_auth():
    """If AUTH_B64 env var is set (GH Actions), decode it to AUTH_PATH."""
    b64 = os.environ.get("AUTH_B64")
    if b64 and not AUTH_PATH.exists():
        import base64
        AUTH_PATH.write_bytes(base64.b64decode(b64))


def in_quiet_hours() -> bool:
    """Skip runs outside 13:00–23:00 Israel time (Yango)."""
    hour = datetime.now(ZoneInfo("Asia/Jerusalem")).hour
    return hour >= 23 or hour < 13


def main():
    if in_quiet_hours():
        print("Quiet hours (23:00–13:00 Asia/Jerusalem) — skipping.")
        return
    bootstrap_auth()
    state = load_state()
    prev_cost = state.get("deliveryCost")
    prev_below = state.get("below_threshold", False)

    try:
        result = asyncio.run(fetch_price())
    except Exception as e:
        err = f"⚠️ Yango monitor: שגיאה בקריאה ל-API\n<code>{e}</code>"
        # Only notify error if last run succeeded — avoid spam if Yango is down for hours
        if not state.get("last_error"):
            telegram_send(err)
        state["last_error"] = str(e)
        save_state(state)
        sys.exit(1)

    cost = result["deliveryCost"]
    minimum = result["minimalCartPrice"]
    cost_str = result["deliveryCostSigned"] or f"{cost} ₪"
    min_str = result["minimalCartPriceSigned"] or f"{minimum} ₪"

    print(json.dumps({"prev_cost": prev_cost, "now": result}, ensure_ascii=False))

    if cost is None:
        print("No deliveryCost in response", file=sys.stderr)
        sys.exit(1)

    now_below = cost < THRESHOLD

    # Notify on threshold crossing
    if now_below and not prev_below:
        telegram_send(
            f"🟢 <b>Yango Deli</b>\n"
            f"מחיר משלוח ירד!\n"
            f"כתובת: {ADDR_LABEL}\n"
            f"דמי משלוח: {cost_str}\n"
            f"מינימום הזמנה: {min_str}"
        )
    elif (not now_below) and prev_below:
        telegram_send(
            f"🔴 <b>Yango Deli</b>\n"
            f"חזר למחיר רגיל\n"
            f"כתובת: {ADDR_LABEL}\n"
            f"דמי משלוח: {cost_str}\n"
            f"מינימום הזמנה: {min_str}"
        )
    elif prev_cost is not None and prev_cost != cost and now_below:
        telegram_send(
            f"ℹ️ <b>Yango Deli</b>\n"
            f"דמי משלוח השתנו: {prev_cost} ₪ → {cost_str}\n"
            f"כתובת: {ADDR_LABEL}\n"
            f"מינימום הזמנה: {min_str}"
        )

    state.update({
        "deliveryCost": cost,
        "minimalCartPrice": minimum,
        "below_threshold": now_below,
        "last_error": None,
    })
    save_state(state)


if __name__ == "__main__":
    main()
