# First prompt to paste into Claude Code

Copy the block below as your opening message in a new Code session. Adjust the bracketed bits (`[...]`) for your actual project names and paths.

---

I'm starting a new standalone internal tool for Green Cross — a sales performance dashboard for staff across our 6 dispensary locations. This is a **third project**, not a new view inside either existing app. It will reuse the API client, auth, and design tokens from the existing projects.

Before you write any code, please do the following in this order:

**1. Read these files in full and treat them as the source of truth:**
- `docs/mocks/budtender_leaderboard_mock.html` — general leaderboard view
- `docs/mocks/baseline_kiosk_mock.html` — gamified store-floor kiosk
- `docs/mocks/director_dashboard_mock.html` — all-stores director view
- `docs/dashboard_spec.md` — data model, metric definitions, thresholds, routing, open questions

**2. Read the two existing projects** at `[../path-to-project-a]` and `[../path-to-project-b]`. Identify what to reuse:
- API client and auth flow
- Design token system (colors, typography, spacing)
- Shared primitives (cards, buttons, pills, toast, dialog)
- Date/period helpers (MTD/WTD/QTD)
- Any test setup, lint config, build tooling I should mirror

**3. Propose** — do not yet write — a scaffolding plan covering:
- Repo layout (which directories, why)
- The set of primitive components needed (`KPICard`, `Pill`, `RankPill`, `Sparkline`, `Avatar`, `Tag`, etc.) and which already exist in project A or B vs. which need to be net new
- Routing: `/login` → role-based redirect → `/director` or `/store/:slug`
- Where the SSE handling for the kiosk live ticker lives
- Where the threshold config (discount-watch, rare-drop, pace) lives — environment? config file? DB?
- Build sequence (which view to scaffold first; my preference is director because it's simpler — no animations, no streaming)
- Anything from `dashboard_spec.md` section 9 ("Open product questions") that you'd recommend I decide before you start

**Constraints:**
- Use the same stack and conventions as the existing projects unless you have a specific reason to diverge — and call out divergences explicitly
- Single repo, not a monorepo with the others
- Production target: same hosting as project A
- Auth: same SSO provider as the existing apps

Once you've shared the plan, I'll react and we'll start building. Don't generate any code in this first response.

---

## After the plan is approved — suggested first build task

> Scaffold the project, set up auth + role-based routing, and build the Director view (`/director`) end-to-end against mock data fixtures. Don't wire the live API yet — use static JSON files in `src/fixtures/` that match the proposed API response shapes from `dashboard_spec.md` section 7. We'll wire the real API as task two so we can validate the visual layout against the mocks first.

This gives you a self-contained first deliverable, validates the visual fidelity against the mocks before any backend work, and lets you change your mind on the API shape with low cost.
