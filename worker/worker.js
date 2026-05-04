// Cloudflare Worker — Surf Park Telegram bot.
//
// Handles instant Telegram webhook callbacks for /reset, /today, /all and
// inline-keyboard button presses. Stores user prefs (wave level + direction)
// in CF KV. Exposes GET /prefs for the GitHub Actions monitor to read.
//
// Bindings (set via wrangler.toml or dashboard):
//   KV         - KV namespace for prefs/state
//   BOT_TOKEN  - Telegram bot token (secret)

const SRF_URL =
  "https://www.srfparktlv.co.il/sessions/?show-children=false&show-adults=false&zone=reef-left";

const SESSION_RE = new RegExp(
  '<div class="box_session[^"]*"\\s*[^>]*?' +
    'data-id="(?<id>\\d+)"[^>]*?' +
    'data-area="(?<area>[^"]+)"[^>]*?' +
    'data-level="(?<level>\\d+)"' +
    "(?<rest>[\\s\\S]*?)</div>\\s*</div>\\s*</div>",
  "g"
);
const DATES_RE = /data-dates="(\d{8}T\d{6})\/(\d{8}T\d{6})"/;
const SPOTS_RE = /נותרו\s+(\d+)\s+מקומות/;
const TITLE_RE = /<div class="title">\s*([^<]+?)\s*</;

const SIDE_HE = { right: "ימין", left: "שמאל", both: "ימין+שמאל" };

// ---------- KV helpers ----------
async function getPrefs(env) {
  const raw = await env.KV.get("prefs");
  if (!raw) return { level: 6, direction: "left" };
  try {
    return JSON.parse(raw);
  } catch {
    return { level: 6, direction: "left" };
  }
}

async function setPrefs(env, prefs) {
  await env.KV.put("prefs", JSON.stringify(prefs));
}

// ---------- Telegram helpers ----------
async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function waveKeyboard() {
  const row = (xs) =>
    xs.map((n) => ({ text: `L${n}`, callback_data: `wave:${n}` }));
  return { inline_keyboard: [row([1, 2, 3]), row([4, 5, 6])] };
}

function dirKeyboard(level) {
  return {
    inline_keyboard: [
      [
        { text: "ימין", callback_data: `dir:${level}:right` },
        { text: "שמאל", callback_data: `dir:${level}:left` },
        { text: "שניהם", callback_data: `dir:${level}:both` },
      ],
    ],
  };
}

function describePrefs(p) {
  return `L${p.level} ${SIDE_HE[p.direction]}`;
}

// ---------- SRF parsing ----------
// Returns sessions sorted by start time, each:
//   { id, level, area, start (ms epoch), spots, title, hour }
async function fetchSessions() {
  const res = await fetch(SRF_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    },
  });
  const html = await res.text();
  const sessions = [];
  let m;
  SESSION_RE.lastIndex = 0;
  while ((m = SESSION_RE.exec(html)) !== null) {
    const block = m[0];
    const rest = m.groups.rest;
    const d = block.match(DATES_RE);
    if (!d) continue;
    const s = rest.match(SPOTS_RE);
    const t = rest.match(TITLE_RE);
    // 20260504T140000 → 2026-05-04T14:00:00 (interpret as Asia/Jerusalem local)
    const iso = `${d[1].slice(0, 4)}-${d[1].slice(4, 6)}-${d[1].slice(
      6,
      8
    )}T${d[1].slice(9, 11)}:${d[1].slice(11, 13)}:00+03:00`;
    sessions.push({
      id: m.groups.id,
      level: parseInt(m.groups.level, 10),
      area: m.groups.area.trim(),
      start: new Date(iso).getTime(),
      spots: s ? parseInt(s[1], 10) : 0,
      title: t ? t[1].trim() : "",
    });
  }
  sessions.sort((a, b) => a.start - b.start);
  return sessions;
}

function matchesPrefs(s, prefs) {
  if (s.level !== prefs.level) return false;
  const a = s.area.toLowerCase();
  if (prefs.direction === "left") return a.includes("left");
  if (prefs.direction === "right") return a.includes("right");
  return true;
}

function fmtTime(epochMs) {
  // Always render in Asia/Jerusalem.
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(epochMs));
}

function fmtSession(s, withSide = true) {
  const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
  const t = fmtTime(s.start);
  const sideStr = withSide ? ` ${side}` : "";
  return `• ${t}${sideStr} — ${s.title} — נותרו ${s.spots} מקומות`;
}

// ---------- Command handlers ----------
async function cmdReset(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔄 <b>איפוס הגדרות</b>\nבחר רמת גל:",
    parse_mode: "HTML",
    reply_markup: waveKeyboard(),
  });
}

async function cmdToday(env, chatId) {
  const prefs = await getPrefs(env);
  const sessions = await fetchSessions();
  const now = new Date();
  const today = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const matching = sessions.filter((s) => {
    if (!matchesPrefs(s, prefs)) return false;
    const d = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s.start));
    return d === today;
  });

  const header = `📋 <b>סטטוס היום (${describePrefs(prefs)})</b>\n`;
  const body = matching.length
    ? matching.map((s) => fmtSession(s, false)).join("\n")
    : "אין סשנים מתאימים היום.";
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: header + body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function cmdAll(env, chatId) {
  const sessions = await fetchSessions();
  const today = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const todays = sessions.filter((s) => {
    const d = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s.start));
    return d === today;
  });

  if (!todays.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "אין סשנים היום." });
    return;
  }

  const lines = ["📋 <b>כל הסשנים היום</b>"];
  for (const s of todays) {
    const time = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(s.start));
    const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
    lines.push(`• ${time} L${s.level} ${side} — נותרו ${s.spots}`);
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n").slice(0, 4090),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---------- Update dispatcher ----------
async function handleUpdate(env, update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || "";
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;

    if (data.startsWith("wave:")) {
      const level = parseInt(data.slice(5), 10);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `רמת גל: <b>L${level}</b>\nבחר כיוון:`,
        parse_mode: "HTML",
        reply_markup: dirKeyboard(level),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    } else if (data.startsWith("dir:")) {
      const [, lvl, dir] = data.split(":");
      const prefs = { level: parseInt(lvl, 10), direction: dir };
      await setPrefs(env, prefs);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text:
          `✅ הוגדר: <b>${describePrefs(prefs)}</b>\n` +
          "התראות 1:45 (>12 מקומות) ו-1:15 (>10 מקומות) יישלחו רק לסשנים אלה.",
        parse_mode: "HTML",
      });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "נשמר!",
      });
    } else {
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    }
    return;
  }

  if (update.message) {
    const text = (update.message.text || "").trim();
    if (!text) return;
    const cmd = text.split(/\s+/)[0].split("@")[0];
    const chatId = update.message.chat.id;
    if (cmd === "/reset") await cmdReset(env, chatId);
    else if (cmd === "/today") await cmdToday(env, chatId);
    else if (cmd === "/all") await cmdAll(env, chatId);
  }
}

// ---------- Worker entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/prefs") {
      const prefs = await getPrefs(env);
      return Response.json(prefs);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      // Fire-and-forget so Telegram gets a 200 immediately.
      try {
        await handleUpdate(env, update);
      } catch (e) {
        console.error("update error:", e);
      }
      return new Response("ok");
    }

    return new Response("levy-bot-worker", { status: 200 });
  },
};
