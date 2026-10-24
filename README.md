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
| `startDelayMs` | `1500` | Milliseconds of black screen after load before the rain begins |

## Console

`console.js` runs programs 0–5 once from launch, then leaves the screen as the last one left
it. Each program clears the screen, then types
its text one character at a time (`CFG.charMs`, default 18 ms, ±50% jitter). Program syntax:

| In the program text | Effect |
|---|---|
| `\n` | New line |
| `<delay>4000ms</delay>` | Pause; the cursor blinks meanwhile |
| `<cls>` | Clear the screen; the cursor returns to the top left |
| `<replace hold="2000ms">old<with hold="1000ms">new</replace>` | Type *old*, hold, backspace it one character at a time (`CFG.eraseMinMs`–`eraseMaxMs`, 30–100 ms apart), hold again, then type *new*. Both holds are optional |
| `MM-DD-YY`, `HH:MM:SS`, `HH:MM` | Replaced with the local date and time when the program starts |
| `<tag>label</tag>` (very first characters) | Names the program, for links; label is `a-z`, `0-9`, `_`. Not displayed |
| `<prog ref="label">text</prog>` | A clickable, underlined link to the program tagged *label* (no tags inside *text*). Grey, still underlined, and inert if no program has that tag |
| `<prog ref="label" one-way>text</prog>` | Same, but the linked program shows without `< BACK` and becomes the base page: the nav stack starts over from it |
| `<stop/>` (very last characters) | The startup sequence stops after this program |
| `<stop make-cookie/>` (very last characters) | Same, and sets the returning-visitor flag when the program finishes (any completed render, however it was reached) |
| `<landing/>` (very first characters, before any `<tag>`) | Marks the landing program for returning visitors. Not displayed; even a leading space disables it |
| `<delete-cookie/>` | Clears the returning-visitor flag at that point in the program |
| `<a href="files/report.pdf">text</a>` | A web link, underlined. Relative hrefs (no leading `/`) resolve against the page, so they work on localhost, GitHub Pages and `file://`; absolute `https://…` hrefs work too. Opens in the same tab (Ctrl/Cmd- or middle-click: new tab) |
| `<a href="…" download>` / `download="name.pdf"` | Download instead of navigate, optionally saving as *name*. Browsers honour this only for same-origin (relative) links; on an absolute link to another site it just opens |
| `<a href="…" target="_blank">` | Always open in a new tab |
| `<gosub ref="label"/>` | Pastes the program tagged *label* in place, as if written there: its text types and its commands (`<delay>`, `<cls>`, links, `<delete-cookie/>`, …) run inline. Its own `<tag>`/`<landing/>`/`<stop …/>` are ignored. Templates can include templates; cycles and missing refs paste nothing |
| any other `<tag …>` | Not displayed (silently ignored); `<` followed by a space stays literal |

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

**Pages:** clicking a prog-link opens the tagged program on its own, under a typed, clickable
`< BACK` (underlined while hovered); links stack. `< BACK` pops the stack and re-renders the previous
page instantly (with the one-shot flag below). Back on the startup sequence's page, the sequence
carries on after it unless that program ends with `<stop/>` — so programs placed after a `<stop/>`
are reachable only through links.

**One-shot `noDisplayDelay`:** while set, the next program runs with no waits at all — no `<delay>`
pauses, no typing gaps, and no replace effect (only the `<with>` text) — so its final text appears
at once; `<cls>` still clears. It turns itself off once that program finishes. It starts OFF; `< BACK` sets it.

**Templates:** a template is just a tagged program used via `<gosub>`. Since tagged programs also
run in the startup sequence, put templates after a `<stop/>` program so they only appear where
they're included.

**Returning visitors:** the "cookie" is a presence-only flag in `localStorage`
(`hypergames.cookie`), so it also works from `file://`. At launch, if the number of programs starting
with `<landing/>` isn't exactly one, the flag is cleared. With no flag, the console starts at program 0
after the usual rain delay; with the flag, the rain starts immediately and the `<landing/>` program
runs first (as the base page). Clearing the site's data resets it.

## JavaScript API

```js
MatrixRain.stop();                       // pause (stays paused across tab switches)
MatrixRain.start();                      // resume
MatrixRain.setConfig({ density: 0.4 });  // change CFG keys and rebuild
MatrixRain.refresh();                    // re-read panel geometry and rebuild drops

MatrixConsole.run(2);                    // run program 2 now, then the programs after it
MatrixConsole.programs.push('Wake up<delay>2000ms</delay><cls>');  // add a program to the end
MatrixConsole.stop();  MatrixConsole.start();
MatrixConsole.navigate('about');         // open the program tagged "about" (as if its link was clicked)
MatrixConsole.navigate('about', { oneWay: true });  // as a one-way link: no < BACK, stack cleared
MatrixConsole.back();                    // same as clicking < BACK; MatrixConsole.navDepth = stack depth
MatrixConsole.makeCookie(); MatrixConsole.hasCookie(); MatrixConsole.deleteCookie();  // the returning-visitor flag
MatrixConsole.noDisplayDelay = true;     // next program appears at once: no delays or replace effect (one-shot)
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
