"""
One-time login helper.

Run on your local Mac. A real browser window will open with deli.yango.com.
Click "כניסה", log in with your phone+SMS, browse around once to make sure
you're logged in, then come back to the terminal and press Enter.

The script saves your authenticated session (cookies + storage) to auth.json,
which monitor.py uses on every run.

Re-run this whenever the bot reports that auth has expired.
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

URL = "https://deli.yango.com/he-il/"
AUTH_FILE = Path("auth.json")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


async def main():
    async with Stealth().use_async(async_playwright()) as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            locale="he-IL",
            user_agent=UA,
            viewport={"width": 1280, "height": 900},
            extra_http_headers={"Accept-Language": "he-IL,he;q=0.9,en;q=0.8"},
        )
        page = await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=45000)

        print("\n" + "=" * 60)
        print("דפדפן נפתח. תעשה ככה:")
        print("  1. לחץ על 'כניסה' בפינה ימנית למעלה")
        print("  2. התחבר עם טלפון + SMS")
        print("  3. תוודא שאתה מחובר (השם שלך מופיע במקום 'כניסה')")
        print("  4. חזור לטרמינל הזה ולחץ Enter")
        print("=" * 60)
        await asyncio.get_event_loop().run_in_executor(None, input, "\nלחץ Enter כשסיימת להתחבר: ")

        await ctx.storage_state(path=str(AUTH_FILE))
        print(f"\n✓ Session נשמר ל-{AUTH_FILE.resolve()}")
        print(f"  גודל: {AUTH_FILE.stat().st_size} bytes")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
