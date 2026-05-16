"""Driving ETA via the public OSRM routing API (deterministic JSON, no scraping)."""
import json
import sys
import urllib.request

# Public OSRM demo server — best-effort, rate-limited, no API key.
OSRM = "https://router.project-osrm.org/route/v1/driving"


def driving_eta(origin: tuple[float, float], dest: tuple[float, float]) -> str:
    """Returns a string like '~42 דק' (43.7 ק"מ)' or '' on failure.

    origin/dest are (lat, lon). OSRM expects lon,lat order.
    """
    try:
        coords = f"{origin[1]},{origin[0]};{dest[1]},{dest[0]}"
        url = f"{OSRM}/{coords}?overview=false"
        req = urllib.request.Request(url, headers={"User-Agent": "surf-bot/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        if data.get("code") != "Ok" or not data.get("routes"):
            return ""
        route = data["routes"][0]
        mins = round(route["duration"] / 60)
        km = route["distance"] / 1000
        return f"~{mins} דק' ({km:.1f} ק\"מ)"
    except Exception as e:
        print(f"travel error: {e}", file=sys.stderr)
        return ""


SURF_PARK_COORDS = (32.043798, 34.802307)  # איתן לבני 30, ת"א

if __name__ == "__main__":
    print(driving_eta((32.126347, 34.801369), SURF_PARK_COORDS))
