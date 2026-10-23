# hypergames-ai.github.io

A single static page: Matrix-style green digital rain across a black viewport, with a centred
panel the rain can't enter. Half the drops that reach the panel's top edge splatter, the rest
slip behind it; every stream carries on behind the panel and re-emerges below it. The whole
composition scales with the window and never scrolls. The panel is a small console that types
out film-style "programs" behind a heartbeat cursor.

No framework, no build step, no network requests.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server
# then visit http://localhost:8000
```

GitHub Pages can serve the repository root as-is.

## Files

| File | What it does |
|---|---|
| `index.html` | Two canvases with the panel between them; inline SVG favicon |
| `style.css` | Fixed full-viewport layers, no scrolling, panel size/centring/border/glow |
| `rain.js` | Config, resize/DPR handling, rain simulation, splashes, render loop |
| `console.js` | Console programs, parser, runner, text layout, heartbeat cursor and WebGL glow |
| `fonts/OFL.txt` | Licence for Courier Prime, the console font (embedded in `style.css`) |

## How it scales

Every size is in `u = max(innerWidth, innerHeight) / 100` (CSS `1vmax`): glyph cells, the
panel's border, glow, padding and font, particle sizes and speeds. Rain speeds are in cells per
second. In a landscape window the column count is constant, so shrinking the window gives the
same picture, smaller.

The panel is `75vw × 50vh` (`50dvh` where supported), defined only in `style.css`. `rain.js`
reads its geometry from the DOM on every resize, so changing the panel's CSS keeps the splashes
aligned.

## Tuning: `CFG` at the top of `rain.js`

| Key | Default | Meaning |
|---|---|---|
| `cellU` | `1.2` | Glyph cell size in `u` (≈23 px on a 1920-wide window, ~84 columns) |
| `minCellPx` | `0` | Minimum cell size in px; `0` = pure scaling |
| `dropsPerColumn` | `3` | Independent drops sharing each column |
| `speedMin`, `speedMax` | `8`, `24` | Drop speed range, cells per second |
| `tailMin`, `tailMax` | `10`, `30` | Cells a head travels past the bottom before the drop recycles (never before its trail has left the screen) |
| `fade` | `0.0645` | Trail decay per simulation step for the shortest trail (higher = shorter) |
| `trailMin`, `trailMax` | `1`, `4` | Each drop's trail length as a multiple of the shortest, on a bell curve between the two |
| `mutate` | `0.02` | Chance per drop, each time it advances a cell, that one trail glyph flickers |
| `maxWait` | `2.0` | Max seconds a finished drop waits before restarting |
| `density` | `1.0` | Fraction of drops that are ever active |
| `splashChance` | `0.5` | Fraction of drops that splatter on reaching the panel; the rest pass behind it |
| `splashMin`, `splashMax` | `8`, `14` | Particles per splash |
| `maxParticles` | `400` | Hard cap on live particles |
| `colors` | head `#e6ffe6`, body `#00ff41`, bg `#000` | Hex colours (`#rrggbb` for head and body) |
| `reducedMotion` | `'auto'` | `'auto'` follows `prefers-reduced-motion`; `true`/`false` force it. Reduced = half density, half speed |

## Console

`console.js` runs programs 0, 1, 2, 3, 0, … from launch. Each program clears the screen, then types
its text one character at a time (`CFG.charMs`, default 18 ms, ±50% jitter). Program syntax:

| In the program text | Effect |
|---|---|
| `\n` | New line |
| `<delay>4000ms</delay>` | Pause; the cursor blinks meanwhile |
| `<cls>` | Clear the screen; the cursor returns to the top left |
| `MM-DD-YY`, `HH:MM:SS` | Replaced with the local date and time when the program starts |

The console is a canvas: text is laid out on a monospace grid in Courier Prime at `1.25vmax`
(18 pt on a 1920-wide window; Japanese falls back to the system CJK font), and WebGL composites it
with the cursor. A two-level bloom (tight halo plus wide haze) is built in but off for now
(`CFG.glow: false`). Cursor proportions were measured from a frame of the film; the colours sit
halfway between the film's pale mint and the rain's green. The cursor is a block about 1.75
characters wide: steady while typing; when idle it beats every 900 ms — on for 300 ms, fading out
over 200 ms, then dark for 400 ms. It stays steady under `prefers-reduced-motion`. Without WebGL it falls back to a 2D
canvas. Tuning (`charMs`, `fontVmax`, colours, `glow`, `glowTight`/`glowWide`, `holdMs`, `fadeMs`,
`beatMs`) is in `CFG` at the top of `console.js`; call `MatrixConsole.refresh()` after changing it
at runtime.

## JavaScript API

```js
MatrixRain.stop();                       // pause (stays paused across tab switches)
MatrixRain.start();                      // resume
MatrixRain.setConfig({ density: 0.4 });  // change CFG keys and rebuild
MatrixRain.refresh();                    // re-read panel geometry and rebuild drops

MatrixConsole.run(2);                    // run program 2 now, then carry on cycling from 3
MatrixConsole.programs.push('Wake up<delay>2000ms</delay><cls>');  // add a program to the cycle
MatrixConsole.stop();  MatrixConsole.start();
```

## Notes

- Simulation runs at a fixed 60 Hz and the rain is redrawn from simulation state, so it looks
  the same on 60 Hz and 120 Hz displays. Each drop's trail fades at its own rate. The loop
  stops while the tab is hidden and doesn't catch up on return.
- Device pixel ratio is capped at 2.
- Glyphs are pre-rendered (mirrored) to a sprite sheet on each resize. The half-width katakana
  come from the system's CJK fallback font, which macOS, Windows, iOS and Android have; on a
  Linux machine without CJK fonts they may render as boxes.
- Courier Prime (latin subset from Google Fonts) is embedded in `style.css` as a data URI because
  Chrome refuses to load font files from `file://`. The console pauses while the tab is hidden.
