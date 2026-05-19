// Cloudflare Worker — Surf Park multi-user Telegram bot.
//
// Each user has their own prefs (level/direction/origin) stored under
// `user:{chat_id}:prefs`. A `users` KV key holds the set of subscribed
// chat ids for the alert iterator (in monitor_srf.py).
//
// Endpoints:
//   POST /webhook    — Telegram updates (commands + callback queries + onboarding)
//   GET  /users      — JSON {users: [chat_id, ...]} (for monitor)
//   GET  /user/:id   — JSON of that user's prefs (for monitor / debug)
//   POST /sessions   — pushed by GH Actions: latest scraped sessions
//   GET  /debug      — counts
//
// Bindings:
//   KV (namespace), BOT_TOKEN, PUSH_SECRET

const SIDE_HE = { right: "ימין", left: "שמאל", both: "ימין+שמאל" };
const WAVE_LEVELS = [1, 2, 3, 4, 5, 6];
const ADMIN_CHAT_ID = 328859712;  // Shay — sole admin; can approve new users.
const SRF_URL = "https://www.srfparktlv.co.il/sessions/?show-children=false&show-adults=false&zone=reef-left";
// The worker's public origin. Rename the Cloudflare Worker → update this once.
const WORKER_ORIGIN = "https://surf-bot.shayko22.workers.dev";

// Title rewrites — for sessions with overlong/uninformative names from SRF.
// Match is exact (case-insensitive) on the original title from the site.
const TITLE_OVERRIDES = {
  "2b or not to be - barrel fest": "B2B (B2+B3)",
  "t-time mega turns (new t1+t2)": "T-Times (T1+T2)",
  "t-times pro carves (new t2+t3)": "T-Times Pro (T2+T3)",
  "malibu turns (new m3+m4)": "Malibu (M3+M4)",
  "new advanced carves (t1 only)": "Advanced (T1)",
  "new advanced carves (only t1)": "Advanced (T1)",
  "fifty/fifty (new t1+b1)": "50/50 (T1+B1)",
  "secret spot (new m3)": "Secret (M3)",
};

// Unicode sans-serif bold digits: render bold inside Telegram inline buttons
// where HTML markup is not allowed.
const BOLD_DIGITS = ["𝟬","𝟭","𝟮","𝟯","𝟰","𝟱","𝟲","𝟳","𝟴","𝟵"];
function boldNum(n) {
  return String(n).split("").map((c) => /\d/.test(c) ? BOLD_DIGITS[Number(c)] : c).join("");
}

function displayTitle(raw) {
  if (!raw) return "";
  const key = raw.trim().toLowerCase();
  if (TITLE_OVERRIDES[key]) return TITLE_OVERRIDES[key];
  // Strip the redundant SRF prefix ("L6 - ") and the "(New ...)" wrapper
  // so "L6 Pro (New T2+B2)" → "L6 Pro (T2+B2)".
  return raw
    .replace(/^L\d+\s*[-–—]\s*/, "")
    .replace(/\(\s*New\s+/gi, "(")
    .trim();
}

// Wave-type code from a title, e.g. "L6 Pro (T2+B2)" → "T2+B2".
function waveCode(raw) {
  const t = displayTitle(raw);
  const m = t.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : t;
}

// ---------- Telegram ----------
async function tg(env, method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  return res.json();
}

// ---------- D1 helpers ----------
async function d1Run(env, sql, params = []) {
  if (!env.DB) return { results: [], success: false };
  try {
    return await env.DB.prepare(sql).bind(...params).all();
  } catch (e) {
    console.error("d1 error:", sql.slice(0, 80), e);
    return { results: [], success: false };
  }
}

async function d1First(env, sql, params = []) {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch (e) {
    console.error("d1 first error:", e);
    return null;
  }
}

async function mirrorUserToD1(env, chatId, prefs, status) {
  if (!env.DB) return;
  const levels = JSON.stringify(getLevels(prefs));
  await d1Run(env,
    `INSERT INTO users (telegram_id, full_name, username, tg_first_name, tg_last_name,
       address, lat, lon, levels, direction, spots_threshold, status, cmd_count,
       last_cmd_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       full_name = excluded.full_name,
       username = excluded.username,
       tg_first_name = excluded.tg_first_name,
       tg_last_name = excluded.tg_last_name,
       address = excluded.address,
       lat = excluded.lat,
       lon = excluded.lon,
       levels = excluded.levels,
       direction = excluded.direction,
       spots_threshold = excluded.spots_threshold,
       status = excluded.status,
       cmd_count = excluded.cmd_count,
       last_cmd_at = excluded.last_cmd_at,
       updated_at = datetime('now')`,
    [chatId, prefs.full_name || null, prefs.username || null,
     prefs.tg_first_name || null, prefs.tg_last_name || null,
     prefs.address || null, prefs.lat || null, prefs.lon || null,
     levels, prefs.direction || null, prefs.spots_threshold || null,
     status || null, prefs.cmd_count || 0, prefs.last_cmd_at || null]
  );
}

async function logSearchD1(env, chatId, cmd, levels, direction, date, matched, available) {
  // matched = sessions matching the user's filter (regardless of spots).
  // available = sessions matching AND with spots > 0 (truly bookable).
  // is_available = 1 only when at least one bookable session existed.
  if (!env.DB) return;
  const u = await d1First(env, "SELECT id FROM users WHERE telegram_id = ?", [chatId]);
  await d1Run(env,
    `INSERT INTO search_logs (user_id, command, requested_levels, requested_direction,
       requested_date, matched_count, available_count, is_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [u ? u.id : null, cmd, JSON.stringify(levels || []), direction || null,
     date || null, matched, available, available > 0 ? 1 : 0]
  );
}

async function pushSessionsHistoryD1(env, sessions) {
  if (!env.DB || !sessions.length) return;
  // Batch in chunks of 50 to keep statements small.
  for (let i = 0; i < sessions.length; i += 50) {
    const chunk = sessions.slice(i, i + 50);
    const stmts = chunk.map((s) =>
      env.DB.prepare(
        `INSERT INTO sessions_history (session_id, level, area, start_ts, spots, title)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(s.id, s.level, s.area, s.start, s.spots, s.title || "")
    );
    try { await env.DB.batch(stmts); } catch (e) { console.error("sh batch:", e); }
  }
}

// ---------- Hunt alerts (D1) ----------
async function addHuntAlert(env, chatId, level, direction, date, time, sessionId) {
  if (!env.DB) return null;
  const u = await d1First(env, "SELECT id FROM users WHERE telegram_id = ?", [chatId]);
  if (!u) return null;
  const r = await d1Run(env,
    `INSERT INTO alerts (user_id, level, direction, target_date, target_time, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [u.id, level || null, direction || null, date || null, time || null, sessionId || null]
  );
  return r;
}

async function listUserAlerts(env, chatId) {
  if (!env.DB) return [];
  const r = await d1Run(env,
    `SELECT a.id, a.level, a.direction, a.target_date, a.target_time, a.session_id, a.created_at
     FROM alerts a JOIN users u ON a.user_id = u.id
     WHERE u.telegram_id = ? AND a.is_active = 1
     ORDER BY a.created_at DESC`,
    [chatId]
  );
  return r.results || [];
}

async function cancelAlert(env, chatId, alertId) {
  if (!env.DB) return;
  await d1Run(env,
    `UPDATE alerts SET is_active = 0
     WHERE id = ? AND user_id = (SELECT id FROM users WHERE telegram_id = ?)`,
    [alertId, chatId]
  );
}

// Per-user opaque token used in click-tracking URLs (replaces chat_id).
async function ensureClickToken(env, chatId) {
  if (!env.DB) return null;
  const row = await d1First(env, "SELECT click_token FROM users WHERE telegram_id = ?", [chatId]);
  if (row && row.click_token) return row.click_token;
  const token = Math.random().toString(36).slice(2, 10);
  await d1Run(env, "UPDATE users SET click_token = ? WHERE telegram_id = ?", [token, chatId]);
  return token;
}

async function chatIdFromToken(env, token) {
  if (!env.DB) return null;
  const r = await d1First(env, "SELECT telegram_id FROM users WHERE click_token = ?", [token]);
  return r ? r.telegram_id : null;
}

async function getClickCounts(env, chatId) {
  // Click events live in KV events log.
  const events = await getEvents(env, chatId);
  const ilDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  let total = 0, today = 0;
  for (const e of events) {
    if (e.action !== "click") continue;
    total++;
    const eventDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(e.ts));
    if (eventDate === ilDateStr) today++;
  }
  return { today, total };
}

async function logAlertSent(env, chatId, kind, sessionId = null) {
  if (!env.DB) return;
  await d1Run(env,
    "INSERT INTO alerts_sent (telegram_id, kind, session_id) VALUES (?, ?, ?)",
    [chatId, kind, sessionId]
  );
}

async function getAlertCounts(env, chatId) {
  if (!env.DB) return { today: 0, total: 0, last7: 0, lastAt: null };
  const ilDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const total = await d1First(env, "SELECT COUNT(*) AS c FROM alerts_sent WHERE telegram_id = ?", [chatId]);
  const today = await d1First(env,
    `SELECT COUNT(*) AS c FROM alerts_sent
     WHERE telegram_id = ?
       AND date(datetime(sent_at, '+3 hours')) = ?`, [chatId, ilDateStr]);
  const last7 = await d1First(env,
    `SELECT COUNT(*) AS c FROM alerts_sent
     WHERE telegram_id = ? AND sent_at >= datetime('now', '-7 days')`, [chatId]);
  const lastAt = await d1First(env,
    `SELECT MAX(sent_at) AS t FROM alerts_sent WHERE telegram_id = ?`, [chatId]);
  return {
    today: today ? today.c : 0,
    total: total ? total.c : 0,
    last7: last7 ? last7.c : 0,
    lastAt: lastAt ? lastAt.t : null,
  };
}

async function saveFeedback(env, chatId, content) {
  if (!env.DB) return null;
  const r = await d1Run(env,
    "INSERT INTO feedback (telegram_id, content) VALUES (?, ?)",
    [chatId, content]);
  return r;
}

async function listRecentFeedback(env, limit = 20) {
  if (!env.DB) return [];
  const r = await d1Run(env,
    `SELECT f.id, f.telegram_id, f.content, f.status, f.created_at,
            u.full_name, u.username
     FROM feedback f
     LEFT JOIN users u ON u.telegram_id = f.telegram_id
     ORDER BY f.created_at DESC LIMIT ?`,
    [limit]);
  return r.results || [];
}

async function markFeedbackAck(env, id) {
  if (!env.DB) return;
  await d1Run(env, "UPDATE feedback SET status='acknowledged', acknowledged_at=datetime('now') WHERE id=?", [id]);
}

// #1 — alert admin if the scraper hasn't pushed fresh data recently.
async function checkScrapeHealth(env) {
  const raw = await env.KV.get("last_scrape");
  const now = Date.now();
  let stale = false, info = "";
  if (!raw) {
    stale = true; info = "אין רישום סריקה כלל";
  } else {
    const { ts, count } = JSON.parse(raw);
    const ageMin = Math.round((now - ts) / 60000);
    if (ageMin > 60) { stale = true; info = `סריקה אחרונה לפני ${ageMin} דק'`; }
    else if (count === 0) { stale = true; info = "הסריקה האחרונה החזירה 0 סשנים (SRF אולי שינו את האתר)"; }
  }
  if (!stale) return;
  if (await env.KV.get("health_alerted")) return;  // already alerted, don't spam
  await env.KV.put("health_alerted", "1", { expirationTtl: 21600 });  // re-arm after 6h
  await tg(env, "sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `⚠️ <b>בעיית בריאות במערכת</b>\n${info}\n\nכדאי לבדוק את GitHub Actions / cron-job.org / מבנה ה-HTML של SRF.`,
    parse_mode: "HTML",
  });
}

// #5 — proactively nudge fully-onboarded subscribed users who got 0 alerts in
// the last 7 days (their threshold/level filter is likely too narrow).
async function maybeNudgeRestrictiveUsers(env) {
  // Run at most once/day (guard by IL date).
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if ((await env.KV.get("nudge_day")) === today) return;
  // Only run the sweep around 18:00 IL so messages arrive at a sane hour.
  const hour = parseInt(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false,
  }).format(new Date()), 10);
  if (hour !== 18) return;
  await env.KV.put("nudge_day", today, { expirationTtl: 172800 });

  const users = await getUsers(env);
  for (const id of users) {
    const p = await getUserPrefs(env, id);
    if (!p || !p.onboarded) continue;
    const counts = await getAlertCounts(env, id);
    if (counts.last7 > 0) continue;             // they're getting alerts — fine
    if (p.last_nudge && (Date.now() - p.last_nudge) < 7 * 86400000) continue;  // nudged recently
    p.last_nudge = Date.now();
    await setUserPrefs(env, id, p);
    await tg(env, "sendMessage", {
      chat_id: id,
      text:
        "🌊 שבוע שלם בלי התראות —\n" +
        `ההגדרות שלך (${levelsLabel(getLevels(p))} ${SIDE_HE[p.direction]}, סף ${p.spots_threshold}+) ` +
        "אולי מצמצמות מדי.\n" +
        "שלח /reset כדי להוריד את הסף או להוסיף רמות — ככה תקבל יותר הזדמנויות.",
    });
  }
}

// #8 — keep sessions_history bounded: drop rows older than 90 days, once/day.
async function maybeCleanupHistory(env) {
  if (!env.DB) return;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if ((await env.KV.get("cleanup_day")) === today) return;
  await env.KV.put("cleanup_day", today, { expirationTtl: 172800 });
  await d1Run(env, "DELETE FROM sessions_history WHERE scraped_at < datetime('now','-90 days')");
}

async function fireDueHuntAlerts(env) {
  if (!env.DB) return 0;
  const sessions = await getSessions(env);
  if (!sessions.length) return 0;
  const r = await d1Run(env,
    `SELECT a.id AS alert_id, a.level, a.direction, a.target_date, a.target_time,
       a.session_id, u.telegram_id
     FROM alerts a JOIN users u ON a.user_id = u.id
     WHERE a.is_active = 1`);
  const active = r.results || [];
  const nowMs = Date.now();
  let fired = 0;
  for (const a of active) {
    const match = sessions.find((s) => {
      if (s.spots <= 0) return false;
      if (s.start <= nowMs) return false;  // session already started — not relevant
      if (a.session_id && a.session_id === s.id) return true;
      if (a.level && s.level !== a.level) return false;
      if (a.direction === "left" && !s.area.toLowerCase().includes("left")) return false;
      if (a.direction === "right" && !s.area.toLowerCase().includes("right")) return false;
      if (a.target_date) {
        const d = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(s.start));
        if (d !== a.target_date) return false;
      }
      if (a.target_time) {
        const t = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit",
        }).format(new Date(s.start));
        if (t !== a.target_time) return false;
      }
      return true;
    });
    if (!match) continue;
    const time = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit",
      day: "2-digit", month: "2-digit",
    }).format(new Date(match.start));
    const url = `${WORKER_ORIGIN}/r/${a.telegram_id}/${match.id}?lead=hunt`;
    try {
      await tg(env, "sendMessage", {
        chat_id: a.telegram_id,
        text:
          `🎯 <b>התפנה מקום!</b>\n` +
          `${time} · L${match.level} ${match.area.toLowerCase().includes("left") ? "שמאל" : "ימין"}\n` +
          `${match.title}\n` +
          `נותרו ${match.spots} מקומות.\n` +
          `<a href="${url}">לרשום עכשיו →</a>`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      await d1Run(env, "UPDATE alerts SET is_active=0, notified_at=datetime('now') WHERE id=?", [a.alert_id]);
      await logAlertSent(env, a.telegram_id, "hunt", match.id);
      fired++;
    } catch (e) {
      console.error("hunt fire failed:", e);
    }
  }
  return fired;
}

// ---------- KV helpers ----------
const userKey = (id) => `user:${id}:prefs`;

async function getUserPrefs(env, chatId) {
  const raw = await env.KV.get(userKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function setUserPrefs(env, chatId, prefs) {
  await env.KV.put(userKey(chatId), JSON.stringify(prefs));
  // Mirror to D1 for analytics queries.
  const wl = await getWhitelist(env);
  const us = await getUsers(env);
  const status = !wl.includes(chatId) ? "pending" : us.includes(chatId) ? "active" : "frozen";
  await mirrorUserToD1(env, chatId, prefs, status);
}

async function deleteUser(env, chatId) {
  await env.KV.delete(userKey(chatId));
  await unsubscribeUser(env, chatId);
}

async function unsubscribeUser(env, chatId) {
  const users = await getUsers(env);
  await env.KV.put(
    "users",
    JSON.stringify(users.filter((id) => id !== chatId))
  );
}

async function addUser(env, chatId) {
  const users = await getUsers(env);
  if (!users.includes(chatId)) {
    users.push(chatId);
    await env.KV.put("users", JSON.stringify(users));
  }
}

async function getUsers(env) {
  const raw = await env.KV.get("users");
  return raw ? JSON.parse(raw) : [];
}

// ---------- Event log ----------
const EVENT_CAP = 500;  // last N events kept per user

async function logEvent(env, chatId, action, params = {}) {
  const key = `events:${chatId}`;
  const raw = await env.KV.get(key);
  const events = raw ? JSON.parse(raw) : [];
  events.push({
    ts: new Date().toISOString(),
    action,
    ...params,
  });
  if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
  await env.KV.put(key, JSON.stringify(events));
}

async function getEvents(env, chatId) {
  const raw = await env.KV.get(`events:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}

// ---------- Follow-up queue ----------
async function queueFollowup(env, item) {
  const raw = await env.KV.get("followups");
  const arr = raw ? JSON.parse(raw) : [];
  // Avoid duplicate queueing for the same chat+session.
  const key = `${item.chat_id}:${item.session_id}`;
  if (arr.some((x) => `${x.chat_id}:${x.session_id}` === key)) return;
  arr.push(item);
  await env.KV.put("followups", JSON.stringify(arr));
}

async function getFollowups(env) {
  const raw = await env.KV.get("followups");
  return raw ? JSON.parse(raw) : [];
}

async function setFollowups(env, arr) {
  await env.KV.put("followups", JSON.stringify(arr));
}

async function processDueFollowups(env) {
  const now = Date.now();
  const all = await getFollowups(env);
  const remaining = [];
  let sent = 0;
  for (const f of all) {
    if (f.due_ts > now) { remaining.push(f); continue; }
    try {
      const when = f.session_start
        ? new Date(f.session_start).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })
        : "(לא ידוע)";
      const title = f.session_title || "סשן";
      await tg(env, "sendMessage", {
        chat_id: f.chat_id,
        text:
          `🏄 רגע אחרון —\n` +
          `הצלחת להירשם ל<b>${title}</b> בשעה <b>${when}</b>?`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "✅ כן, נרשמתי", callback_data: `reg:yes:${f.session_id}` },
          { text: "❌ לא", callback_data: `reg:no:${f.session_id}` },
        ]] },
      });
      await logAlertSent(env, f.chat_id, "followup", f.session_id);
      sent++;
    } catch (e) {
      console.error("followup send failed:", e);
    }
  }
  if (sent > 0) await setFollowups(env, remaining);
  return sent;
}

// Aggregate behavioural signals from raw events for the analytics dump.
function computeStats(events) {
  if (!events.length) return null;
  const tz = "Asia/Jerusalem";
  const byCmd = {}, byCallback = {}, byHour = {}, byWeekday = {}, byDate = {};
  const datesPicked = {}, addressInputs = [];
  let resultsEmpty = 0, resultsHits = 0;
  let firstTs = null, lastTs = null;
  for (const e of events) {
    if (!firstTs || e.ts < firstTs) firstTs = e.ts;
    if (!lastTs || e.ts > lastTs) lastTs = e.ts;
    const d = new Date(e.ts);
    const ilParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const hour = parseInt(ilParts.find((p) => p.type === "hour").value, 10);
    const wd = ilParts.find((p) => p.type === "weekday").value;
    const dayKey = `${ilParts.find((p) => p.type === "year").value}-${ilParts.find((p) => p.type === "month").value}-${ilParts.find((p) => p.type === "day").value}`;
    byHour[hour] = (byHour[hour] || 0) + 1;
    byWeekday[wd] = (byWeekday[wd] || 0) + 1;
    byDate[dayKey] = (byDate[dayKey] || 0) + 1;
    if (e.action === "command") byCmd[e.cmd] = (byCmd[e.cmd] || 0) + 1;
    if (e.action === "callback") byCallback[e.data] = (byCallback[e.data] || 0) + 1;
    if (e.action === "result") {
      if (e.matched > 0) resultsHits++;
      else resultsEmpty++;
      if (e.cmd === "/date" && e.date) datesPicked[e.date] = (datesPicked[e.date] || 0) + 1;
    }
    if (e.action === "address_input" && e.text) addressInputs.push(e.text);
  }
  // "Probable registrations" — for each click we recorded, find a later
  // sessions-snapshot event in the events log to compare spots.
  // (Approximation only; SRF doesn't expose actual booking confirmations.)
  let clickCount = 0;
  const clicksBySession = {};       // session_id → spots_at_click
  let regYes = 0, regNo = 0;
  for (const e of events) {
    if (e.action === "click") {
      clickCount++;
      if (e.session_id) clicksBySession[e.session_id] = e.session_spots_at_click;
    }
    if (e.action === "registration_report") {
      if (e.registered) regYes++; else regNo++;
    }
  }
  const activeDays = Object.keys(byDate).length;
  const totalEvents = events.length;
  return {
    first_event: firstTs,
    last_event: lastTs,
    total_events: totalEvents,
    active_days: activeDays,
    avg_events_per_active_day: +(totalEvents / activeDays).toFixed(2),
    by_command: byCmd,
    by_callback: byCallback,
    by_hour_il: byHour,
    by_weekday_il: byWeekday,
    by_date_il: byDate,
    results: { empty: resultsEmpty, hits: resultsHits },
    dates_picked: datesPicked,
    address_inputs: addressInputs,
    alert_clicks: clickCount,
    registrations_confirmed: regYes,
    registrations_declined: regNo,
    clicks_by_session: clicksBySession,
  };
}

async function getKnownUsers(env) {
  const raw = await env.KV.get("known_users");
  return raw ? JSON.parse(raw) : [];
}

async function addKnownUser(env, chatId) {
  const known = await getKnownUsers(env);
  if (!known.includes(chatId)) {
    known.push(chatId);
    await env.KV.put("known_users", JSON.stringify(known));
  }
}

async function getSessions(env) {
  const raw = await env.KV.get("sessions");
  return raw ? JSON.parse(raw) : [];
}

// ---------- Whitelist ----------
async function getWhitelist(env) {
  const raw = await env.KV.get("whitelist");
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(ADMIN_CHAT_ID)) list.push(ADMIN_CHAT_ID);
  return list;
}

async function isApproved(env, chatId) {
  return (await getWhitelist(env)).includes(chatId);
}

async function approveUser(env, chatId) {
  const wl = await getWhitelist(env);
  if (!wl.includes(chatId)) {
    wl.push(chatId);
    await env.KV.put("whitelist", JSON.stringify(wl));
  }
}

async function revokeUser(env, chatId) {
  if (chatId === ADMIN_CHAT_ID) return;  // never remove admin
  const wl = await getWhitelist(env);
  await env.KV.put(
    "whitelist",
    JSON.stringify(wl.filter((id) => id !== chatId))
  );
  await deleteUser(env, chatId);
}

async function userStatus(env, id) {
  // Status is admin-controlled only:
  //   In whitelist → active (🟢)  · Out → frozen (🔴, admin revoked)
  // Whether the user paused their own alerts is a separate sub-state shown
  // as a badge — it does NOT change the status colour.
  const wl = await getWhitelist(env);
  if (!wl.includes(id)) return { status: "מוקפא", dot: "🔴" };
  return { status: "פעיל", dot: "🟢" };
}

function contactButton(id, p) {
  // Sends an official message AS the bot (Kai) to the user — not a personal
  // DM from the admin's own Telegram account.
  return { text: "💬 פנה למשתמש", callback_data: `contactuser:${id}` };
}

// Delivers an admin message to a user as "הודעה מקאי" and reports back to the
// admin. Returns true on success.
async function sendAsKai(env, target, rawText) {
  const safe = rawText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    await tg(env, "sendMessage", {
      chat_id: target,
      text: `✉️ <b>הודעה מקאי סרף</b>\n\n${safe}`,
      parse_mode: "HTML",
    });
    await logEvent(env, target, "admin_message", { text: rawText });
    const tp = (await getUserPrefs(env, target)) || {};
    tp.reply_to_admin = true;
    await setUserPrefs(env, target, tp);
    const who =
      tp.full_name ||
      [tp.tg_first_name, tp.tg_last_name].filter(Boolean).join(" ") ||
      (tp.username ? `@${tp.username}` : `chat ${target}`);
    await tg(env, "sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `✅ נשלח ל-<b>${who}</b> <code>${target}</code> בשם קאי.`,
      parse_mode: "HTML",
    });
    return true;
  } catch (e) {
    await tg(env, "sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `❌ לא הצלחתי לשלוח למשתמש <code>${target}</code> (ייתכן שחסם את הבוט).`,
      parse_mode: "HTML",
    });
    return false;
  }
}

function userActionKeyboard(id, status, p) {
  if (id === ADMIN_CHAT_ID) return undefined;  // admin has no actions
  const contact = contactButton(id, p);
  if (status === "פעיל") {
    return { inline_keyboard: [
      [contact],
      [{ text: "🔴 הקפא חשבון", callback_data: `udelete:${id}` }],
    ] };
  }
  // frozen
  return { inline_keyboard: [
    [contact],
    [{ text: "🟢 שחזר חשבון", callback_data: `uactivate:${id}` }],
  ] };
}

function renderUserBlock(id, p, status, dot, subscribed, alertCounts, clickCounts) {
  const tgName = p && [p.tg_first_name, p.tg_last_name].filter(Boolean).join(" ");
  const name = (p && p.full_name) || tgName || "(לא הזין שם)";
  const uname = p && p.username ? `@${p.username}` : "(אין שם משתמש)";
  const isAdmin = id === ADMIN_CHAT_ID ? " 👑" : "";
  const lvls = p ? getLevels(p) : [];
  const alertBadge = status === "פעיל" ? (subscribed ? "🔔" : "🔕 השהה התראות") : "";

  // Health: only flag fully-onboarded subscribed users.
  const onboarded = p && p.full_name && p.address && lvls.length && p.direction && p.spots_threshold;
  let health = null;
  if (status === "פעיל" && subscribed && onboarded && alertCounts) {
    if (alertCounts.last7 === 0) {
      health = `⚠ <b>0 התראות ב-7 ימים אחרונים</b> — ההגדרות אולי מצמצמות מדי (סף ${p.spots_threshold}+)`;
    } else if (alertCounts.last7 < 2) {
      health = `🟡 רק ${alertCounts.last7} התראות ב-7 ימים — שווה לשקול להוריד את הסף`;
    }
  }

  const lines = [];
  lines.push(`${dot} <b>${name}</b>${isAdmin} — ${uname}`);
  lines.push(`<code>${id}</code> · <i>${status}</i>${alertBadge ? `  ${alertBadge}` : ""}`);
  if (lvls.length && p.direction) {
    lines.push(`העדפות: ${levelsLabel(lvls)} ${SIDE_HE[p.direction] || p.direction}` +
      (p.spots_threshold ? `  · סף: ${p.spots_threshold}+` : ""));
  }
  if (p && p.address) lines.push(`כתובת: ${p.address}`);
  if (alertCounts) {
    lines.push(`התראות: היום ${alertCounts.today} · 7 ימים ${alertCounts.last7} · סה"כ ${alertCounts.total}`);
  }
  if (clickCounts) {
    lines.push(`קליקים לאתר: היום ${clickCounts.today} · סה"כ ${clickCounts.total}`);
  }
  if (p && p.cmd_count) lines.push(`פקודות: ${p.cmd_count}`);
  if (health) lines.push(health);
  return lines.join("\n");
}

async function renderUserList(env, chatId) {
  const wl = await getWhitelist(env);
  const users = await getUsers(env);
  const known = await getKnownUsers(env);
  // Only surface users who actually finished onboarding (or the admin).
  const candidates = [...new Set([...known, ...wl])];
  const all = [];
  for (const id of candidates) {
    if (id === ADMIN_CHAT_ID) { all.push(id); continue; }
    const p = await getUserPrefs(env, id);
    if (p && p.onboarded) all.push(id);
  }

  let nG = 0, nR = 0, nPaused = 0;
  const items = [];
  let totalAlertsToday = 0, totalClicksToday = 0, totalClicksAll = 0;
  for (const id of all) {
    const p = await getUserPrefs(env, id);
    const { status, dot } = await userStatus(env, id);
    const subscribed = users.includes(id);
    const alertCounts = await getAlertCounts(env, id);
    const clickCounts = await getClickCounts(env, id);
    totalAlertsToday += alertCounts.today;
    totalClicksToday += clickCounts.today;
    totalClicksAll += clickCounts.total;
    if (dot === "🟢") {
      nG++;
      if (!subscribed) nPaused++;
    } else nR++;
    items.push({ id, p, status, dot, subscribed, alertCounts, clickCounts });
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `👥 <b>משתמשים (${all.length})</b> — 🟢 ${nG} · 🔴 ${nR}` +
      (nPaused ? `  ·  🔕 השהה התראות: ${nPaused}` : "") +
      `\n📨 התראות שנשלחו היום: <b>${totalAlertsToday}</b>` +
      `\n🔗 קליקים לאתר: היום <b>${totalClicksToday}</b> · סה"כ <b>${totalClicksAll}</b>`,
    parse_mode: "HTML",
  });
  for (const { id, p, status, dot, subscribed, alertCounts, clickCounts } of items) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: renderUserBlock(id, p, status, dot, subscribed, alertCounts, clickCounts),
      parse_mode: "HTML",
      reply_markup: userActionKeyboard(id, status, p),
    });
  }
}

async function notifyAdminNewUser(env, msg) {
  const from = msg.from || {};
  // Persist Telegram identity so /list shows it from the get-go.
  const prefs = (await getUserPrefs(env, msg.chat.id)) || {};
  if (from.username) prefs.username = from.username;
  if (from.first_name) prefs.tg_first_name = from.first_name;
  if (from.last_name) prefs.tg_last_name = from.last_name;
  await setUserPrefs(env, msg.chat.id, prefs);
  await addKnownUser(env, msg.chat.id);

  const uname = from.username ? `@${from.username}` : "(אין שם משתמש)";
  const name = `${from.first_name || ""} ${from.last_name || ""}`.trim();
  await tg(env, "sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `👋 <b>משתמש חדש נכנס</b>\n` +
      `שם: ${name}\nשם משתמש: ${uname}\nchat_id: <code>${msg.chat.id}</code>\n\n` +
      `אם לא מוכר — אפשר להסיר ב-/list או <code>/revoke ${msg.chat.id}</code>.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "💬 פנה למשתמש", callback_data: `contactuser:${msg.chat.id}` },
        { text: "🚪 הסרה", callback_data: `udelete:${msg.chat.id}` },
      ]],
    },
  });
}

// ---------- Geocoding (Nominatim) ----------
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    query
  )}&format=json&limit=1&accept-language=he&countrycodes=il`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "surf-park-bot/1.0" },
    });
    const data = await res.json();
    if (!data.length) return null;
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      label: data[0].display_name,
    };
  } catch {
    return null;
  }
}

// ---------- Keyboards ----------
// Multi-select keyboard: each tap toggles a level; finish with "סיים".
function waveKeyboard(selected = []) {
  const sel = new Set(selected);
  const btn = (n) => ({
    text: sel.has(n) ? `✓ L${n}` : `L${n}`,
    callback_data: `wave:${n}`,
  });
  return {
    inline_keyboard: [
      WAVE_LEVELS.slice(0, 3).map(btn),
      WAVE_LEVELS.slice(3).map(btn),
      [{ text: "✅ סיים", callback_data: "wavedone" }],
    ],
  };
}

function getLevels(prefs) {
  // Migration: single `level` → treat as one-element list.
  if (Array.isArray(prefs.levels) && prefs.levels.length) return prefs.levels;
  if (prefs.level) return [prefs.level];
  return [];
}

function levelsLabel(levels) {
  return levels.map((n) => `L${n}`).join("+");
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
  const addr = p.address ? `\nכתובת: ${p.address}` : "";
  const lvl = levelsLabel(getLevels(p));
  return `<b>${lvl} ${SIDE_HE[p.direction]}</b>${addr}`;
}

function matchesPrefs(s, prefs) {
  const levels = getLevels(prefs);
  if (!levels.includes(s.level)) return false;
  const a = s.area.toLowerCase();
  if (prefs.direction === "left") return a.includes("left");
  if (prefs.direction === "right") return a.includes("right");
  return true; // both
}

// ---------- Onboarding state ----------
// Stored in prefs.pending = "name" | "address" | "wave" | "direction" | null
async function startOnboarding(env, chatId, existingPrefs = null) {
  const base = existingPrefs || {};
  await setUserPrefs(env, chatId, { ...base, pending: "name" });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "👋 היי, אני <b>קאי</b>!\n\n" +
      "אני שולח התראות לפני סשנים בסרף פארק תל אביב כשנשארו מקומות פנויים.\n\n" +
      "<b>שלב 1/5:</b> מה השם המלא שלך?",
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
}

async function askAddress(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "<b>שלב 2/5:</b> שלח את הכתובת שלך (לחישוב זמן נסיעה).\n" +
      "אפשר גם ללחוץ על 📎 ואז על 'Location' כדי לשלוח את המיקום שלך.",
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [[{ text: "📍 שתף מיקום", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// 7-day picker for /date — skip days that have no future sessions in KV.
async function dateKeyboard(env) {
  const sessions = (await getSessions(env)) || [];
  const nowMs = Date.now();
  // Day keys that have at least one upcoming session with available spots.
  const dayKeysWithFuture = new Set();
  for (const s of sessions) {
    if (s.start <= nowMs || s.spots <= 0) continue;
    const k = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(s.start)).replace(/-/g, "");
    dayKeysWithFuture.add(k);
  }

  const rows = [];
  const now = new Date();
  // Look up to 14 days ahead, but only emit rows for days with sessions, capped at 7.
  for (let i = 0; i < 14 && rows.length < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const ilParts = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(d);
    const day = ilParts.find((p) => p.type === "day").value;
    const month = ilParts.find((p) => p.type === "month").value;
    const year = ilParts.find((p) => p.type === "year").value;
    const wd = ilParts.find((p) => p.type === "weekday").value;
    const key = `${year}${month}${day}`;
    if (!dayKeysWithFuture.has(key)) continue;  // skip empty days
    // i can be > 0 even when "today" was skipped; relabel by date proximity.
    const label = `${wd} ${day}/${month}`;
    rows.push([{ text: label, callback_data: `date:${key}` }]);
  }
  // Fallback: nothing in KV at all → show next 7 days regardless.
  if (!rows.length) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const ilParts = new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
      }).formatToParts(d);
      const day = ilParts.find((p) => p.type === "day").value;
      const month = ilParts.find((p) => p.type === "month").value;
      const year = ilParts.find((p) => p.type === "year").value;
      const wd = ilParts.find((p) => p.type === "weekday").value;
      rows.push([{ text: `${wd} ${day}/${month}`, callback_data: `date:${year}${month}${day}` }]);
    }
  }
  return { inline_keyboard: rows };
}

// Threshold options depend on session capacity: L5/L6 has 15 spots, others 18.
// With multi-select, use the most restrictive (lowest) capacity.
function thresholdKeyboard(levels) {
  const ls = Array.isArray(levels) ? levels : [levels];
  const restrictive = ls.some((l) => l >= 5);
  const opts = restrictive ? [3, 5, 8, 10, 12, 14] : [3, 5, 10, 14, 16, 17];
  return {
    inline_keyboard: [
      opts.slice(0, 3).map((n) => ({ text: `${n}+`, callback_data: `thr:${n}` })),
      opts.slice(3).map((n) => ({ text: `${n}+`, callback_data: `thr:${n}` })),
    ],
  };
}

async function handleAddressInput(env, chatId, prefs, text, location) {
  // Live location is unambiguous — accept directly.
  if (location) {
    prefs.lat = location.latitude;
    prefs.lon = location.longitude;
    prefs.address = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await proceedAfterAddress(env, chatId);
    return;
  }

  // Text address — geocode then ask the user to confirm what we resolved.
  await logEvent(env, chatId, "address_input", { text });
  const g = await geocode(text);
  if (!g) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "לא הצלחתי למצוא את הכתובת הזו.\n" +
        "תנסה שוב עם רחוב + מספר + עיר (למשל \"דיזנגוף 50 תל אביב\"),\n" +
        "או שלח מיקום (📎 → Location).",
    });
    return;
  }

  prefs.pending_lat = g.lat;
  prefs.pending_lon = g.lon;
  prefs.pending_address = g.label;
  prefs.pending_address_input = text;
  prefs.pending = "address_confirm";
  await setUserPrefs(env, chatId, prefs);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `מצאתי:\n📍 <b>${g.label}</b>\n\nזו הכתובת הנכונה?`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ כן, נכון", callback_data: "addrok" },
        { text: "❌ לא, נסה שוב", callback_data: "addrno" },
      ]],
    },
  });
}

async function proceedAfterAddress(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `✓ הכתובת נשמרה.\n\n<b>שלב 3/5:</b> בחר רמות גל (ניתן לבחור כמה):`,
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "בחר רמות גל:",
    reply_markup: waveKeyboard(),
  });
}

async function handleNameInput(env, chatId, prefs, text) {
  const name = text.trim();
  if (name.length < 2 || name.length > 60) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "השם נראה לא תקין. תכתוב שם פרטי + משפחה (2–60 תווים).",
    });
    return;
  }
  prefs.full_name = name;
  prefs.pending = "address";
  await setUserPrefs(env, chatId, prefs);
  await askAddress(env, chatId);
}

// ---------- Commands ----------
async function handleSharedFollow(env, chatId, from, sessionId) {
  // Friend opened /start follow_<sessionId> from a shared link.
  // Persist Telegram identity (in case they later finish onboarding).
  const prefs = (await getUserPrefs(env, chatId)) || {};
  if (from) {
    if (from.username) prefs.username = from.username;
    if (from.first_name) prefs.tg_first_name = from.first_name;
    if (from.last_name) prefs.tg_last_name = from.last_name;
    await setUserPrefs(env, chatId, prefs);
  }
  if (!(await isApproved(env, chatId))) await approveUser(env, chatId);

  // Show a preview of the session so the friend knows what they're joining.
  const sessions = await getSessions(env);
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "👋 חבר שלך הזמין אותך לעקוב אחרי סשן בסרף פארק, אבל הוא כבר לא במאגר העדכני. שלח /start כדי להמשיך רגיל.",
    });
    return;
  }
  const time = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
  }).format(new Date(s.start));
  const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `👋 היי, אני <b>קאי</b>\n\n` +
      `חבר שיתף איתך סשן:\n` +
      `🌊 <b>${time} · L${s.level} ${side}</b>\n` +
      `${displayTitle(s.title)} · נותרו ${s.spots} מקומות\n\n` +
      `רוצה שאודיע לך גם ברגע שיתפנה מקום?`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[
      { text: "✅ כן, תעקוב גם אצלי", callback_data: `huntsess:${sessionId}` },
      { text: "❌ לא, רק להתחיל", callback_data: `nofollow` },
    ]] },
  });
}

async function cmdStart(env, chatId, from) {
  const prefs = (await getUserPrefs(env, chatId)) || {};
  if (from) {
    prefs.username = from.username || prefs.username;
    await setUserPrefs(env, chatId, prefs);
  }

  // If everything's already set, skip onboarding and just say hi.
  const lvls = getLevels(prefs);
  const complete =
    prefs.full_name &&
    prefs.address &&
    lvls.length &&
    prefs.direction &&
    prefs.spots_threshold;
  if (complete) {
    await addUser(env, chatId);
    await setUserMenu(env, chatId, false);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👋 <b>ברוך השב!</b>\n\n` +
        `<b>שם:</b> ${prefs.full_name}\n` +
        `<b>כתובת:</b> ${prefs.address}\n` +
        `<b>העדפות:</b> ${levelsLabel(lvls)} ${SIDE_HE[prefs.direction]}\n` +
        `<b>סף התראה:</b> מעל ${prefs.spots_threshold} מקומות פנויים\n\n` +
        `<i>/reset לשינוי הגדרות</i>`,
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  // Resume from the first missing step.
  if (!prefs.full_name) {
    await startOnboarding(env, chatId, prefs);
  } else if (!prefs.address) {
    prefs.pending = "address";
    await setUserPrefs(env, chatId, prefs);
    await askAddress(env, chatId);
  } else if (!lvls.length) {
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `<b>שלב 3/5:</b> בחר רמות גל (ניתן לבחור כמה):`,
      parse_mode: "HTML",
      reply_markup: waveKeyboard(),
    });
  } else if (!prefs.direction) {
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `רמות: <b>${levelsLabel(lvls)}</b>\n<b>שלב 4/5:</b> בחר כיוון:`,
      parse_mode: "HTML",
      reply_markup: dirKeyboard(0),
    });
  } else if (!prefs.spots_threshold) {
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `<b>שלב 5/5:</b> מינימום מקומות פנויים להתראה?`,
      parse_mode: "HTML",
      reply_markup: thresholdKeyboard(lvls),
    });
  }
}

async function cmdReset(env, chatId) {
  // /reset clears only the surf preferences (levels, direction, threshold);
  // personal data (name, address, lat/lon) stays untouched.
  const prefs = (await getUserPrefs(env, chatId)) || {};
  delete prefs.levels;
  delete prefs.level;
  delete prefs.direction;
  delete prefs.spots_threshold;
  prefs.pending = null;
  await setUserPrefs(env, chatId, prefs);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔄 <b>איפוס העדפות</b>\nבחר רמות גל (ניתן לבחור כמה):",
    parse_mode: "HTML",
    reply_markup: waveKeyboard(),
  });
}

function huntKeyboardForPrefs(prefs, dayKey = null) {
  const lvls = getLevels(prefs);
  // Encode level=any for multi-pref, otherwise the single level.
  const lvl = lvls.length === 1 ? lvls[0] : 0;
  const dir = prefs.direction || "left";
  const day = dayKey || "any";
  return { inline_keyboard: [[
    { text: "🔔 התראה כשמתפנה", callback_data: `hunt:${lvl}:${dir}:${day}` },
  ]] };
}

async function cmdShare(env, chatId) {
  const botLink = "https://t.me/SurfParkBot";
  const text = "🤙 מצאתי בוט מעולה שמודיע על סשנים פנויים בסרף פארק ת\"א לפי הרמה והשעות שלך. שווה:";
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(text)}`;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "📣 אהבת? שתף עם חברים שגולשים — ככה כולם מקבלים התראות וגולשים יחד.",
    reply_markup: { inline_keyboard: [[
      { text: "👥 שתף את הבוט", url: shareUrl },
    ]] },
  });
}

async function cmdFeedback(env, chatId) {
  const prefs = (await getUserPrefs(env, chatId)) || {};
  prefs.pending = "feedback";
  await setUserPrefs(env, chatId, prefs);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "💬 <b>שליחת פידבק</b>\n" +
      "תכתוב כאן את ההודעה שלך — באג, רעיון, בקשה או מה שתרצה.\n" +
      "(לביטול: /start)",
    parse_mode: "HTML",
  });
}

async function handleFeedbackInput(env, chatId, prefs, text) {
  await saveFeedback(env, chatId, text);
  prefs.pending = null;
  await setUserPrefs(env, chatId, prefs);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "✅ תודה! הפידבק נשלח. נחזור אליך אם יהיה צורך.",
  });
  // Notify admin with a quick reply button.
  const tgName = [prefs.tg_first_name, prefs.tg_last_name].filter(Boolean).join(" ");
  const name = prefs.full_name || tgName || "(לא ידוע)";
  const uname = prefs.username ? `@${prefs.username}` : "(אין שם משתמש)";
  await tg(env, "sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `💬 <b>פידבק חדש</b>\n` +
      `מאת: ${name} — ${uname}\n` +
      `<code>${chatId}</code>\n\n` +
      `${text}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[
      { text: "💬 פנה למשתמש", callback_data: `contactuser:${chatId}` },
    ]] },
  });
}

async function cmdAlerts(env, chatId) {
  const rows = await listUserAlerts(env, chatId);
  if (!rows.length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "אין לך מעקבים פעילים.\n" +
        "ב-/today או /date לחץ על 🔔 ליד סשן כדי לעקוב אחריו.",
    });
    return;
  }
  // Enrich session-specific alerts with session details from KV.
  const sessions = await getSessions(env);
  const sMap = Object.fromEntries(sessions.map((s) => [s.id, s]));

  const lines = ["🔔 <b>סשנים שאתה עוקב אחריהם</b>", ""];
  const buttons = [];
  for (const a of rows) {
    let label;
    if (a.session_id && sMap[a.session_id]) {
      const s = sMap[a.session_id];
      const time = new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit",
        day: "2-digit", month: "2-digit",
      }).format(new Date(s.start));
      const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
      label = `${time} · L${s.level} ${side} · ${displayTitle(s.title)} · נותרו ${s.spots}`;
    } else if (a.session_id) {
      label = `סשן #${a.session_id} (לא במאגר העדכני)`;
    } else {
      // Generic level/direction/date alert (legacy / from "no results" flow)
      const lvl = a.level ? `L${a.level}` : "כל הרמות";
      const side = a.direction === "left" ? "שמאל" : a.direction === "right" ? "ימין" : "שניהם";
      const date = a.target_date || "כל יום";
      label = `${lvl} ${side} · ${date}`;
    }
    lines.push(`#${a.id} · ${label}`);
    buttons.push([{ text: `❌ בטל #${a.id}`, callback_data: `cancelalert:${a.id}` }]);
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

// Per-chat command menus — surface /resume when the user paused, /stop when active.
const CMDS_ACTIVE = [
  { command: "today", description: "סשנים שלי היום" },
  { command: "date", description: "בחירת סשן להרשמה" },
  { command: "feedback", description: "שליחת פידבק / באג / רעיון" },
  { command: "share", description: "שיתוף הבוט עם חברים" },
  { command: "reset", description: "שינוי רמת גל וכיוון" },
  { command: "stop", description: "השהה התראות" },
];
const CMDS_PAUSED = [
  { command: "resume", description: "חידוש התראות" },
  { command: "today", description: "סשנים שלי היום" },
  { command: "date", description: "בחירת סשן להרשמה" },
  { command: "feedback", description: "שליחת פידבק / באג / רעיון" },
  { command: "share", description: "שיתוף הבוט עם חברים" },
  { command: "reset", description: "שינוי רמת גל וכיוון" },
];

const ADMIN_TOOLS = [
  { command: "list", description: "[אדמין] רשימת משתמשים" },
  { command: "events", description: "[אדמין] אירועי משתמש" },
  { command: "export", description: "[אדמין] סיכום אירועים" },
  { command: "approve", description: "[אדמין] אישור chat_id" },
  { command: "revoke", description: "[אדמין] הסרת גישה chat_id" },
];

async function setUserMenu(env, chatId, paused) {
  const base = paused ? CMDS_PAUSED : CMDS_ACTIVE;
  const list = chatId === ADMIN_CHAT_ID ? base.concat(ADMIN_TOOLS) : base;
  await tg(env, "setMyCommands", {
    commands: list,
    scope: { type: "chat", chat_id: chatId },
  });
}

async function cmdStop(env, chatId) {
  await unsubscribeUser(env, chatId);
  await setUserMenu(env, chatId, true);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "⏸ ההתראות הושהו.\n" +
      "ההגדרות שלך נשמרו — שלח /resume לחדש.",
  });
}

async function cmdResume(env, chatId) {
  const prefs = (await getUserPrefs(env, chatId)) || {};
  const lvls = getLevels(prefs);
  if (!prefs.full_name || !prefs.address || !lvls.length || !prefs.direction || !prefs.spots_threshold) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "צריך להשלים הרשמה קודם — שלח /start.",
    });
    return;
  }
  await addUser(env, chatId);
  await setUserMenu(env, chatId, false);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `▶️ ההתראות חודשו.\n\n` +
      `<b>שם:</b> ${prefs.full_name}\n` +
      `<b>כתובת:</b> ${prefs.address}\n` +
      `<b>העדפות:</b> ${levelsLabel(lvls)} ${SIDE_HE[prefs.direction]}\n` +
      `<b>סף:</b> מעל ${prefs.spots_threshold} מקומות`,
    parse_mode: "HTML",
  });
}


async function cmdDate(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "בחר תאריך:",
    reply_markup: await dateKeyboard(env),
  });
}

async function showSessionsForDate(env, chatId, dayKey) {
  const prefs = await getUserPrefs(env, chatId);
  if (!prefs || !getLevels(prefs).length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "צריך להגדיר קודם — שלח /start.",
    });
    return;
  }
  const sessions = await getSessions(env);
  const nowMs = Date.now();
  // dayKey is "YYYYMMDD"; compare against sessionDayKey output which is "DD.MM.YYYY".
  const wantedDay = `${dayKey.slice(6, 8)}.${dayKey.slice(4, 6)}.${dayKey.slice(0, 4)}`;
  const matching = sessions.filter(
    (s) =>
      matchesPrefs(s, prefs) &&
      s.start > nowMs &&
      sessionDayKey(s) === wantedDay
  );
  const bookable = matching.filter((s) => s.spots > 0);
  await logEvent(env, chatId, "result", { cmd: "/date", date: wantedDay, matched: matching.length, available: bookable.length });
  await logSearchD1(env, chatId, "/date", getLevels(prefs), prefs.direction, dayKey, matching.length, bookable.length);
  const header = `📋 <b>${wantedDay} (${levelsLabel(getLevels(prefs))} ${SIDE_HE[prefs.direction]})</b>\n`;
  if (!bookable.length) {
    const body = matching.length
      ? "כל הסשנים המתאימים מלאים."
      : "אין סשנים מתאימים בתאריך הזה.";
    return { header, body, sessions: [] };
  }
  const body = bookable.map((s) => fmtSession(s)).join("\n");
  return { header, body, sessions: bookable };
}

// One inline-keyboard button per session — opens the tracked registration link.
async function sessionsKeyboard(env, chatId, sessions, workerOrigin, prefs = {}) {
  // Each session = one full-width register button. Follow is inside the Mini App.
  const token = await ensureClickToken(env, chatId);
  const limited = sessions.slice(0, 25);

  const rows = [];
  for (const s of limited) {
    const time = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit",
    }).format(new Date(s.start));
    const isLeft = s.area.toLowerCase().includes("left");
    const lvlCode = `${isLeft ? "L" : "R"}${s.level}`;
    // Plain Telegram link → /r/ → 302 to the SRF deep-link (sid+from_date).
    // `k` is a stable key (start.level.side); /r/ resolves it to the freshest
    // SRF id from KV at click-time, since SRF rotates session ids over time.
    const sKey = `${s.start}.${s.level}.${isLeft ? "L" : "R"}`;
    const registerUrl = `${workerOrigin}/r/${s.id}?u=${token}&lead=manual&k=${encodeURIComponent(sKey)}`;
    const registerLabel = `📝 ${time} · ${lvlCode} · ${waveCode(s.title)} · פנוי ${boldNum(s.spots)}`;
    rows.push([{ text: registerLabel, url: registerUrl }]);
  }
  return { inline_keyboard: rows };
}

// Time-only row (date is shown in the header).
function fmtSession(s) {
  const time = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(s.start));
  const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
  return `• ${time} L${s.level} ${side} — ${displayTitle(s.title)} — נותרו ${s.spots} מקומות`;
}

function todayKeyIL() {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sessionDayKey(s) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(s.start));
}

async function cmdToday(env, chatId) {
  const prefs = await getUserPrefs(env, chatId);
  if (!prefs || !getLevels(prefs).length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "צריך להגדיר קודם — שלח /start.",
    });
    return;
  }
  const sessions = await getSessions(env);
  const today = todayKeyIL();
  const nowMs = Date.now();
  const matching = sessions.filter(
    (s) =>
      matchesPrefs(s, prefs) &&
      s.start > nowMs &&
      sessionDayKey(s) === today
  );
  const bookable = matching.filter((s) => s.spots > 0);
  await logEvent(env, chatId, "result", { cmd: "/today", matched: matching.length, available: bookable.length });
  await logSearchD1(env, chatId, "/today", getLevels(prefs), prefs.direction, null, matching.length, bookable.length);
  const header = `📋 <b>סטטוס היום (${levelsLabel(getLevels(prefs))} ${SIDE_HE[prefs.direction]})</b>\n`;
  const payload = bookable.length
    ? {
        text: header + "🤙 איזה גל בא לך לתפוס?",
        reply_markup: await sessionsKeyboard(env, chatId, bookable, WORKER_ORIGIN, prefs),
      }
    : {
        text: header + "אין סשנים זמינים להזמנה היום.\n🌊 הים לא מחכה — תתן לי לנפנף לך כשיתפנה מקום?",
        reply_markup: huntKeyboardForPrefs(prefs, null),
      };
  // Repeated /today: drop the previous (now-stale) message instead of stacking
  // duplicates, then send a fresh one at the bottom of the chat.
  if (prefs.today_msg_id) {
    try {
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: prefs.today_msg_id });
    } catch (e) {}
  }
  const sent = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: payload.text,
    parse_mode: "HTML",
    reply_markup: payload.reply_markup,
  });
  const mid = sent && sent.result && sent.result.message_id;
  const fresh = (await getUserPrefs(env, chatId)) || {};
  fresh.today_msg_id = mid || null;
  await setUserPrefs(env, chatId, fresh);
}

async function cmdAll(env, chatId) {
  const sessions = await getSessions(env);
  const today = todayKeyIL();
  const nowMs = Date.now();
  const todays = sessions.filter(
    (s) => s.start > nowMs && sessionDayKey(s) === today
  );
  const bookable = todays.filter((s) => s.spots > 0);
  await logEvent(env, chatId, "result", { cmd: "/all", matched: todays.length, available: bookable.length });
  await logSearchD1(env, chatId, "/all", null, null, null, todays.length, bookable.length);
  if (!bookable.length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: todays.length ? "כל הסשנים היום מלאים." : "אין סשנים שנותרו היום.",
    });
    return;
  }
  const lines = ["📋 <b>סשנים זמינים להזמנה היום</b>"];
  for (const s of bookable) {
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
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data || "";

    if (data === "nofollow") {
      await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      await tg(env, "sendMessage", { chat_id: chatId, text: "סבבה. שלח /start כדי להתחיל הרשמה רגילה." });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // Per-session follow: 🔔 button on each session row.
    if (data.startsWith("huntsess:")) {
      const sessionId = data.split(":")[1];
      const existing = await d1First(env,
        `SELECT a.id FROM alerts a JOIN users u ON a.user_id = u.id
         WHERE u.telegram_id = ? AND a.session_id = ? AND a.is_active = 1`,
        [chatId, sessionId]);
      if (!existing) {
        await addHuntAlert(env, chatId, null, null, null, null, sessionId);
      }
      // Build a friendly share message + viral deep-link.
      const sessions = await getSessions(env);
      const s = sessions.find((x) => x.id === sessionId);
      const time = s ? new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
      }).format(new Date(s.start)) : "";
      const title = s ? displayTitle(s.title) : "סשן";
      const side = s ? (s.area.toLowerCase().includes("left") ? "שמאל" : "ימין") : "";
      const lvl = s ? `L${s.level}` : "";
      const shareText = `🤙 אני עוקב אחרי סשן ${time} ${lvl} ${side} ב-${title} בסרף פארק.\nגם אתה? תלחץ על הקישור והבוט יוסיף אותך לתור.`;
      const botLink = `https://t.me/SurfParkBot?start=follow_${sessionId}`;
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(shareText)}`;
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: existing
          ? "כבר עוקב 🔔. רוצה לצרף חבר?"
          : "🔔 נרשם — תקבל הודעה כשיתפנה מקום.\nרוצה לצרף חבר שיעקוב יחד?",
        reply_markup: { inline_keyboard: [[
          { text: "👥 שתף עם חבר", url: shareUrl },
        ]] },
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // Hunt alert: register a "notify when free" request.
    if (data.startsWith("hunt:")) {
      const [, lvlStr, dir, day] = data.split(":");
      const level = parseInt(lvlStr, 10) || null;
      const target_date = day === "any" ? null : `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      await addHuntAlert(env, chatId, level, dir, target_date, null, null);
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "נרשם!" });
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🔔 ההתראה נרשמה. ברגע שיתפנה מקום מתאים — אעדכן.",
      });
      return;
    }

    if (data.startsWith("cancelalert:")) {
      const aid = parseInt(data.split(":")[1], 10);
      await cancelAlert(env, chatId, aid);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: cb.message.text + `\n\n❌ #${aid} בוטלה.`,
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // Registration self-report from the follow-up survey.
    if (data.startsWith("reg:")) {
      const [, answer, sessionId] = data.split(":");
      await logEvent(env, chatId, "registration_report", { session_id: sessionId, registered: answer === "yes" });
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: answer === "yes"
          ? "🙌 מעולה — תודה על העדכון! נמשיך לשלוח לך התראות."
          : "תודה על העדכון. אם משהו לא טוב — /reset לעדכן הגדרות.",
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // Admin → official outreach to a user, sent AS the bot (Kai).
    if (data.startsWith("contactuser:")) {
      if (chatId !== ADMIN_CHAT_ID) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "אין הרשאה" });
        return;
      }
      const target = parseInt(data.split(":")[1], 10);
      const ap = (await getUserPrefs(env, ADMIN_CHAT_ID)) || {};
      ap.pending = `contact:${target}`;
      await setUserPrefs(env, ADMIN_CHAT_ID, ap);
      await tg(env, "sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text:
          `✍️ כתוב את ההודעה שתישלח למשתמש <code>${target}</code> בשם <b>קאי</b>.\n` +
          `המשתמש יראה אותה כפנייה רשמית מהבוט.\n` +
          `(לביטול: /start)`,
        parse_mode: "HTML",
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // Admin-only user action buttons from /list rendered cards.
    if (data.startsWith("uapprove:") || data.startsWith("udeny:") ||
        data.startsWith("ufreeze:") || data.startsWith("uactivate:") ||
        data.startsWith("udelete:")) {
      if (chatId !== ADMIN_CHAT_ID) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "אין הרשאה" });
        return;
      }
      const [action, idStr] = data.split(":");
      const target = parseInt(idStr, 10);
      let toastMsg = "";
      if (action === "uapprove") {
        await approveUser(env, target);
        toastMsg = "אושר";
        try { await tg(env, "sendMessage", { chat_id: target, text: "✅ אושרת לגישה לבוט. שלח /start כדי להתחיל." }); } catch (e) {}
      } else if (action === "udeny") {
        await env.KV.delete(userKey(target));
        await env.KV.put("known_users", JSON.stringify((await getKnownUsers(env)).filter((x) => x !== target)));
        toastMsg = "נדחה";
      } else if (action === "ufreeze") {
        await unsubscribeUser(env, target);
        toastMsg = "הוקפא";
      } else if (action === "uactivate") {
        // "שחזר חשבון" — add back to whitelist (admin-controlled).
        await approveUser(env, target);
        toastMsg = "החשבון שוחזר";
      } else if (action === "udelete") {
        // "הקפא חשבון" — remove from whitelist + unsubscribe + drop prefs.
        await deleteUser(env, target);
        await env.KV.put("whitelist", JSON.stringify((await getWhitelist(env)).filter((x) => x !== target)));
        toastMsg = "החשבון הוקפא";
      }
      // For deny → drop card; udelete keeps card with re-activate button.
      if (action === "udeny") {
        await tg(env, "deleteMessage", { chat_id: chatId, message_id: msgId });
      } else {
        const p = await getUserPrefs(env, target);
        const { status, dot } = await userStatus(env, target);
        const subscribed = (await getUsers(env)).includes(target);
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: renderUserBlock(target, p, status, dot, subscribed),
          parse_mode: "HTML",
          reply_markup: userActionKeyboard(target, status, p),
        });
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: toastMsg });
      return;
    }

    // Original approval flow from access-request notification.
    if (data.startsWith("approve:") || data.startsWith("deny:")) {
      if (chatId !== ADMIN_CHAT_ID) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "אין הרשאה",
        });
        return;
      }
      const targetId = parseInt(data.split(":")[1], 10);
      if (data.startsWith("approve:")) {
        await approveUser(env, targetId);
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: cb.message.text + `\n\n✅ אושר.`,
        });
        await tg(env, "sendMessage", {
          chat_id: targetId,
          text: "✅ אושרת לגישה לבוט. שלח /start כדי להתחיל.",
        });
      } else {
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: cb.message.text + `\n\n❌ נדחה.`,
        });
        await tg(env, "sendMessage", {
          chat_id: targetId,
          text: "בקשתך לגישה נדחתה.",
        });
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (!(await isApproved(env, chatId))) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "אין הרשאה",
      });
      return;
    }

    if (data.startsWith("date:") || data.startsWith("wave:") || data === "wavedone" ||
        data.startsWith("dir:") || data.startsWith("thr:") ||
        data === "addrok" || data === "addrno") {
      await logEvent(env, chatId, "callback", { data });
    }

    if (data === "addrok" || data === "addrno") {
      const prefs = (await getUserPrefs(env, chatId)) || {};
      if (data === "addrok") {
        prefs.lat = prefs.pending_lat;
        prefs.lon = prefs.pending_lon;
        // Show what the user typed; fall back to geocoded label.
        prefs.address = prefs.pending_address_input || prefs.pending_address;
        delete prefs.pending_lat;
        delete prefs.pending_lon;
        delete prefs.pending_address;
        delete prefs.pending_address_input;
        prefs.pending = null;
        await setUserPrefs(env, chatId, prefs);
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: `📍 <b>${prefs.address}</b>\n✓ נשמר.`,
          parse_mode: "HTML",
        });
        await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
        await proceedAfterAddress(env, chatId);
      } else {
        delete prefs.pending_lat;
        delete prefs.pending_lon;
        delete prefs.pending_address;
        delete prefs.pending_address_input;
        prefs.pending = "address";
        await setUserPrefs(env, chatId, prefs);
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: "אין בעיה. שלח שוב את הכתובת — מומלץ להוסיף עיר (\"רחוב מספר עיר\").",
        });
        await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      }
      return;
    }

    if (data.startsWith("date:")) {
      const dayKey = data.slice(5);
      const result = await showSessionsForDate(env, chatId, dayKey);
      if (result) {
        const origin = WORKER_ORIGIN;
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: result.header + result.body,
          parse_mode: "HTML",
          reply_markup: await dateKeyboard(env),
        });
        const prefs = await getUserPrefs(env, chatId);
        // Header that disambiguates this message when the user clicks several dates.
        const wantedDay = `${dayKey.slice(6, 8)}/${dayKey.slice(4, 6)}/${dayKey.slice(0, 4)}`;
        // Day-of-week name for the picked date (Asia/Jerusalem).
        const wd = new Intl.DateTimeFormat("he-IL", {
          timeZone: "Asia/Jerusalem", weekday: "long",
        }).format(new Date(
          Number(dayKey.slice(0, 4)),
          Number(dayKey.slice(4, 6)) - 1,
          Number(dayKey.slice(6, 8)),
          12, 0, 0
        ));
        // 🗓️ is a generic calendar glyph (no baked-in date number, unlike 📅).
        const dateLine = `🗓️ <b>${wd}, ${wantedDay}</b>`;
        if (result.sessions && result.sessions.length) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: `${dateLine}\n🤙 איזה גל בא לך לתפוס?`,
            parse_mode: "HTML",
            reply_markup: await sessionsKeyboard(env, chatId, result.sessions, origin, prefs),
          });
        } else {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: `${dateLine}\n🌊 הים לא מחכה — תתן לי לנפנף לך כשיתפנה מקום?`,
            parse_mode: "HTML",
            reply_markup: huntKeyboardForPrefs(prefs, dayKey),
          });
        }
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (data.startsWith("wave:")) {
      const level = parseInt(data.slice(5), 10);
      const prefs = (await getUserPrefs(env, chatId)) || {};
      const cur = new Set(getLevels(prefs));
      if (cur.has(level)) cur.delete(level);
      else cur.add(level);
      prefs.levels = [...cur].sort((a, b) => a - b);
      delete prefs.level;  // drop legacy field
      await setUserPrefs(env, chatId, prefs);
      await tg(env, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: waveKeyboard(prefs.levels),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    } else if (data === "wavedone") {
      const prefs = (await getUserPrefs(env, chatId)) || {};
      const lvls = getLevels(prefs);
      if (!lvls.length) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "צריך לבחור לפחות רמה אחת",
          show_alert: true,
        });
        return;
      }
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `רמות: <b>${levelsLabel(lvls)}</b>\n<b>שלב 4/5:</b> בחר כיוון:`,
        parse_mode: "HTML",
        reply_markup: dirKeyboard(0),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    } else if (data.startsWith("dir:")) {
      const dir = data.split(":")[2];
      const prefs = (await getUserPrefs(env, chatId)) || {};
      prefs.direction = dir;
      await setUserPrefs(env, chatId, prefs);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `כיוון: <b>${SIDE_HE[dir]}</b>\n<b>שלב 5/5:</b> מינימום מקומות פנויים להתראה?`,
        parse_mode: "HTML",
        reply_markup: thresholdKeyboard(getLevels(prefs)),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    } else if (data.startsWith("thr:")) {
      const threshold = parseInt(data.slice(4), 10);
      const prefs = (await getUserPrefs(env, chatId)) || {};
      prefs.spots_threshold = threshold;
      prefs.pending = null;
      const firstCompletion = !prefs.onboarded;
      prefs.onboarded = true;
      await setUserPrefs(env, chatId, prefs);
      await addUser(env, chatId);
      await setUserMenu(env, chatId, false);
      await addKnownUser(env, chatId);
      if (firstCompletion && chatId !== ADMIN_CHAT_ID) {
        try {
          // Name itself becomes a tappable mention via tg://user?id=, so even
          // users without a public @username are reachable in one tap.
          const displayName = prefs.full_name || "משתמש";
          const nameLink = `<a href="tg://user?id=${chatId}">${displayName}</a>`;
          const unameLine = prefs.username
            ? `@${prefs.username}`
            : `<i>(אין @username — לחץ על השם לפתיחת צ'אט)</i>`;
          await tg(env, "sendMessage", {
            chat_id: ADMIN_CHAT_ID,
            text:
              `👋 <b>משתמש חדש סיים הרשמה</b>\n` +
              `שם: ${nameLink}\n` +
              `שם משתמש: ${unameLine}\n` +
              `כתובת: ${prefs.address || "(?)"}\n` +
              `העדפות: ${describePrefs(prefs)} · סף ${threshold}+\n` +
              `<code>${chatId}</code>`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "💬 פנה למשתמש", callback_data: `contactuser:${chatId}` },
              { text: "🚪 הסרה", callback_data: `udelete:${chatId}` },
            ]] },
          });
        } catch (e) { console.error("admin notify failed:", e); }
      }
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text:
          `✅ <b>סיימנו!</b>\n\n` +
          `${describePrefs(prefs)}\n` +
          `סף התראה: <b>מעל ${threshold} מקומות פנויים</b>\n\n` +
          `אקבל התראות 1:45 ו-1:15 לפני סשנים מתאימים.`,
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

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Refresh Telegram identity on every message — usernames may be set later.
  if (msg.from && (msg.from.username || msg.from.first_name)) {
    const cur = (await getUserPrefs(env, chatId)) || {};
    let changed = false;
    if (msg.from.username && cur.username !== msg.from.username) {
      cur.username = msg.from.username; changed = true;
    }
    if (msg.from.first_name && cur.tg_first_name !== msg.from.first_name) {
      cur.tg_first_name = msg.from.first_name; changed = true;
    }
    if (msg.from.last_name && cur.tg_last_name !== msg.from.last_name) {
      cur.tg_last_name = msg.from.last_name; changed = true;
    }
    if (changed) await setUserPrefs(env, chatId, cur);
  }

  // Admin-only commands
  if (chatId === ADMIN_CHAT_ID && text.startsWith("/")) {
    const parts = text.split(/\s+/);
    if (parts[0] === "/list") {
      await renderUserList(env, chatId);
      return;
    }
    if (parts[0] === "/report") {
      const days = parts[1] && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 7;
      const since = `datetime('now','-${days} days')`;
      const q = async (sql) => (await d1First(env, sql)) || {};

      const searches = await q(
        `SELECT COUNT(*) AS c, SUM(CASE WHEN is_available=0 THEN 1 ELSE 0 END) AS misses,
                SUM(CASE WHEN is_available=0 AND matched_count>0 THEN 1 ELSE 0 END) AS full_misses
         FROM search_logs WHERE search_timestamp >= ${since}`);
      const topMiss = await d1Run(env,
        `SELECT requested_levels, requested_direction, COUNT(*) AS n
         FROM search_logs
         WHERE is_available=0 AND search_timestamp >= ${since}
         GROUP BY requested_levels, requested_direction
         ORDER BY n DESC LIMIT 5`);
      const alertsCnt = await q(
        `SELECT COUNT(*) AS c FROM alerts_sent WHERE sent_at >= ${since}`);
      const reg = await q(
        `SELECT
           SUM(CASE WHEN kind='followup' THEN 1 ELSE 0 END) AS surveys
         FROM alerts_sent WHERE sent_at >= ${since}`);
      // Conversion from event log (clicks + registration_report) across users.
      const known = [...new Set([...(await getKnownUsers(env)), ...(await getWhitelist(env))])];
      let clicks = 0, regYes = 0, regNo = 0;
      const cutoff = Date.now() - days * 86400000;
      for (const id of known) {
        for (const e of await getEvents(env, id)) {
          if (new Date(e.ts).getTime() < cutoff) continue;
          if (e.action === "click") clicks++;
          if (e.action === "registration_report") (e.registered ? regYes++ : regNo++);
        }
      }
      const conv = clicks ? Math.round((regYes / clicks) * 100) : 0;
      const lines = [
        `📊 <b>דוח ${days} ימים אחרונים</b>`,
        ``,
        `🔍 חיפושים: <b>${searches.c || 0}</b>`,
        `❌ ללא מענה (Shadow Demand): <b>${searches.misses || 0}</b>`,
        `   מתוכם "סשן קיים אך מלא": <b>${searches.full_misses || 0}</b>`,
        ``,
        `🔝 <b>הביקוש הכי לא-מסופק:</b>`,
      ];
      for (const r of (topMiss.results || [])) {
        let lv = r.requested_levels;
        try { lv = JSON.parse(lv).map((x) => "L" + x).join("+"); } catch {}
        const sd = r.requested_direction === "left" ? "שמאל" : r.requested_direction === "right" ? "ימין" : (r.requested_direction || "");
        lines.push(`   ${lv || "?"} ${sd} — ${r.n} פעמים`);
      }
      lines.push(
        ``,
        `📨 התראות שנשלחו: <b>${alertsCnt.c || 0}</b>`,
        `🔗 קליקים לאתר: <b>${clicks}</b>`,
        `✅ אישרו הרשמה: <b>${regYes}</b> · ❌ לא: <b>${regNo}</b>`,
        `📈 <b>שיעור המרה: ${conv}%</b> (קליק → הרשמה מאומתת)`,
      );
      await tg(env, "sendMessage", {
        chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML",
      });
      return;
    }
    if (parts[0] === "/events") {
      const target = parts[1] ? parseInt(parts[1], 10) : NaN;
      if (!Number.isFinite(target)) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "שימוש: <code>/events &lt;chat_id&gt;</code>\nראה chat_id ב-/list.",
          parse_mode: "HTML",
        });
        return;
      }
      const events = await getEvents(env, target);
      if (!events.length) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `📜 אין אירועים עבור ${target}.`,
        });
        return;
      }
      const last = events.slice(-30).reverse();
      const lines = [`📜 <b>אירועים אחרונים — ${target}</b> (סה"כ ${events.length})`, ""];
      for (const e of last) {
        const t = new Date(e.ts).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
        const detail = e.cmd || e.data || e.text || (e.matched != null ? `matched=${e.matched}` : "");
        lines.push(`<code>${t}</code> · ${e.action}${detail ? ` · ${detail}` : ""}`);
      }
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: lines.join("\n").slice(0, 4090),
        parse_mode: "HTML",
      });
      return;
    }
    if (parts[0] === "/export") {
      // Send the user a compact summary; the full JSON is at /events?key=...
      const known = await getKnownUsers(env);
      const wl = await getWhitelist(env);
      const all = [...new Set([...known, ...wl])];
      const totals = {};
      for (const id of all) {
        totals[id] = (await getEvents(env, id)).length;
      }
      const total = Object.values(totals).reduce((a, b) => a + b, 0);
      const lines = [`📦 <b>סיכום אירועים</b> (סה"כ ${total})`, ""];
      for (const id of all) {
        if (totals[id]) lines.push(`<code>${id}</code>: ${totals[id]} אירועים`);
      }
      const key = env.PUSH_SECRET ? encodeURIComponent(env.PUSH_SECRET) : "";
      lines.push("", `הורדה מלאה: ${WORKER_ORIGIN}/events?key=${key}`);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }
    if (parts[0] === "/revoke") {
      const target = parts[1] ? parseInt(parts[1], 10) : NaN;
      if (!Number.isFinite(target)) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text:
            "שימוש: <code>/revoke &lt;chat_id&gt;</code>\n" +
            "לדוגמה: <code>/revoke 481683634</code>\n" +
            "אפשר גם להשתמש בכפתור 🗑 בתוך /list.",
          parse_mode: "HTML",
        });
        return;
      }
      await revokeUser(env, target);
      // Also drop from known_users so the user disappears from /list completely.
      await env.KV.put("known_users", JSON.stringify((await getKnownUsers(env)).filter((x) => x !== target)));
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `🚪 גישה הוסרה למשתמש ${target}.`,
      });
      return;
    }
    if (parts[0] === "/approve" && parts[1]) {
      const target = parseInt(parts[1], 10);
      await approveUser(env, target);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ אושר ${target}.`,
      });
      await tg(env, "sendMessage", {
        chat_id: target,
        text: "✅ אושרת לגישה לבוט. שלח /start כדי להתחיל.",
      });
      return;
    }
  }

  // Auto-approve every new chat so they can run /start. Admin notification
  // and inclusion in /list happen ONLY once they finish onboarding (see the
  // threshold-selection callback). Until then the user is invisible in stats.
  if (!(await isApproved(env, chatId))) {
    await approveUser(env, chatId);
  }

  // Mid-onboarding handlers — accept free-text input depending on stage.
  const prefs = (await getUserPrefs(env, chatId)) || {};
  // Admin replies (Telegram swipe-reply) to a relayed user message → send to
  // that exact user. Lets the admin juggle many users without state mixups.
  if (
    chatId === ADMIN_CHAT_ID &&
    msg.reply_to_message &&
    text && !text.startsWith("/")
  ) {
    const quoted = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const m = quoted.match(/\b(\d{6,})\b/);
    if (m) {
      await sendAsKai(env, parseInt(m[1], 10), text);
      return;
    }
  }
  if (
    chatId === ADMIN_CHAT_ID &&
    typeof prefs.pending === "string" &&
    prefs.pending.startsWith("contact:") &&
    text && !text.startsWith("/")
  ) {
    const target = parseInt(prefs.pending.split(":")[1], 10);
    prefs.pending = null;
    await setUserPrefs(env, ADMIN_CHAT_ID, prefs);
    await sendAsKai(env, target, text);
    return;
  }
  if (prefs.pending === "feedback" && text && !text.startsWith("/")) {
    await handleFeedbackInput(env, chatId, prefs, text);
    return;
  }
  if (prefs.pending === "name" && text && !text.startsWith("/")) {
    await handleNameInput(env, chatId, prefs, text);
    return;
  }
  if (prefs.pending === "address" || prefs.pending === "address_confirm") {
    if (msg.location) {
      await handleAddressInput(env, chatId, prefs, null, msg.location);
      return;
    }
    if (text && !text.startsWith("/")) {
      // Treat any text input during confirm-stage as a fresh attempt.
      await handleAddressInput(env, chatId, prefs, text, null);
      return;
    }
  }

  // User replying after the admin contacted them → relay back to the admin.
  if (
    chatId !== ADMIN_CHAT_ID &&
    prefs.reply_to_admin &&
    !prefs.pending &&
    text && !text.startsWith("/")
  ) {
    const who =
      prefs.full_name ||
      [prefs.tg_first_name, prefs.tg_last_name].filter(Boolean).join(" ") ||
      (prefs.username ? `@${prefs.username}` : `chat ${chatId}`);
    const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await tg(env, "sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text:
        `💬 <b>תשובה מ-${who}</b> <code>${chatId}</code>\n\n${safe}\n\n` +
        `<i>↩️ השב להודעה הזו כדי לענות לו ישירות</i>`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[
        { text: "💬 השב למשתמש", callback_data: `contactuser:${chatId}` },
      ]] },
    });
    await logEvent(env, chatId, "user_reply", { text });
    return;
  }

  const cmd = text.split(/\s+/)[0].split("@")[0];
  const KNOWN_CMDS = new Set(["/start", "/reset", "/today", "/date", "/stop", "/resume", "/feedback", "/share"]);
  if (KNOWN_CMDS.has(cmd)) {
    const fresh = (await getUserPrefs(env, chatId)) || {};
    fresh.cmd_count = (fresh.cmd_count || 0) + 1;
    fresh.last_cmd_at = new Date().toISOString();
    await setUserPrefs(env, chatId, fresh);
    await logEvent(env, chatId, "command", { cmd });
  }

  if (cmd === "/start") {
    // Detect deep-link payloads like "/start follow_25441" — viral share flow.
    const parts2 = text.split(/\s+/);
    const arg = parts2[1];
    if (arg && arg.startsWith("follow_")) {
      await handleSharedFollow(env, chatId, msg.from, arg.slice("follow_".length));
      return;
    }
    await cmdStart(env, chatId, msg.from);
  }
  else if (cmd === "/reset") await cmdReset(env, chatId);
  else if (cmd === "/today") await cmdToday(env, chatId);
  else if (cmd === "/date") await cmdDate(env, chatId);
  else if (cmd === "/stop") await cmdStop(env, chatId);
  else if (cmd === "/resume") await cmdResume(env, chatId);
  else if (cmd === "/feedback") await cmdFeedback(env, chatId);
  else if (cmd === "/share") await cmdShare(env, chatId);
}

// ---------- Worker entry ----------
export default {
  async scheduled(event, env, ctx) {
    // Cron trigger every 5 min.
    ctx.waitUntil(Promise.all([
      processDueFollowups(env),
      fireDueHuntAlerts(env),
      checkScrapeHealth(env),
      maybeNudgeRestrictiveUsers(env),
      maybeCleanupHistory(env),
    ]));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/users") {
      const users = await getUsers(env);
      const result = await Promise.all(
        users.map(async (id) => ({
          chat_id: id,
          prefs: await getUserPrefs(env, id),
        }))
      );
      return Response.json({ users: result });
    }

    if (url.pathname.startsWith("/user/")) {
      const id = parseInt(url.pathname.split("/")[2], 10);
      return Response.json(await getUserPrefs(env, id));
    }

    // Click-tracking redirect for alert links. Two formats supported:
    //   /r/<session_id>?u=<token>  ← preferred (clean URL, no chat_id leaked)
    //   /r/<chat_id>/<session_id>  ← legacy (still works for old links in chat history)
    let mNew = url.pathname.match(/^\/r\/([^/]+)$/);
    let mOld = url.pathname.match(/^\/r\/(\d+)\/([^/]+)$/);
    let chatId = null, sessionId = null;
    if (mOld) {
      chatId = parseInt(mOld[1], 10);
      sessionId = mOld[2];
    } else if (mNew) {
      sessionId = mNew[1];
      const tok = url.searchParams.get("u");
      if (tok) chatId = await chatIdFromToken(env, tok);
    }
    if (sessionId) {
      const lead = url.searchParams.get("lead") || "";
      const sessions = await getSessions(env);
      // Resolve the stable key (start.level.side) to the freshest SRF id in KV
      // — SRF rotates session ids, so the id baked in the button may be stale.
      const k = url.searchParams.get("k");
      if (k) {
        const [kStart, kLevel, kSide] = k.split(".");
        const fresh = sessions.find((x) =>
          String(x.start) === kStart &&
          String(x.level) === kLevel &&
          (x.area.toLowerCase().includes("left") ? "L" : "R") === kSide
        );
        if (fresh) sessionId = fresh.id;
      }
      const s = sessions.find((x) => x.id === sessionId);
      const detail = s
        ? { session_id: sessionId, session_start: s.start, session_spots_at_click: s.spots, level: s.level, area: s.area, lead }
        : { session_id: sessionId, lead };
      if (chatId) {
        await logEvent(env, chatId, "click", detail);
        const due = (s ? s.start : Date.now()) + 30 * 60 * 1000;
        await queueFollowup(env, { chat_id: chatId, session_id: sessionId, due_ts: due, click_ts: Date.now(), session_start: s ? s.start : null, session_title: s ? s.title : "", level: s ? s.level : null, area: s ? s.area : "" });
      }
      // Build the SRF deep-link. ?sid auto-opens the booking modal — but only
      // if the session is in the currently displayed 3-day window. Add
      // ?from_date so SRF loads the correct window before clicking.
      let fromDateParam = "";
      if (s && s.start) {
        const d = new Date(s.start);
        const dd = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit",
        }).format(d);  // "DD/MM/YY"
        fromDateParam = `&from_date=${encodeURIComponent(dd)}`;
      }
      const target = `https://www.srfparktlv.co.il/sessions/?sid=${encodeURIComponent(sessionId)}${fromDateParam}&show-children=false&show-adults=false&zone=reef-right%7Creef-left`;
      // Mini App calls with ?json=1 — it logs the click via this same path but
      // opens SRF directly, so the user's browser never shows the worker URL.
      if (url.searchParams.get("json") === "1") {
        return Response.json({ target });
      }
      return Response.redirect(target, 302);
    }

    if (url.pathname === "/events") {
      // Bulk export of every user's events. Protected by the same PUSH_SECRET
      // already shared with the GH Actions monitor.
      const key = url.searchParams.get("key") || "";
      if (!env.PUSH_SECRET || key !== env.PUSH_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const known = await getKnownUsers(env);
      const wl = await getWhitelist(env);
      const all = [...new Set([...known, ...wl])];
      const sessions = await getSessions(env);
      const sessionById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const out = {};
      for (const id of all) {
        const prefs = await getUserPrefs(env, id);
        const events = await getEvents(env, id);
        if (!events.length && !prefs) continue;
        const stats = computeStats(events);
        // Cross-reference clicks with current sessions: if spots dropped
        // since the click, mark as "probably_registered" (passive heuristic).
        if (stats && stats.alert_clicks) {
          stats.session_probable_registration = {};
          for (const [sid, spotsAtClick] of Object.entries(stats.clicks_by_session)) {
            const cur = sessionById[sid];
            if (!cur || spotsAtClick == null) continue;
            stats.session_probable_registration[sid] = {
              spots_at_click: spotsAtClick,
              spots_now: cur.spots,
              dropped: spotsAtClick - cur.spots,
              session_start: cur.start,
            };
          }
        }
        out[id] = {
          prefs: prefs && {
            full_name: prefs.full_name,
            username: prefs.username,
            levels: getLevels(prefs),
            direction: prefs.direction,
            spots_threshold: prefs.spots_threshold,
            address: prefs.address,
            cmd_count: prefs.cmd_count || 0,
            last_cmd_at: prefs.last_cmd_at,
          },
          stats,
          events,
        };
      }
      return new Response(JSON.stringify(out, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="surf-bot-events.json"',
        },
      });
    }

    if (url.pathname === "/alert_sent" && request.method === "POST") {
      const auth = request.headers.get("X-Auth") || "";
      if (!env.PUSH_SECRET || auth !== env.PUSH_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const { chat_id, kind, session_id } = await request.json();
      await logAlertSent(env, chat_id, kind, session_id || null);
      return new Response("ok");
    }

    if (url.pathname === "/sessions" && request.method === "POST") {
      const auth = request.headers.get("X-Auth") || "";
      if (!env.PUSH_SECRET || auth !== env.PUSH_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.text();
      await env.KV.put("sessions", body);
      let count = 0;
      try {
        const arr = JSON.parse(body);
        count = arr.length;
        await pushSessionsHistoryD1(env, arr);
      } catch (e) {
        console.error("sessions_history insert:", e);
      }
      // Health heartbeat: record last successful scrape + session count.
      await env.KV.put("last_scrape", JSON.stringify({ ts: Date.now(), count }));
      // Clear any prior staleness-alert flag so a fresh outage re-alerts.
      await env.KV.delete("health_alerted");
      return new Response("ok");
    }

    if (url.pathname === "/debug") {
      const sessions = await getSessions(env);
      const users = await getUsers(env);
      return Response.json({
        sessionsInKV: sessions.length,
        userCount: users.length,
        users,
        firstSession: sessions[0] || null,
      });
    }

    if (url.pathname === "/setup") {
      // One-time: sets the bot's display name (the chat title shown in Telegram).
      const r1 = await tg(env, "setMyName", { name: "Kai" });
      const r2 = await tg(env, "setMyShortDescription", {
        short_description: "קאי — התראות על סשנים פנויים בסרף פארק ת\"א",
      });
      const r3 = await tg(env, "setMyDescription", {
        description: "היי, אני קאי 🤙 שולח לך התראה לפני סשנים בסרף פארק תל אביב כשנשארו מקומות פנויים, לפי הרמה והשעות שלך.",
      });
      // Remove the Mini App "OPEN" launcher — reset menu button to commands.
      const r4 = await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } });
      return Response.json({ setMyName: r1, setMyShortDescription: r2, setMyDescription: r3, setChatMenuButton: r4 });
    }

    if (url.pathname === "/follow") {
      const sid = url.searchParams.get("s") || "";
      const tok = url.searchParams.get("u") || "";
      const cid = tok ? await chatIdFromToken(env, tok) : null;
      if (!sid || !cid) return Response.json({ ok: false }, { status: 400 });
      const existing = await d1First(env,
        `SELECT a.id FROM alerts a JOIN users u ON a.user_id = u.id
         WHERE u.telegram_id = ? AND a.session_id = ? AND a.is_active = 1`,
        [cid, sid]);
      if (!existing) await addHuntAlert(env, cid, null, null, null, null, sid);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/app") {
      const q = url.searchParams;
      const sid = q.get("s") || "";
      const tok = q.get("u") || "";
      const esc = (v) =>
        String(v || "").replace(/[&<>"']/g, (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );
      const t = esc(q.get("t"));
      const lv = esc(q.get("lv"));
      const sd = esc(q.get("sd"));
      const ti = esc(q.get("ti")) || "סשן";
      const sp = esc(q.get("sp"));
      const regUrl = `${url.origin}/r/${encodeURIComponent(sid)}?u=${encodeURIComponent(tok)}&lead=manual`;
      const followUrl = `${url.origin}/follow?s=${encodeURIComponent(sid)}&u=${encodeURIComponent(tok)}`;
      const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>הרשמה לסשן</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #fff);
    color: var(--tg-theme-text-color, #000);
    padding: 20px; min-height: 100vh;
    display: flex; flex-direction: column;
  }
  .card {
    background: var(--tg-theme-secondary-bg-color, #f4f4f5);
    border-radius: 16px; padding: 20px; margin-bottom: 16px;
  }
  .title { font-size: 20px; font-weight: 700; margin: 0 0 14px; }
  .row { display: flex; justify-content: space-between; padding: 8px 0;
         border-bottom: 1px solid rgba(128,128,128,.18); font-size: 16px; }
  .row:last-child { border-bottom: 0; }
  .label { color: var(--tg-theme-hint-color, #888); }
  .val { font-weight: 600; }
  .spots { color: #1e9e4a; font-weight: 700; }
  .note { font-size: 13px; color: var(--tg-theme-hint-color, #888);
          text-align: center; margin-top: auto; padding-top: 16px; }
  button {
    width: 100%; padding: 15px; font-size: 17px; font-weight: 700;
    border: 0; border-radius: 14px; cursor: pointer; margin-bottom: 10px;
    background: var(--tg-theme-button-color, #2ea6ff);
    color: var(--tg-theme-button-text-color, #fff);
  }
  button.secondary {
    background: transparent;
    color: var(--tg-theme-button-color, #2ea6ff);
    box-shadow: inset 0 0 0 1.5px var(--tg-theme-button-color, #2ea6ff);
  }
  button:disabled { opacity: .6; cursor: default; }
</style>
</head>
<body>
  <div class="card">
    <h1 class="title">🌊 ${ti}</h1>
    <div class="row"><span class="label">שעה</span><span class="val">${t || "—"}</span></div>
    <div class="row"><span class="label">רמה</span><span class="val">L${lv || "—"} ${sd || ""}</span></div>
    <div class="row"><span class="label">מקומות פנויים</span><span class="spots">${sp || "—"}</span></div>
  </div>
  <button id="reg">📝 המשך להרשמה באתר סרף פארק</button>
  <button id="flw" class="secondary">🔔 עקוב אחרי הסשן</button>
  <div class="note">קאי ישלח לך תזכורת אחרי הסשן לוודא שנרשמת 🤙</div>
<script>
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  document.getElementById("reg").addEventListener("click", function () {
    var btn = document.getElementById("reg");
    btn.disabled = true; btn.textContent = "פותח את אתר ההרשמה…";
    // Open the /r/ link directly — it logs the click and 302-redirects to the
    // SRF deep-link, the proven flow that auto-opens the booking modal.
    var u = ${JSON.stringify(regUrl)};
    if (tg && tg.openLink) { tg.openLink(u); } else { window.open(u, "_blank"); }
    if (tg && tg.close) { setTimeout(function () { tg.close(); }, 400); }
  });
  document.getElementById("flw").addEventListener("click", function () {
    var b = document.getElementById("flw");
    b.disabled = true; b.textContent = "רושם מעקב…";
    fetch(${JSON.stringify(followUrl)})
      .then(function (r) { return r.json(); })
      .then(function (d) {
        b.textContent = (d && d.ok) ? "✅ עוקב — קאי יעדכן כשמתפנה מקום" : "❌ לא הצלחתי, נסה שוב";
        if (d && d.ok && tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      })
      .catch(function () { b.textContent = "❌ לא הצלחתי, נסה שוב"; b.disabled = false; });
  });
</script>
</body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      try {
        await handleUpdate(env, update);
      } catch (e) {
        console.error("update error:", e, e.stack);
      }
      return new Response("ok");
    }

    return new Response("surf-park-bot", { status: 200 });
  },
};
