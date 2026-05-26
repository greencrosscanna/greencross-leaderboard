# Avatar picker — implementation notes

The mock (`mocks/avatar_picker_mock.html`) is the visual source of truth. Open it in a browser to interact with the picker. The notes below cover what Code needs to wire up in the real app.

## 1. What we're building

A settings page where employees build a personal avatar. The avatar replaces the initials puck everywhere on the leaderboard (today: the small initials chip; eventually: the big Today's Leader puck too).

- **Avatar source**: DiceBear Avataaars v9 (free, no auth, SVG via HTTP)
- **Style**: cartoon faces, curated option set for workplace context
- **Rendering**: every avatar is just a URL. No library, no build step. `<img src="https://api.dicebear.com/9.x/avataaars/svg?seed=...&...config">` is all it takes.

## 2. Data model

One column per employee: `avatar_config` (JSON object, or a serialized querystring fragment — picker writes JSON, either works).

Keys and an example value:

```json
{
  "skinColor": "edb98a",
  "top": "shortFlat",
  "hairColor": "2c1b18",
  "eyes": "default",
  "eyebrows": "default",
  "mouth": "smile",
  "facialHair": "_none",
  "facialHairColor": "2c1b18",
  "clothing": "hoodie",
  "clothesColor": "3c4f5c",
  "accessories": "_none",
  "accessoriesColor": "262e33"
}
```

Where it lives: TBD. Best guess is a new column on the employee row in the Apps Script Sheet backend. If `avatar_config` is null/empty, render the existing initials puck — that's the fallback everywhere.

## 3. URL building

The mock's `buildUrl(config)` function is the canonical implementation — copy it. Three rules it encodes:

- `_none` in `top`, `facialHair`, or `accessories` means "feature off." Translate to `topProbability=0` / `facialHairProbability=0` / `accessoriesProbability=0`. Don't send `*Color` when the feature is off.
- Otherwise send `*Probability=100` so the feature is guaranteed to show.
- `seed` should be a stable per-employee string. Employee id is fine.

## 4. The settings page

Match the mock exactly:

- Two-column layout (preview left, controls right). Single-column under 880px.
- Three tabs: Face / Hair / Extras (extras = clothing + accessories).
- Big avatar preview sits on the same green radial gradient as the Today's Leader puck. Gradient + glow CSS are in `.avatar-frame` in the mock.
- "Surprise me" reroll, "Save" primary action.
- Leaderboard preview block under the avatar so users see how it'll look in context (one row stays as initials so they can compare).

The `OPTIONS` object in the mock script is the curated/filtered list — copy as-is. Filtering options later is just deleting strings from those arrays.

## 5. Leaderboard integration

Wherever the leaderboard currently renders an initials chip, swap to:

```html
<div class="avatar-puck">
  {employee.avatar_config
    ? <img src={buildUrl(employee.avatar_config)} alt={employee.name} />
    : <span class="initials">{getInitials(employee.name)}</span>}
</div>
```

The `.avatar-puck` container keeps the green radial gradient (CSS in mock's `.lb-ava`). The img sits on top, transparent edges showing the gradient through — matches the existing leader puck visual treatment.

## 6. Fallbacks & edge cases

- Empty `avatar_config` → render initials (existing behavior).
- DiceBear API errors → `<img onerror>` falls back to initials.
- First-time employee → leaderboard shows initials until they visit settings and save.
- Partial config (missing keys) → DiceBear randomizes unset fields from the seed; render anyway.

## 7. Out of scope for this pass

- Onboarding flow that nudges new employees to set an avatar (handle later).
- Photo uploads (avatars are illustrated only).
- Animating the avatar.
- Replacing the big Today's Leader avatar specifically (do that after the small leaderboard chips are working — same component, just sized up).

## 8. Build sequence

1. Read the mock end-to-end. Confirm option set, gradient, layout match this doc.
2. Decide where `avatar_config` lives in the data layer. Add migration if needed.
3. Build the settings route + picker UI. Reuse `OPTIONS`, `humanize()`, `buildUrl()` from the mock script.
4. Wire Save to the real persistence layer.
5. Swap leaderboard initials → `<img>` with initials fallback.
6. Test end-to-end with one employee before rolling out store-wide.
