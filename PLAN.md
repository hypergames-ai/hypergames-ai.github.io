# Matrix Rain Home Page — Implementation Plan

Single static page: black background, Matrix-style green digital rain across the whole viewport, and a centered rectangular panel (the "rect") that the rain can't enter. Drops that reach the panel's top edge splatter; the stream continues *behind* the panel and re-emerges below it. The whole composition scales with the browser window — nothing scrolls. The panel is a real DOM element so it can become an interactive text box later.

No framework, no build step. Three files; opens from `file://` or any static host.

---

## 1. Decisions and assumptions — read before coding

1. **Scaling model.** "The larger dimension determines the scale factor" is implemented as a scale unit **`u = max(innerWidth, innerHeight) / 100`** — the same thing as CSS `1vmax`. Every size in the design (glyph cell, border, glow, particle size, future text size) is expressed in `u`/`vmax`; speeds are in *cells per second*, so motion scales automatically. The panel is `75vw × 33vh`, centered. Shrinking the window shrinks everything proportionally; nothing scrolls or clips. In a landscape window the column count is constant (≈ `100 / cellU`), so the picture is literally the same picture, smaller.
   - *Alternative, if this reading is wrong:* a fixed-aspect virtual screen (e.g. 16:9) uniformly scaled to fit the window with black letterbox bars. Only §3.4 (the `u` and column-count formulas) and the panel's CSS would change; the rain and splash logic are unaffected.
2. **Panel = DOM, rain = canvas.** The panel is a `<div>` with an opaque black background layered over the rain canvas. Occlusion is free, and interactivity later is ordinary HTML (`<textarea>` / `contenteditable`), not text drawn on a canvas.
3. **Two canvases.** `#rain` sits *behind* the panel and uses the classic fade-to-black trail trick (never cleared). `#fx` sits *above* the panel, is cleared every frame, and draws the splatter particles — so splashes render in front of the panel's top edge and don't leave smeared trails.
4. **Panel look.** Opaque black with a faint green border and a soft outer glow, so the panel reads as a surface even where no rain happens to be falling at the moment. Both are config toggles (set the glow to 0 and the border alpha to 0 for a pure black void).
5. **Rain continues behind the panel.** Columns are simulated over the full viewport height; the panel merely hides the middle. Only the head crossing the *top* edge triggers a splash. Nothing happens at the bottom edge — the stream just becomes visible again.
6. **Frame-rate independence.** Simulation runs on a fixed 60 Hz timestep inside `requestAnimationFrame`; the trail fade is applied per *simulation step*, not per rendered frame, so trails are identical on 60 Hz and 120 Hz displays.
7. **Pure scaling, no floors by default.** Glyphs keep shrinking with the window, per spec. A `minCellPx` config (default `0`) exists if tiny windows ever need it.

## 2. Files

```
index.html   markup: two canvases + the panel div; loads style.css and rain.js
style.css    layout: fixed full-viewport composition, no scroll, panel sizing/centering, border/glow
rain.js      CFG object, viewport/scale handling, rain simulation, splash particles, render loop
README.md    what it is, how to run (open index.html, or `python3 -m http.server`), the CFG knobs
```

## 3. Layout and scaling

### 3.1 Page
- `html, body { margin:0; height:100%; overflow:hidden; background:#000; }`
- Every layer is `position:fixed; inset:0`, so the document is never taller than the viewport and there is nothing to scroll.
- `<meta name="viewport" content="width=device-width, initial-scale=1">` and `<meta name="theme-color" content="#000000">`.

### 3.2 Layers
| z | element | notes |
|---|---|---|
| 0 | `canvas#rain` | fixed, inset 0, `pointer-events:none`; trails live here, never cleared except on resize |
| 1 | `div#panel` | fixed, centered, opaque; the only element that will ever receive input |
| 2 | `canvas#fx` | fixed, inset 0, `pointer-events:none`, transparent, cleared each frame; splashes only |

### 3.3 Panel
```css
#panel {
  position: fixed; left: 50%; top: 50%;
  width: 75vw;
  height: 33vh; height: 33dvh;                         /* dvh where supported (mobile URL bar) */
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  background: #000;
  border: 0.12vmax solid rgba(0, 255, 65, 0.35);
  box-shadow: 0 0 2.5vmax rgba(0, 255, 65, 0.18);
  padding: 1.5vmax;                                    /* room for future text */
  font: 1.8vmax/1.4 ui-monospace, Menlo, Consolas, monospace;
  color: #00ff41;
}
```
All units are `vw` / `vh` / `vmax`, so CSS does the scaling. JS never sets the panel's size — it *reads* the panel's geometry with `getBoundingClientRect()` on every resize. The DOM is the single source of truth for where splashes happen, so changing the panel's CSS later can't desync the effect.

### 3.4 Canvas sizing, DPR, resize
On load and on resize (debounced ~100 ms; also listen to `visualViewport` `resize` for mobile URL-bar changes):
```
dpr  = min(devicePixelRatio, 2)
w, h = innerWidth, innerHeight
u    = max(w, h) / 100
for each canvas: width = w*dpr, height = h*dpr, style.width = w+'px', style.height = h+'px'
                 ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
cell = max(CFG.cellU * u, CFG.minCellPx)
cols = ceil(w / cell);  rows = ceil(h / cell)
panelRect = #panel.getBoundingClientRect()
set ctx.font = `${cell}px …`, textBaseline = 'top'   (once, here — not per glyph)
rebuild glyph sprites at the new cell size (M4)
```
Resizing a canvas clears it, so trails vanish for a moment. Keep the column *state* across a resize when `cols` is unchanged (positions are in cells, so they stay valid); rebuild columns only when `cols` changes. Trails regrow within ~0.5 s.

## 4. Rain simulation (`rain.js`)

### 4.1 Column state
```
{
  x,          // column index; pixel x = x * cell
  y,          // head position in cells (float); starts at rand(-30, -2)
  speed,      // cells per second, rand(CFG.speedMin, CFG.speedMax)
  lastCell,   // last integer cell drawn — draw exactly once per cell
  tail,       // cells to travel past the bottom before recycling, rand(CFG.tailMin, CFG.tailMax)
  state,      // 'falling' | 'waiting'
  waitUntil,  // for 'waiting'
  splashed,   // true once this pass has hit the panel; reset on recycle
}
```
Stagger `y` and `speed` per column; identical speeds read as a scrolling texture, not rain.

### 4.2 Glyphs
- Set: half-width katakana `U+FF66`–`U+FF9D`, digits `0–9`, a few ASCII (`: . " = * + - < > |`). Build the string once.
- Drawn mirrored horizontally (the film look).
- Colors: head `#e6ffe6` (near-white), body `#00ff41` (Matrix green), background `#000`.
- M2: `fillText` with `ctx.scale(-1, 1)` around each glyph. M4: pre-render every glyph in both colors to an offscreen sprite sheet at the current cell size (rebuilt on resize) and `drawImage` — faster than `fillText` through a CJK fallback font.

### 4.3 One simulation step (dt = 1/60 s)
1. **Fade:** `fillStyle = rgba(0,0,0,CFG.fade)`, `fillRect(0,0,w,h)` on `#rain`. This *is* the trail mechanism; the canvas is never otherwise cleared.
2. **Advance** each `falling` column: `y += speed * dt`. When `floor(y) > lastCell`:
   - redraw the previous head cell in **body** green (it is no longer the head);
   - draw the new head cell at `floor(y)` with a random glyph in **head** white-green;
   - `lastCell = floor(y)`;
   - with probability `CFG.mutate`, redraw one random cell in the ~12 cells above the head with a new glyph in body green (the flicker).
3. **Recycle:** when `y > rows + tail`, set `state = 'waiting'`, `waitUntil = now + rand(0, CFG.maxWait)`. When the wait ends: new `y = rand(-30, -2)`, new `speed`, new `tail`, `splashed = false`, `state = 'falling'`.
4. **Splash check** (§5) for every column that advanced into a new cell this step.

Visible trail length falls out of `fade` × `speed` (fast columns have longer trails, which is the natural look); `tail` only controls recycle timing.

### 4.4 Render loop
```
rAF(now):
  dt   = clamp(now - last, 0, 100)   // ms; clamp prevents a catch-up burst after a tab switch
  acc += dt; last = now
  while acc >= STEP: simulate(); acc -= STEP      // STEP = 1000/60
  renderFx()                                       // particles every frame, on #fx
```
Stop the loop on `document.hidden`; on return, reset `last` before resuming.

## 5. Panel occlusion and splatter

- **Occlusion:** nothing to do in JS — the panel is opaque and above `#rain`. Optional micro-optimisation: skip drawing cells that lie entirely inside `panelRect`.
- **Impact detection.** With `top = panelRect.top`, `L = panelRect.left`, `R = panelRect.right`: a column whose pixel `x` is within `[L, R)` splashes when its head cell's *bottom* edge first crosses `top`:
  `!splashed && prevBottom < top && newBottom >= top`, where `bottom = (cellIndex + 1) * cell`. Then `splashed = true`. (Using the cell's bottom edge means the last head glyph is partially cut off by the panel edge — which reads as the impact.)
- **Spawn** `rand(CFG.splashMin, CFG.splashMax)` particles at `(x + cell/2, top)`:
  - velocity: angle `a ∈ [-160°, -20°]` (so `vy < 0`, i.e. up on screen), biased toward -90°; speed `rand(12, 36) * u` px/s; gravity `160 * u` px/s²;
  - lifetime `rand(0.3, 0.7)` s; size `rand(0.15, 0.35) * u`, drawn as small squares (tiny glyph fragments at `0.5 * cell` in M4);
  - colour lerps head → body over its life; alpha fades to 0.
  - Plus a one-cell-wide bright dash on the top edge at the impact `x`, fading over ~200 ms — the "splat".
- Particles render on `#fx` (above the panel), cleared each frame. Cull a particle when its life ends or when it falls back below `top` while within `[L, R)` (it "landed on the panel"). Hard-cap live particles at `CFG.maxParticles` so an ultrawide window can't blow the frame budget.

## 6. Config (top of `rain.js`; all tuning happens here)
```js
const CFG = {
  cellU: 1.2,                 // glyph cell in u  (≈23 px on a 1920-wide window → ~84 columns)
  minCellPx: 0,               // floor in px; 0 = pure scaling, per spec
  speedMin: 8,  speedMax: 24, // cells per second
  tailMin: 10,  tailMax: 30,  // cells past the bottom before recycling
  fade: 0.08,                 // trail fade per simulation step
  mutate: 0.02,               // flicker probability per column per step
  maxWait: 2.0,               // seconds before a finished column restarts
  density: 1.0,               // fraction of columns that are ever active
  splashMin: 8, splashMax: 14,
  maxParticles: 400,
  colors: { head: '#e6ffe6', body: '#00ff41', bg: '#000' },
  reducedMotion: 'auto',      // honours prefers-reduced-motion: halves density and speed
};
```
Expose `window.MatrixRain = { start, stop, setConfig, refresh }` so later interactivity can, say, dim or pause the rain while the user types.

## 7. Build order — one milestone per Claude Code session, verify before the next

**M1 — Static shell.** `index.html`, `style.css`, an empty `rain.js`. Panel centred at `75vw × 33vh` with border and glow. Verify: no scrollbars at any window size; panel stays centred and shrinks on resize; test ultrawide, square and phone-portrait windows.

**M2 — Rain.** Column simulation, fade trails, DPR, fixed timestep, resize handling, visibility pause. Verify: smooth on 60 Hz and 120 Hz with the same trail length; shrinking a landscape window shrinks the glyphs and keeps the column count; Chrome's Performance panel shows the rAF callback well under 2 ms; a background tab uses no CPU; returning to the tab produces no burst.

**M3 — Panel + splatter.** Impact detection from `getBoundingClientRect`, particles on `#fx`, the splat dash. Verify: no glyphs visible inside the panel at any size; every column within the panel's width splashes exactly once per pass, at the top edge; columns outside the panel's width never splash; streams re-emerge below the panel; particles never render inside the panel.

**M4 — Polish.** Sprite-sheet glyphs, mirrored katakana, flicker, reduced-motion, mobile `visualViewport` handling, `<title>`, favicon, README.

**M5 — Hand-off check (no new features).** Panel accepts focus and pointer events (both canvases are `pointer-events:none`); the `MatrixRain` API works; changing the panel's size in CSS alone keeps splashes aligned.

## 8. Acceptance checklist
- [ ] No scrollbars at any window size or aspect; nothing clips.
- [ ] Shrinking the window shrinks glyphs, trails, splashes and the panel proportionally.
- [ ] Panel is always 75% × 33% of the viewport, centred.
- [ ] No rain inside the panel; rain visible above and below; splashes exactly at the top edge, only across the panel's width.
- [ ] Trail length and speed identical at 60 Hz and 120 Hz; no burst after a tab switch.
- [ ] Crisp on Retina; DPR capped at 2.
- [ ] Works from `file://` and from a static host; Chrome, Safari, Firefox; iOS Safari with no bottom gap.
- [ ] `prefers-reduced-motion` reduces density and speed.

## 9. Gotchas for the implementer
- Never `clearRect` the rain canvas per frame — the fade fill *is* the trail. Clear only on resize.
- Apply the fade once per simulation step, not per rAF frame, or trails are half as long on 120 Hz.
- Set `ctx.font` and `textBaseline` once per resize, not per glyph.
- Size canvases from `innerWidth` / `innerHeight`, not from CSS `vh` math; cap DPR at 2.
- Read panel geometry from the DOM; never duplicate `75% / 33%` in JS.
- At 60 steps/s a head moves at most 0.4 cell per step, so "one cell per step" holds; if `speedMax` is ever raised past 60, loop from `lastCell + 1` to `floor(y)` instead.
- Half-width katakana need a font that has them. The system monospace stack falls through to a CJK font on macOS, Windows and iOS; check for tofu on Linux (fallback: digits + ASCII only, or load Noto Sans JP from Google Fonts — a network dependency).
- The panel's glow extends outside it and slightly tints the rain beneath; that's intended.

## 10. Kickoff prompt for Claude Code
> Read PLAN.md in full. Implement milestone M1 only, exactly as specified in §2–3. Don't start the rain yet. When done, tell me how you verified the no-scroll and resize behaviour, then stop so I can check it in a browser.

Then M2, M3, … one at a time, with the same "stop and let me check" instruction each time.