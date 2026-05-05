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

// ---------- KV helpers ----------
const userKey = (id) => `user:${id}:prefs`;

async function getUserPrefs(env, chatId) {
  const raw = await env.KV.get(userKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function setUserPrefs(env, chatId, prefs) {
  await env.KV.put(userKey(chatId), JSON.stringify(prefs));
}

async function deleteUser(env, chatId) {
  await env.KV.delete(userKey(chatId));
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

async function notifyAdminAccessRequest(env, msg) {
  const from = msg.from || {};
  const uname = from.username ? `@${from.username}` : "(אין שם משתמש)";
  const name = `${from.first_name || ""} ${from.last_name || ""}`.trim();
  await tg(env, "sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `🔔 <b>בקשת גישה חדשה</b>\n` +
      `שם: ${name}\nשם משתמש: ${uname}\nchat_id: <code>${msg.chat.id}</code>`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ אישור", callback_data: `approve:${msg.chat.id}` },
        { text: "❌ דחיה", callback_data: `deny:${msg.chat.id}` },
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
function waveKeyboard() {
  return {
    inline_keyboard: [
      WAVE_LEVELS.slice(0, 3).map((n) => ({
        text: `L${n}`,
        callback_data: `wave:${n}`,
      })),
      WAVE_LEVELS.slice(3).map((n) => ({
        text: `L${n}`,
        callback_data: `wave:${n}`,
      })),
    ],
  };
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
  return `<b>L${p.level} ${SIDE_HE[p.direction]}</b>${addr}`;
}

// ---------- Onboarding state ----------
// Stored in prefs.pending = "name" | "address" | "wave" | "direction" | null
async function startOnboarding(env, chatId, existingPrefs = null) {
  const base = existingPrefs || {};
  await setUserPrefs(env, chatId, { ...base, pending: "name" });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "👋 ברוך הבא ל-<b>Surf Park Alerts</b>!\n\n" +
      "אני שולח התראות לפני סשנים בסרף פארק תל אביב כשנשארו מקומות פנויים.\n\n" +
      "<b>שלב 1/4:</b> מה השם המלא שלך?",
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
}

async function askAddress(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "<b>שלב 2/4:</b> שלח את הכתובת שלך (לחישוב זמן נסיעה).\n" +
      "אפשר גם ללחוץ על 📎 ואז על 'Location' כדי לשלוח את המיקום שלך.",
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [[{ text: "📍 שתף מיקום", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// 7-day picker for /date.
function dateKeyboard() {
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const rows = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
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
    const label = i === 0 ? `היום (${day}/${month})` : i === 1 ? `מחר (${day}/${month})` : `${wd} ${day}/${month}`;
    const key = `${year}${month}${day}`;
    rows.push([{ text: label, callback_data: `date:${key}` }]);
  }
  return { inline_keyboard: rows };
}

async function handleAddressInput(env, chatId, prefs, text, location) {
  let addr = null, lat = null, lon = null;
  if (location) {
    lat = location.latitude;
    lon = location.longitude;
    addr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  } else if (text) {
    const g = await geocode(text);
    if (!g) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "לא הצלחתי למצוא את הכתובת הזו. תנסה שוב או שלח מיקום (📎 → Location).",
      });
      return;
    }
    lat = g.lat;
    lon = g.lon;
    addr = text;
  }

  prefs.lat = lat;
  prefs.lon = lon;
  prefs.address = addr;
  prefs.pending = null;
  await setUserPrefs(env, chatId, prefs);

  // Move to wave selection. Use removeKeyboard to clear the location button.
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `✓ הכתובת נשמרה.\n\n<b>שלב 3/4:</b> בחר רמת גל:`,
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "בחר רמת גל:",
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
async function cmdStart(env, chatId, from) {
  const prefs = (await getUserPrefs(env, chatId)) || {};
  if (from) {
    prefs.username = from.username || prefs.username;
    await setUserPrefs(env, chatId, prefs);
  }

  // If everything's already set, skip onboarding and just say hi.
  const complete =
    prefs.full_name && prefs.address && prefs.level && prefs.direction;
  if (complete) {
    await addUser(env, chatId);  // ensure they're in subscriber list
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        `👋 <b>ברוך השב!</b>\n\n` +
        `<b>שם:</b> ${prefs.full_name}\n` +
        `<b>כתובת:</b> ${prefs.address}\n` +
        `<b>העדפות:</b> L${prefs.level} ${SIDE_HE[prefs.direction]}\n\n` +
        `<i>/reset לשינוי הגדרות · /help לכל הפקודות</i>`,
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
  } else if (!prefs.level) {
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `<b>שלב 3/4:</b> בחר רמת גל:`,
      parse_mode: "HTML",
      reply_markup: waveKeyboard(),
    });
  } else if (!prefs.direction) {
    prefs.pending = null;
    await setUserPrefs(env, chatId, prefs);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `רמת גל: <b>L${prefs.level}</b>\n<b>שלב 4/4:</b> בחר כיוון:`,
      parse_mode: "HTML",
      reply_markup: dirKeyboard(prefs.level),
    });
  }
}

async function cmdReset(env, chatId) {
  const prefs = (await getUserPrefs(env, chatId)) || {};
  // Keep address if already set; just re-pick wave + direction.
  prefs.pending = null;
  await setUserPrefs(env, chatId, prefs);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔄 <b>איפוס הגדרות</b>\nבחר רמת גל:",
    parse_mode: "HTML",
    reply_markup: waveKeyboard(),
  });
}

async function cmdStop(env, chatId) {
  await deleteUser(env, chatId);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🚪 הוסרת מרשימת ההתראות. שלח /start כדי לחזור.",
  });
}

async function cmdHelp(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "🏄 <b>Surf Park Alerts</b>\n\n" +
      "/today — סשנים שלך היום\n" +
      "/all — כל הסשנים היום\n" +
      "/date — סשנים שלך לתאריך נבחר (שבוע קדימה)\n" +
      "/reset — שינוי רמת גל וכיוון\n" +
      "/stop — הפסקת התראות\n" +
      "/help — תפריט זה",
    parse_mode: "HTML",
  });
}

async function cmdDate(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "בחר תאריך:",
    reply_markup: dateKeyboard(),
  });
}

async function showSessionsForDate(env, chatId, dayKey) {
  const prefs = await getUserPrefs(env, chatId);
  if (!prefs || !prefs.level) {
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
  const header = `📋 <b>${wantedDay} (L${prefs.level} ${SIDE_HE[prefs.direction]})</b>\n`;
  const body = matching.length
    ? matching.map((s) => fmtSession(s, false)).join("\n")
    : "אין סשנים מתאימים בתאריך הזה.";
  return { header, body };
}

function fmtSession(s, withSide = true) {
  const time = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(s.start));
  const side = s.area.toLowerCase().includes("left") ? "שמאל" : "ימין";
  const sideStr = withSide ? ` ${side}` : "";
  return `• ${time}${sideStr} — ${s.title} — נותרו ${s.spots} מקומות`;
}

function matchesPrefs(s, prefs) {
  if (s.level !== prefs.level) return false;
  const a = s.area.toLowerCase();
  if (prefs.direction === "left") return a.includes("left");
  if (prefs.direction === "right") return a.includes("right");
  return true; // both
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
  if (!prefs || !prefs.level) {
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
  const header = `📋 <b>סטטוס היום (L${prefs.level} ${SIDE_HE[prefs.direction]})</b>\n`;
  const body = matching.length
    ? matching.map((s) => fmtSession(s, false)).join("\n")
    : "אין סשנים מתאימים שנותרו היום.";
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: header + body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function cmdAll(env, chatId) {
  const sessions = await getSessions(env);
  const today = todayKeyIL();
  const nowMs = Date.now();
  const todays = sessions.filter(
    (s) => s.start > nowMs && sessionDayKey(s) === today
  );
  if (!todays.length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "אין סשנים שנותרו היום.",
    });
    return;
  }
  const lines = ["📋 <b>כל הסשנים שנותרו היום</b>"];
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
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data || "";

    // Admin-only approval buttons
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

    if (data.startsWith("date:")) {
      const dayKey = data.slice(5);
      const result = await showSessionsForDate(env, chatId, dayKey);
      if (result) {
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: result.header + result.body,
          parse_mode: "HTML",
          reply_markup: dateKeyboard(),
        });
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (data.startsWith("wave:")) {
      const level = parseInt(data.slice(5), 10);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `רמת גל: <b>L${level}</b>\n<b>שלב 4/4:</b> בחר כיוון:`,
        parse_mode: "HTML",
        reply_markup: dirKeyboard(level),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    } else if (data.startsWith("dir:")) {
      const [, lvl, dir] = data.split(":");
      const prefs = (await getUserPrefs(env, chatId)) || {};
      prefs.level = parseInt(lvl, 10);
      prefs.direction = dir;
      prefs.pending = null;
      await setUserPrefs(env, chatId, prefs);
      await addUser(env, chatId);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text:
          `✅ <b>סיימנו!</b>\n\n` +
          `הגדרות: ${describePrefs(prefs)}\n\n` +
          `אקבל התראות 1:45 לפני סשן (>12 מקומות) ו-1:15 לפני (>10 מקומות).\n` +
          `שלח /help לכל הפקודות.`,
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

  // Admin-only commands
  if (chatId === ADMIN_CHAT_ID && text.startsWith("/")) {
    const parts = text.split(/\s+/);
    if (parts[0] === "/list") {
      const wl = await getWhitelist(env);
      const users = await getUsers(env);
      const userPrefs = await Promise.all(
        wl.map(async (id) => ({ id, p: await getUserPrefs(env, id) }))
      );
      const lines = [`👥 <b>משתמשים (${wl.length})</b>`, ""];
      for (const { id, p } of userPrefs) {
        const name = (p && p.full_name) || "(לא הזין שם)";
        const uname = p && p.username ? `@${p.username}` : "(אין שם משתמש)";
        const subscribed = users.includes(id) ? "🟢 פעיל" : "⚪️ לא הושלם /start";
        const isAdmin = id === ADMIN_CHAT_ID ? " 👑" : "";
        lines.push(`<b>${name}</b>${isAdmin} — ${uname}`);
        lines.push(`  chat_id: <code>${id}</code> · ${subscribed}`);
        if (p && p.level) {
          lines.push(`  הגדרות: L${p.level} ${SIDE_HE[p.direction] || p.direction}`);
        }
        if (p && p.address) {
          lines.push(`  כתובת: ${p.address}`);
        }
        lines.push("");
      }
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: lines.join("\n").slice(0, 4090),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }
    if (parts[0] === "/revoke" && parts[1]) {
      const target = parseInt(parts[1], 10);
      await revokeUser(env, target);
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

  if (!(await isApproved(env, chatId))) {
    // First contact from un-approved user → notify admin once.
    const requestKey = `pending:${chatId}`;
    const already = await env.KV.get(requestKey);
    if (!already) {
      await env.KV.put(requestKey, "1", { expirationTtl: 86400 });
      await notifyAdminAccessRequest(env, msg);
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🚫 הבוט בגישה מוגבלת. בקשתך נשלחה לבעלים לאישור.\n" +
        "תקבל הודעה ברגע שתאושר.",
    });
    return;
  }

  // Mid-onboarding handlers — accept free-text input depending on stage.
  const prefs = (await getUserPrefs(env, chatId)) || {};
  if (prefs.pending === "name" && text && !text.startsWith("/")) {
    await handleNameInput(env, chatId, prefs, text);
    return;
  }
  if (prefs.pending === "address") {
    if (msg.location) {
      await handleAddressInput(env, chatId, prefs, null, msg.location);
      return;
    }
    if (text && !text.startsWith("/")) {
      await handleAddressInput(env, chatId, prefs, text, null);
      return;
    }
  }

  const cmd = text.split(/\s+/)[0].split("@")[0];
  if (cmd === "/start") await cmdStart(env, chatId, msg.from);
  else if (cmd === "/reset") await cmdReset(env, chatId);
  else if (cmd === "/today") await cmdToday(env, chatId);
  else if (cmd === "/all") await cmdAll(env, chatId);
  else if (cmd === "/date") await cmdDate(env, chatId);
  else if (cmd === "/stop") await cmdStop(env, chatId);
  else if (cmd === "/help") await cmdHelp(env, chatId);
}

// ---------- Worker entry ----------
export default {
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

    if (url.pathname === "/sessions" && request.method === "POST") {
      const auth = request.headers.get("X-Auth") || "";
      if (!env.PUSH_SECRET || auth !== env.PUSH_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.text();
      await env.KV.put("sessions", body);
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
