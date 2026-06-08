# Kai bot — data schema

Two stores back the bot:

- **D1** (relational) — `surf-bot-db`, binding `DB`. Schema below.
- **KV** (key/value) — `surf-bot-kv`, binding `KV`. Mostly per-user prefs and ad-hoc state.

D1 schemas are created idempotently by `ensureD1Schema(env)` on every cron tick.

---

## D1 tables

### `users`
Mirror of each onboarded user's Telegram identity and preferences (the canonical KV `user:{chat_id}:prefs` row, projected into columns for analytics joins).
Key columns: `telegram_id`, `full_name`, `username`, `address`, `lat`, `lon`, `levels` (JSON), `direction`, `spots_threshold`, `status`, `cmd_count`, `last_cmd_at`, `updated_at`.

### `search_logs`
One row per `/today` / `/date` invocation. Columns: `user_id`, `command`, `requested_levels`, `requested_direction`, `target_date`, `matched`, `available`, `search_timestamp`.

### `sessions_history`
Snapshot of every SRF session the scraper sees (cleared after 90 days by `maybeCleanupHistory`). Columns: `session_id`, `level`, `area`, `start_ts`, `spots`, `title`, `scraped_at`.

### `alerts`
Hunt alerts (the bell — "follow this session/level/direction"). Columns: `user_id`, `level`, `direction`, `target_date`, `target_time`, `session_id`, `is_active`, `created_at`.

### `alerts_sent`
Each pre-session push the monitor dispatched. Used to compute `lead_ms` (time-to-click). Columns: `telegram_id`, `kind` (e.g. `lead105`, `lead75`, `huntsess`, `followup`), `session_id`, `sent_at`.

### `feedback`
`/feedback` submissions. Columns: `telegram_id`, `content`, `created_at`.

### `user_funnel`  *(analytics)*
First-touch lifecycle timestamps. One row per user.
Columns: `telegram_id` (PK), `start_ts`, `onboarded_ts`, `first_click_ts`, `first_reg_ts`, `repeat_reg_ts`.
- All columns are first-touch (set once on first occurrence) **except** `repeat_reg_ts`, which tracks the most-recent repeat registration.

### `sessions_filled`  *(analytics)*
Records the moment each session first hit 0 spots — measures fill velocity.
Columns: `session_id` (PK), `level`, `area`, `start_ts`, `title`, `filled_ts`.

### `daily_metrics`  *(analytics)*
One row per IL day with aggregated KPIs, populated once per day by `maybeRunDailyMetrics`.
Columns: `day_key` (PK, `YYYY-MM-DD`), `new_users`, `active_users`, `alerts_sent`, `clicks`, `regs`, `conv_pct`, `top_wave`, `peak_hour`.

---

## KV keys

| key | shape | notes |
| --- | --- | --- |
| `user:{chat_id}:prefs` | JSON | canonical user prefs — onboarding fields + `quiet_from` / `quiet_to` |
| `users` | JSON `[chat_id, ...]` | subscribed (notifications on) |
| `whitelist` | JSON `[chat_id, ...]` | approved-for-access |
| `known_users` | JSON `[chat_id, ...]` | ever-seen — used as iteration root |
| `events:{chat_id}` | JSON `[...event]` | per-user event log, capped at `EVENT_CAP` and trimmed to 90 days daily |
| `sessions` | JSON `[...session]` | latest scraper push from monitor |
| `sessions_prev_spots` | JSON `{id:spots}` | for diffing to detect fills (TTL 24h) |
| `last_scrape` | JSON `{ts, count}` | used by `checkScrapeHealth` |
| `followups` | JSON `[...item]` | queued post-session surveys |
| `health_alerted` | string `"1"` | re-arm 6h |
| `cleanup_day` / `metrics_day` / `retention_day` / `privacy_day` / `anomaly_day` | string `YYYY-MM-DD` | once-per-day gates with 2-day TTL |

---

## Event taxonomy

Recorded by `logEvent(env, chatId, action, params)` into `events:{chat_id}`.

| action | params | notes |
| --- | --- | --- |
| `command` | `cmd` | every /command invocation |
| `result` | `cmd`, `matched`, `available` | result counts of `/today`/`/date` |
| `click` | `session_id`, `session_start`, `session_spots_at_click`, `level`, `area`, `lead`, `lead_ms` | `lead_ms` is delta from the most recent `alerts_sent` row for `(user, session)` |
| `registration_report` | `session_id`, `registered` (bool), `answer` ("yes" / "no" / "na") | follow-up survey response |
| `admin_message` | `text` | when the admin sends a message to this user via Kai |
| `user_reply` | `text` | user's reply that was routed to the admin |
| `stop_reason` | `reason` (`not_relevant` / `too_many` / `never_registered` / `other`) | churn classification from `/stop` |

---

## Cron tasks (every 5 minutes)

| task | what it does | gate |
| --- | --- | --- |
| `ensureD1Schema` | CREATE TABLE IF NOT EXISTS for analytics tables | idempotent |
| `processDueFollowups` | sends post-session "did you register?" surveys | per-item due_ts |
| `fireDueHuntAlerts` | dispatches matched hunt alerts | due_at |
| `checkScrapeHealth` | admin alert if scrape stale or 0 sessions | KV `health_alerted` (6h) |
| `maybeNudgeRestrictiveUsers` | suggests broadening prefs for low-coverage users | per-user state |
| `maybeCleanupHistory` | drops `sessions_history` rows >90d | KV `cleanup_day` (1d) |
| `trackSessionsFilled` | diffs current vs prev spots, records fills | per-tick |
| `maybeRunDailyMetrics` | writes yesterday's `daily_metrics` row | KV `metrics_day` (1d) |
| `maybeRunEventRetention` | trims `events:*` keys to last 90 days | KV `retention_day` (1d) |
| `maybeRunPrivacyPurge` | deletes prefs+events for users frozen >30 days | KV `privacy_day` (1d) |
| `maybeRunAnomalyCheck` | admin alert if conv or clicks crashed vs 7d average | KV `anomaly_day` (1d) |
