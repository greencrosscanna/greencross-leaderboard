# Kiosk Hero Row — Redesign Notes for Code

**Companion file:** `kiosk_hero_redesign.html` (visual source of truth)
**Files to modify:** `src/kiosk/kiosk.css`, `src/kiosk/kiosk.js`

## The change in one sentence

All three hero cards now share the same vertical skeleton — *label → main content → horizontal rule → 3-stat row* — so the eye reads them as a single unit, and the Today's Leader card is no longer dead space.

## 1. Today's Leader — fill the space with motivating signal

The current card has too much white space and too little context. Add four things:

### 1a. Two status chips in the top-right corner

Inline with the "Today's Leader" label, right-aligned:

- `👑 Leading since 1:34 PM` — yellow chip (`var(--yellow)`)
- `🔥 2-day streak` — orange chip (`var(--orange)`)

These give the leader's run *narrative* — how long they've been on top, and that they've been on a hot stretch. The "Leading since" timestamp comes from the most recent rank change in the leaderboard data.

### 1b. Restore the secondary stat line under the role

Below "Budtender", show: `20 txns · $55.51 AOV · 4.3 UPT`. This already existed in the current implementation but got demoted; bring it back as a context line.

### 1c. Add a 3-stat row at the bottom (NEW)

This is the biggest change. Below a horizontal rule, render three stats that mirror the Daily Goal card's bottom row:

| Stat | Value | Label |
|------|-------|-------|
| Lead margin | `+$448` (green) | Ahead of #2 |
| Current pace | `$211/hr` | Current pace |
| Trophies | `4/6` (yellow + muted) | Trophies today |

These should reuse the same `.kcard-stats` + `.kstat` structure as the gauge cards (see section 4 below) so all three cards line up perfectly.

### 1d. Visual polish

- Avatar pulse animation (3s cycle, scales the outer glow `box-shadow`)
- Slow-rotating conic-gradient "rays" behind the avatar (14s rotation, low alpha)
- Pulse the `$1,110` amount once whenever a new sale lands for the leader (hook into the existing live-sales event handler)

All polish is CSS-only — no new JS dependencies.

## 2. Pace · vs. Plan — align to Daily Goal, drop the needle

The pace card today has the −22% sitting at the bottom of the card, the gauge labels below the arc, and a needle that competes with the centered number for attention. The fix is structural — make Pace visually parallel to Daily Goal and replace the needle with a calmer indicator.

### 2a. Same gauge dimensions

Both `.gauge-wrap` and `.pace-gauge-wrap` should be `width: 240px; height: 130px`, with the SVG at the same `viewBox="0 0 240 130"` and the same background arc path: `M 22 122 A 98 98 0 0 1 218 122`. Today they differ — pace SVG is 148px tall to make room for tick labels — and that's what breaks the cross-card hrule alignment.

### 2b. Move the big number into the same position as Daily Goal

`.gauge-pct` with `position: absolute; bottom: 4px` works for both cards once the SVGs are the same size. The `−22%` should sit in the same vertical well where `43%` sits in Daily Goal.

### 2c. Drop the needle, keep the colored zones, add a tick indicator

Replace the needle-with-line with a **single tick mark riding on the arc itself**. The line-from-center is what made the old version distracting — the tick on its own preserves the position indication without the visual weight.

**Layout, top to bottom:**

1. **Background track** — same neutral gray arc as Daily Goal
2. **3-zone color band** layered on top of the track, opacity ~0.62, split into thirds:
   - Red:   from `(22, 122)` to `(71, 37)` — leftmost third
   - Amber: from `(71, 37)` to `(169, 37)` — middle third
   - Green: from `(169, 37)` to `(218, 122)` — rightmost third
3. **Apex anchor tick** — a tiny 8px vertical mark above the apex in `var(--text-mute)`, anchors "on plan"
4. **Position indicator** — a perpendicular pill (10×22 rounded rect) that rides on the arc, with a soft dark backing to lift it off the colored band

**Scale mapping (PACE_RANGE = 80):**

The arc spans `pace ∈ [-80%, +80%]` mapped to rotation `[-90°, +90°]` around the arc's center `(120, 122)`.

| Pace   | Rotation | Clock position  | Zone  |
|--------|----------|-----------------|-------|
| −80%   | −90°     | 9 o'clock       | Red   |
| −27%   | −30°     | ~10 o'clock     | Red/Amber boundary |
| −22%   | −24.75°  | ~11 o'clock     | Amber |
| 0%     | 0°       | 12 o'clock      | Amber center |
| +22%   | +24.75°  | ~1 o'clock      | Amber |
| +27%   | +30°     | ~2 o'clock      | Amber/Green boundary |
| +80%   | +90°     | 3 o'clock       | Green |

`PACE_RANGE` is a single tunable. Lower values (e.g. 50) make the gauge more sensitive to small deviations; higher values (100, 120) compress the indicator toward the center for the typical day. 80 feels right for daily-sales context — meaningful deviations push the tick to a clearly-different position without exaggerating noise.

**Indicator SVG + animation:**
```
<g id="paceTick" style="transform-origin: 120px 122px; transform: rotate(0deg);
                       transition: transform 1.4s cubic-bezier(.2,.7,.3,1);">
  <!-- Dark backing for contrast against any zone color -->
  <rect x="113" y="11" width="14" height="26" rx="7" fill="#0a0e0d" opacity="0.55"/>
  <!-- Pill -->
  <rect x="115" y="13" width="10" height="22" rx="5"
        fill="#e6ece9" stroke="#0a0e0d" stroke-width="1.5"/>
</g>
```
The pill is anchored at the apex `(120, 24)` and rotated around the arc's center `(120, 122)`. Because the rotation is applied to the whole group, the pill stays perpendicular to the arc (radially aligned) as it sweeps.

**Alternative indicator shapes** — easy to swap if you want a different feel later:
- **Bare perpendicular dash** — remove the rect, use a 4px-wide `<line>` from `(120, 14)` to `(120, 34)` with a dark backing line behind it. More utilitarian.
- **Chevron** — replace with a `<path d="M115,16 L120,11 L125,16"/>` (and a mirrored one below the arc) for a "look at me" pointer feel.
- **Larger pill** — bump the dimensions to `12×26` if the current size reads too thin on iPad at distance.

### 2e. Color the big number by zone, not by direction

The centered `−22%` reads as a status indicator, so its color should match the zone the tick lands in — not the sign of the pace. At pace = −22% with `PACE_RANGE = 80`, the tick is in the **amber** zone, so the number is amber. At pace = −50% the same logic puts it in **red**.

CSS:
```css
.gp-big.zone-red   { color: var(--red); }
.gp-big.zone-amber { color: var(--amber); }
.gp-big.zone-green { color: var(--green); }
```

JS — derive the zone from the current pace and `PACE_RANGE`:
```javascript
function paceZone(pace, range = PACE_RANGE) {
  // Zones split the half-arc into thirds.
  const t = Math.abs(pace) / range;       // 0 = at center, 1 = at the end
  if (t > 2/3) return 'red';              // past 2/3 of the way → red
  if (t > 1/3) return pace < 0 ? 'amber' : 'amber';   // 1/3 to 2/3 → amber
  return pace < 0 ? 'amber' : 'amber';    // inside 1/3 → still amber (close to plan)
}
// (Simplified — only positions past 2/3 of range hit red on the negative side,
//  and past 2/3 on the positive side hit green. Refine to taste.)
```

A cleaner version that maps to the actual visual zones:
```javascript
function paceZone(pace, range = PACE_RANGE) {
  // angle the tick will sit at, in degrees (matches the indicator math)
  const deg = (Math.max(-range, Math.min(range, pace)) / range) * 90;
  if (deg <= -30) return 'red';     // tick is in the leftmost third of the arc
  if (deg >=  30) return 'green';   // tick is in the rightmost third
  return 'amber';                   // tick is in the middle third
}
```

Apply the class to the big number and color the subtitle to match:
```javascript
const zone = paceZone(pace);
gpBig.className = `gp-big num zone-${zone}`;
gpSmall.style.color = `var(--${zone === 'amber' ? 'amber' : (zone === 'red' ? 'red' : 'green')})`;
```

If you want the bottom-row stats (`Short by $957`, `Status: Behind`) to also reflect the zone color rather than always-red, apply the same class strategy to `.kstat-v`. That's a stylistic call — leaving them always-red emphasizes "you owe sales"; making them zone-colored makes the whole card feel calmer when you're close to plan.

In JS:
```javascript
const PACE_RANGE = 100;  // or 80 for a more sensitive gauge
const clamped = Math.max(-PACE_RANGE, Math.min(PACE_RANGE, pace));
const deg = (clamped / PACE_RANGE) * 90;
document.getElementById('paceTick').style.transform = `rotate(${deg}deg)`;
```

**Why this works:**
- Color band gives at-a-glance read of severity ("you're in the amber zone")
- Tick gives precise position without a heavy line pulling toward center
- Apex tick implicitly says "this is where on-plan lives"
- Big `−22%` number is the headline; everything else supports it

### 2d. Same 3-stat bottom row

Replace the current "Projected close $3,477 · ▼ $957 short" sentence with the same `.kcard-stats` structure:

| Stat | Value | Label |
|------|-------|-------|
| Projected | `$3,477` | Projected |
| Gap | `$957` (red) | Short by |
| Status | `Behind` (red, smaller font) | Status |

## 3. Daily Goal — minor tuning only

Bump the gauge from `width: 220px` to `width: 240px` and `height` to `130px` (was untracked / auto). This is just to match the pace gauge dimensions so both arcs render identical. The big `%` should sit at `bottom: 4px` of the wrap. Everything else in the Daily Goal card stays.

## 4. Recommended shared CSS (new utility)

Add a `.kcard-stats` block to `kiosk.css` (or to a new shared spot) so all three cards use the same bottom-row treatment:

```css
.kcard-stats {
  display: flex;
  justify-content: space-around;
  width: 100%;
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.kstat { text-align: center; }
.kstat-v {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.3px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.kstat-l {
  font-size: 10px;
  color: var(--text-mute);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 6px;
  font-weight: 600;
}
.kstat.up   .kstat-v { color: var(--green); }
.kstat.down .kstat-v { color: var(--red); }
.kstat.warn .kstat-v { color: var(--amber); }
```

The existing `.goal-stats / .gs-v / .gs-l` can be aliased to these classes, or deleted in favor of `.kcard-stats / .kstat-v / .kstat-l` to keep the codebase consistent.

## 5. Data wiring (kiosk.js)

The new Today's Leader card needs three derived values that should be computed once per render from data Code already has:

```javascript
// Lead margin: leader.todaySales - secondPlace.todaySales
const leadMargin = leaderRow.todaySales - sorted[1].todaySales;

// Current pace ($/hr): leader.todaySales / (hours_into_their_shift)
const hoursOnShift = (now - leader.shiftStart) / 3_600_000;
const currentPace = leader.todaySales / Math.max(hoursOnShift, 0.5);

// Leading since: walk the rolling rank history and find when leader.id last became #1
const leadingSince = findLastRankChange(leader.id, '#1');

// Trophies leading today: count weekly trophies currently held by leader.id
const trophiesToday = weeklyTrophies.filter(t => t.holderId === leader.id).length;
```

If your data layer doesn't track rolling rank history, V1 fallback for "Leading since" is simply: time of the leader's first transaction that put them above the previous #1. Compute server-side or on the kiosk poll cycle — doesn't need to be precise to the minute, just close.

## 6. iPad considerations

The redesigned hero row still fits comfortably at iPad landscape widths (1180–1366px). The leader card's three bottom stats are the only risk — at 1180px the leader card is roughly 580px wide, so each stat gets ~180px. That's fine. At 1024px (older iPad portrait), consider stacking the chips vertically or hiding the streak chip.

Add a media query if needed:
```css
@media (max-width: 1100px) {
  .leader-chips { flex-direction: column; align-items: flex-end; }
  .leader-name { font-size: 24px; }
  .leader-amount { font-size: 38px; }
}
```

## 7. What I deliberately didn't touch

- The `closing-push` banner — that's a great addition, leave it
- `emp-card.off-shift` styling — you confirmed you like the current treatment
- Heatmap, ticker, badges, trophies grid — out of scope for this pass
- Photo/avatar swap — v2, per your note

## 8. Build sequence I'd suggest for Code

1. Add the shared `.kcard-stats / .kstat-*` block to kiosk.css
2. Refactor Daily Goal's `.goal-stats` to use the new classes (or alias)
3. Resize the gauge SVG to 240×130 in both Daily Goal and Pace
4. Strip the −20% / +20% / PLAN labels from the pace SVG; move the number to the same absolute position as Daily Goal
5. Rebuild the Today's Leader card per section 1
6. Wire `leadMargin / currentPace / trophiesToday / leadingSince` in kiosk.js
7. Visually verify against `kiosk_hero_redesign.html` rendered side-by-side
