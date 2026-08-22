# Employee of the Month — implementation notes

Mock: `mocks/eom_card_mock.html`. Open it to interact with the treatment.

## 1. What we're building

A single employee per month is designated as Employee of the Month from a setting in the admin/settings page. Their leaderboard card gets card-level chrome (animated gold ring, gold accents, EoM pill). The treatment travels with them anywhere a leaderboard card renders — kiosk, director view, monthly recap — and persists for the month regardless of where they rank day to day or whether they're on shift.

No new card slot, no new layout. It's purely additive decoration on the existing card component.

## 2. Data model

ScriptProperties — same pattern as nicknames, avatars, goals.

```
gc_eom_current = {
  employeeKey: "sam-kowalski",   // nameToKey_() of the featured employee
  since: "2026-05-01T08:00:00Z"  // when the selection was made
}
```

Empty / unset = no one is featured this month. Don't render the chrome on any card.

Only one employee at a time — selecting a new EoM overwrites. No history tracking in this pass (we can layer that in later if you want a "Past EoMs" page).

## 3. Files touched

**`dutchie_proxy.gs`**
- New constant `GC_EOM_KEY = 'gc_eom_current'`
- New helper `getEomCurrent_()` — reads and parses the property, returns `{ employeeKey, since } | null`
- New action `saveeom` — accepts `{ key }` or `{ key: null }` to clear. Writes `{ employeeKey: key, since: now }`
- All leaderboard endpoints (`directorall`, `leaderboardday`, `leaderboardperiod`, `kiosk`) add `eomKey` to their response (just the string key, or null)
- `getSettings_` returns `eom: { employeeKey, since }` alongside the existing settings

**`src/leaderboard/leaderboard.css`**
- Copy the full `.card.eom` block from the mock verbatim — `@property --angle`, `@keyframes border-spin`, `.card.eom::before` pseudo-element with mask-composite, gold accents on name/metric/progress/avatar ring, corner stack with EoM pill + rank
- Also copy the `.card.off.eom` composition rules so off-shift EoM keeps the gold ring with a dimmed interior
- 8s rotation is the current calibration; keep it

**`src/leaderboard/leaderboard.js`**
- When rendering each card, check `eomKey === employee.key` → add `eom` class to the card root
- When EoM, replace the in-flow `.rank` element with the corner stack (`<div class="corner"><span class="eom-badge">…</span><span class="rank">#N today</span></div>`)
- Off-shift EoM: still apply the `eom` class on top of `off`; CSS handles composition

**`src/settings/settings.js`**
- New "Employee of the Month" section in Settings
- Currently-featured callout at top (avatar + name + store + "Featured since {date}" + Clear button) — only shown if an EoM is set
- Below: list of all employees with radio-style selection. Click an employee → POST `saveeom` with that key → re-fetch, re-render
- Clear button → POST `saveeom` with `{ key: null }`

**`src/utils.js`** (or wherever shared helpers live)
- No changes needed if `nameToKey_` is already exposed there

## 4. CSS — critical bits to copy exactly

The animated ring uses `@property` for the gradient angle (modern browsers support it; older ones gracefully degrade to a static gold border). The mask-composite technique creates the border-only effect:

```css
@property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
@keyframes border-spin { to { --angle: 360deg; } }

.card.eom::before {
  content: '';
  position: absolute; inset: 0;
  padding: 1.5px; border-radius: inherit;
  background: conic-gradient(from var(--angle),
    rgba(212, 168, 71, 0.30) 0deg,
    rgba(212, 168, 71, 0.30) 270deg,
    var(--gold-bright) 320deg,
    rgba(212, 168, 71, 0.30) 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  animation: border-spin 8s linear infinite;
  pointer-events: none;
}
```

Don't change `padding: 1.5px` without testing — too thin disappears, too thick looks like a halo.

## 5. Composition rules

The `eom` class composes with existing card states:
- `.card.eom` alone → animated gold ring + gold accents
- `.card.leader.eom` → gold ring takes priority over green border (CSS specificity handles this)
- `.card.off.eom` → gold ring still animates, interior content stays dimmed (off-shift styling preserved)

Cards stay in rank order. EoM doesn't promote the employee to slot #1 — recognition is in the chrome, not the position.

## 6. Where the chrome appears

Anywhere a `.card` for a leaderboard employee is rendered. As of this pass that's:
- Today's kiosk view (all 6 store cards)
- Monthly leaderboard
- Director all-stores view (if cards render there)

If the daily kiosk and monthly leaderboard use different DOM, apply the `eom` class in both render paths.

## 7. Edge cases

- **No EoM set** → `eomKey === null`, no card gets the class, no chrome anywhere. Normal leaderboard.
- **EoM employee has no nickname/avatar** → still works. Chrome doesn't depend on avatar presence.
- **EoM employee is off shift** → gold ring still animates on their card, interior dimmed.
- **EoM employee is also today's leader** → gold ring + EoM pill. The `.card.leader` green border is hidden under gold ring (mask-composite border has higher visual priority).
- **EoM employee is no longer at this store / left the company** → admin sets `saveeom` to null in settings; chrome disappears next render.

## 8. Out of scope for this pass

- Automatic EoM rollover on the 1st (manual selection only — you swap or clear via Settings)
- "Past Employees of the Month" history page
- Custom EoM message / quote / photo
- Notifications when an employee is named EoM
- EoM badge on the avatar's profile separate from the leaderboard

## 9. Build sequence

1. Read the mock end-to-end. Confirm the animation, gold color, corner stack, off-shift composition match the spec.
2. Add `gc_eom_current` to ScriptProperties via `getEomCurrent_()`, `saveeom` action, endpoint augmentation.
3. Copy the `.card.eom` CSS into `leaderboard.css` verbatim.
4. Update the card render in `leaderboard.js` to add the `eom` class + corner stack when `eomKey` matches.
5. Build the Settings section: currently-featured callout + radio list + Clear.
6. Test end-to-end: set Sam, see her card light up across all views; clear, see chrome disappear; check off-shift case.
