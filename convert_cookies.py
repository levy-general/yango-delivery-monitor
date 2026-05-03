"""Convert Cookie-Editor JSON export -> Playwright storage_state (auth.json)."""
import json
import re
import sys
from pathlib import Path

SRC = Path("cookies.json")
DST = Path("auth.json")

SAMESITE_MAP = {
    "no_restriction": "None",
    "unspecified": "Lax",
    "lax": "Lax",
    "strict": "Strict",
    None: "Lax",
}

raw = SRC.read_text()
# Cookie-Editor sometimes wraps domains in markdown link syntax: .[yango.com](http://yango.com)
# Cookie-Editor wraps domains as `.[yango.com](http://yango.com)` (markdown link).
# Restrict to short, domain-like content inside the brackets to avoid matching
# across the JSON array opening bracket.
raw = re.sub(r'\[([\w.-]+)\]\(https?://[^\)]+\)', r'\1', raw)

cookies_in = json.loads(raw)
cookies_out = []
for c in cookies_in:
    out = {
        "name": c["name"],
        "value": c["value"],
        "domain": c["domain"],
        "path": c.get("path", "/"),
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", False)),
        "sameSite": SAMESITE_MAP.get(c.get("sameSite"), "Lax"),
    }
    if not c.get("session") and c.get("expirationDate"):
        out["expires"] = int(c["expirationDate"])
    else:
        out["expires"] = -1
    cookies_out.append(out)

storage_state = {"cookies": cookies_out, "origins": []}
DST.write_text(json.dumps(storage_state, ensure_ascii=False, indent=2))
print(f"Wrote {len(cookies_out)} cookies to {DST}")
