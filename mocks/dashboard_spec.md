# Green Cross — Sales Dashboard Spec

**Status:** Design-approved, ready for build
**Owner:** Sky Pinnick
**Last updated:** May 15, 2026

This is a standalone internal tool that tracks sales performance across six dispensaries. Two distinct views, one shared data model. Three HTML mocks accompany this spec and are the source of truth for visual design.

## 1. The three views

| File | Audience | Vibe |
|------|----------|------|
| `budtender_leaderboard_mock.html` | General staff leaderboard (utility view) | Dense, table-driven |
| `baseline_kiosk_mock.html` | Store-floor display, one per location | Gamified, kinetic, celebratory |
| `director_dashboard_mock.html` | Owner + Director of Retail | Analytical, drill-down, alerts-driven |

## 2. Roles and routing

Login redirects based on `role`:

| Role | Redirects to | Scope |
|------|--------------|-------|
| `owner` | `/director` | All 6 stores |
| `director` | `/director` | All 6 stores |
| `store_manager` | `/store/:store_id` (kiosk) | Single store |
| `asst_manager` | `/store/:store_id` (kiosk) | Single store |
| `budtender` | `/store/:store_id` (kiosk) | Single store, read-only |

The kiosk view is identical across the three store-level roles in v1. The view is meant to live on the main store computer behind the counter, visible to the team. There is no manager-only mode at the store level (per product direction).

Director and owner share the same view in v1. If we later need to scope features behind owner-only (e.g., setting plan targets, payroll-adjacent data), introduce a permission flag rather than a separate view.

## 3. Data model

### `Store`
- `id` (uuid)
- `name` — "Baseline", "Center", "Century", "Commercial", "Portland", "River"
- `slug` — for URL routing
- `address`
- `open_time`, `close_time` — local time
- `daily_revenue_goal` (decimal) — default plan target
- `daily_goal_overrides` — keyed by date for one-off targets (e.g., 4/20, Black Friday)
- `store_manager_id` (FK Employee)

### `Employee`
- `id`
- `name`
- `email`
- `store_id` (FK; nullable for director/owner)
- `role` — enum above
- `hire_date`
- `photo_url` (optional)
- `active` (bool)

### `Transaction`
- `id`
- `store_id`
- `employee_id` — who rang it up
- `customer_id` (nullable; for new-customer detection)
- `timestamp`
- `subtotal` — pre-discount, pre-tax
- `discount_amount`
- `discount_reason_code` — enum: `veteran`, `senior`, `medical`, `manager_comp`, `loyalty`, `employee`, `none`
- `id_scan_present` (bool) — for compliance flagging
- `tax`
- `total`
- `payment_method`

### `TransactionItem`
- `transaction_id` (FK)
- `sku`
- `product_name`
- `category` — Flower, Vape, Edible, Concentrate, Pre-roll, Accessory
- `brand`
- `unit_price`
- `qty`
- `line_discount`
- `line_total`

### `StorePlan` (optional separate table)
- `store_id`
- `effective_date`
- `daily_revenue_target`
- `weekly_revenue_target`

## 4. Metric definitions

**Average Order Value (AOV)**
```
AOV = SUM(transaction.total) / COUNT(transaction)
```

**Units Per Transaction (UPT)**
```
UPT = SUM(transaction_item.qty) / COUNT(transaction)
```

**Discount Rate**
```
discount_rate = SUM(transaction.discount_amount) / SUM(transaction.subtotal)
```
Note: subtotal is pre-discount, pre-tax. Confirm with the existing accounting view that subtotal is defined this way in the source API.

**Pace (vs. plan)**

V1 (simple):
```
fraction_of_day_elapsed = minutes_since_open / total_business_minutes_today
projected_close = today_revenue / fraction_of_day_elapsed
pace = (projected_close / daily_goal) - 1     // expressed as %
```

V2 (preferred, requires historical data):
```
expected_at_time_t = daily_goal × historical_cumulative_revenue_fraction(t)
pace = (today_revenue - expected_at_time_t) / expected_at_time_t
```
Where `historical_cumulative_revenue_fraction(t)` is the trailing 30-day average % of daily revenue earned by hour `t` at that store. Use this once we have enough history.

**Streak**

Number of consecutive shifts where an employee's revenue beat their personal 30-day rolling average shift revenue. Resets on a shift below their average. Open product question: count by shift or by day? Recommendation: shifts (more granular, fairer to part-timers).

**Personal Best**

`max(shift_revenue) for employee_id over last 90 days`. Surfaced as "Personal Best in sight" tag when today's projected shift revenue ≥ 90% of this number.

## 5. Threshold values

These drive UI states. All should be configurable in a settings table; values below are the v1 defaults.

| Threshold | Value | Used for |
|-----------|------:|----------|
| `discount_watch_threshold` | 6.5% | Flagging staff for the discount-watch panel |
| `discount_unusual_pct` | 15% | Per-transaction line-level flag |
| `rare_drop_min_transaction` | $400 | Rare-drop celebration trigger |
| `rare_drop_min_line_item` | $300 | Alternate trigger (single SKU line) |
| `rare_drop_max_per_shift` | 3 | Throttle so rare drops stay rare |
| `pace_red_below` | −5% | Red dot in store status strip |
| `pace_amber_below` | −1% | Amber dot |
| `pace_green_above` | +1% | Green dot |
| `goal_celebration_at` | 100% | Confetti + banner trigger |
| `new_hire_window` | 60 days | Adds "New" tag to leaderboard rows |

## 6. Real-time strategy

**Kiosk (`/store/:id`)**
- Live ticker: Server-Sent Events from `GET /api/stores/:id/sales/stream` — each new transaction pushed as one event
- Rare drop + goal hit: pushed via same SSE channel with named event types (`event: rare_drop`, `event: goal_hit`)
- All other panels: poll `GET /api/stores/:id/today` every 30 seconds
- On reconnect after disconnect: fetch state once, then resume stream
- `localStorage` flags to prevent celebrations re-firing on page reload within the same business day

**Director (`/director`)**
- All panels poll `GET /api/director/summary` every 60 seconds
- No streaming — decisions here are minute-scale, not second-scale
- Refresh button forces immediate fetch

## 7. API surface (proposed)

Reuse the existing API client from the two current Code projects. New endpoints needed:

```
GET  /api/stores
GET  /api/stores/:id
GET  /api/stores/:id/today          → revenue, txn count, on-shift, hourly breakdown
GET  /api/stores/:id/leaderboard    → today's 6 employees ranked
GET  /api/stores/:id/badges?period=week
GET  /api/stores/:id/sales/stream   → SSE: txns, rare_drop, goal_hit
GET  /api/stores/:id/employees

GET  /api/director/summary?period=mtd
GET  /api/director/stores?period=mtd        → ranked store leaderboard
GET  /api/director/staff?period=mtd         → cross-store top performers
GET  /api/director/alerts                   → discount watch, OOS spikes, ramp tracker, etc.
GET  /api/director/discount-watch?days=14

POST /api/stores/:id/plan                   → director-only: set daily goal
```

Auth scoping: every endpoint checks the caller's role + store_id. Store-scoped users get 403 on `/api/director/*` and on other stores' endpoints.

## 8. Visual design tokens

Pull from the mocks; extract into a tokens file or CSS custom properties. Key values:

```
--bg:           #0a0e0d
--surface:      #121715
--surface-2:    #161c1a
--border:       #232a27
--border-strong:#2e3733
--text:         #e6ece9
--text-dim:     #8a958f
--text-mute:    #5e6864
--green:        #4ade80   /* positive, active state, top-3 rank */
--red:          #ef4444   /* negative, flag, severity high */
--amber:        #eab308   /* caution, mid-severity */
--blue:         #60a5fa   /* info, secondary identity */
--purple:       #a78bfa   /* rare events */
```

- Font: `-apple-system, "Inter", "Segoe UI", Roboto`
- All currency and numeric figures: `font-variant-numeric: tabular-nums`
- Card radius: 8–10px · Buttons: 6px · Pills: 999px
- Card padding: 14–18px · Inter-card gap: 10–14px

## 9. Open product questions

To decide during build. Each has a recommended default in parentheses.

1. **Streak counting unit**: shifts or days? (Recommend: shifts)
2. **Daily goal authority**: director sets; can store manager request a same-day override? (Recommend: director-only in v1)
3. **Personal-best window**: 30, 60, or 90 days? (Recommend: 90)
4. **Rare-drop throttle**: max per shift? (Recommend: 3)
5. **Trophy reset cadence**: weekly Monday 12:01 AM local? (Recommend: yes)
6. **Tip handling**: are tips pooled? If pooled, add tip-jar widget in v1.1. If individual, skip. (Confirm with operations)
7. **Kiosk idle behavior**: after 10 min of no new sales (e.g., post-close), should the screen rotate into a "week recap" reel? (Recommend: yes, post-close only)
8. **OOS data source**: pull from existing inventory API (per the inventory screenshot's data) or query directly? (Recommend: existing API to avoid drift)

## 10. Build sequence (recommended)

1. Auth + role-based routing skeleton (steal from existing project)
2. Shared design tokens, primitive components (`KPICard`, `Pill`, `RankPill`, `Sparkline`, `Avatar`, `Tag`)
3. Director view — easier to build first, all polling, no streaming, no animations
4. Kiosk static layout — same primitives, denser composition
5. Kiosk animations (count-up, arc/needle, pulses) — pure CSS/SVG
6. SSE channel — ticker first, then rare-drop and goal-hit
7. localStorage state for celebration de-dupe
8. Plan-setting CRUD for director
9. Configurable thresholds (settings table + admin UI — could be deferred to v1.1)

## 11. Reuse from existing Code projects

- API client + auth flow — do not re-build
- Toast / dialog primitives if they exist — wrap or extend
- Design token system — extend with the new accent colors above if they aren't already present
- Any existing date/period helpers (MTD / WTD / QTD selectors)
- Error/empty-state components

## 12. Mocks index

All three single-file HTML mocks are visual sources of truth:

- `budtender_leaderboard_mock.html` — general leaderboard / utility table
- `baseline_kiosk_mock.html` — store kiosk (animated, gamified)
- `director_dashboard_mock.html` — all-stores command center

When in doubt about styling, defer to the mocks before this doc.
