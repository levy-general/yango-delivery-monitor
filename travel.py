"""Get driving ETA with live traffic by scraping Google Maps via Playwright."""
import asyncio
import re
import sys
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


async def _fetch(origin: tuple[float, float], dest: tuple[float, float]) -> str:
    """Returns a string like '~17 דק' (12.3 ק"מ, עם תנועה)' or '' on failure."""
    url = (
        f"https://www.google.com/maps/dir/{origin[0]},{origin[1]}/"
        f"{dest[0]},{dest[1]}/data=!4m2!4m1!3e0?hl=en"
    )
    async with Stealth().use_async(async_playwright()) as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            locale="en-US",
            user_agent=UA,
            viewport={"width": 1280, "height": 900},
        )
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            # Dismiss the cookie consent if present.
            for name_pattern in (r"reject all", r"accept all", r"i agree"):
                try:
                    await page.get_by_role("button", name=re.compile(name_pattern, re.I)).first.click(timeout=2000)
                    break
                except Exception:
                    continue
            await page.wait_for_timeout(4000)

            body = await page.locator("body").inner_text()
        finally:
            await browser.close()

    minutes = re.findall(r'\b(\d+)\s*min\b', body, re.I)
    hours = re.findall(r'\b(\d+)\s*hr\b', body, re.I)
    kms = re.findall(r'\b(\d+(?:\.\d+)?)\s*km\b', body, re.I)
    if not minutes:
        return ""
    # Google Maps lists the best route first; take the first ETA.
    mins = int(minutes[0])
    if hours:
        # Format like "1 hr 5 min" — combine.
        mins = int(hours[0]) * 60 + mins
    km = float(kms[0]) if kms else None
    if km is not None:
        return f"~{mins} דק' ({km:.1f} ק\"מ, עם תנועה)"
    return f"~{mins} דק' (עם תנועה)"


def driving_eta(origin: tuple[float, float], dest: tuple[float, float]) -> str:
    try:
        return asyncio.run(_fetch(origin, dest))
    except Exception as e:
        print(f"travel error: {e}", file=sys.stderr)
        return ""


if __name__ == "__main__":
    print(driving_eta((32.126347, 34.801369), (32.043798, 34.802307)))
