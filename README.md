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

The console's font and the panel's padding are the exception in windows wider than 16:9: there they
follow the height instead (as if the window were 16:9), so the panel always fits the same 15 rows
it shows at 1920×1080 and a shorter window shrinks the text rather than losing rows. Narrower and
portrait windows show more rows.

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
| `goldColors` | head `#fff5c2`, body `#ffc800` | Head and body after `<gold-rain>` (`#rrggbb`) |
| `fontWeight` | `400` | Rain glyph weight: `'normal'` (400), `'bold'` (700) or `100`–`900`. In-between weights need the font to have them: the katakana (Hiragino on macOS) do, but Menlo's digits only have regular and bold, switching at 600 |
| `reducedMotion` | `'auto'` | `'auto'` follows `prefers-reduced-motion`; `true`/`false` force it. Reduced = half density, half speed |

## Console

`console.js` runs programs 0–5 once from launch, then leaves the screen as the last one left
it. Each program clears the screen, then types
its text one character at a time (`CFG.charMs`, default 16 ms, ±50% jitter). Program syntax:

| In the program text | Effect |
|---|---|
| `\n` | New line |
| `<delay>4000ms</delay>` | Pause; the cursor blinks meanwhile |
| `<cls>` | Clear the screen; the cursor returns to the top left |
| `<replace hold="2000ms">old<with hold="1000ms">new</replace>` | Type *old*, hold, backspace it one character at a time (`CFG.eraseMinMs`–`eraseMaxMs`, 30–100 ms apart), hold again, then type *new*. Both holds are optional |
| `MM-DD-YY`, `HH:MM:SS`, `HH:MM` | Replaced with the local date and time when the program starts |
| `<tag>label</tag>` (very first characters) | Names the program, for links; label is `a-z`, `0-9`, `_`. Not displayed |
| `<prog ref="label">text</prog>` | A clickable, underlined link to the program tagged *label* (no tags inside *text*), drawn like `<high>` text (lighter green, bold), as `<a>` links are; inside `<grey>` it's grey instead. Grey, still underlined, and inert if no program has that tag |
| `<prog ref="label" one-way>text</prog>` | Same, but the linked program shows without `< BACK` and becomes the base page: the nav stack starts over from it |
| `<prog ref="label" no-stack>text</prog>` | On a page with `< BACK`: the linked program replaces the current page instead of stacking on it, so its `< BACK` goes where the current page's would have. Chain main → a → b → c with no-stack links from a and b, and BACK from any of them returns to main. On the base page (no `< BACK`) it replaces the base page, i.e. acts as `one-way`. With `one-way` too, `one-way` wins |
| `<stop>` (very last characters) | The startup sequence stops after this program |
| `<goto ref="label">` (very last characters, instead of `<stop>`) | When the program finishes, jumps to the program tagged *label* like a one-way link: nav stack cleared, the target becomes the base page and the sequence carries on from it. Doesn't fire if the program is cut short; a missing tag stops like `<stop>`; ignored inside `<gosub>` templates |
| `<stop make-cookie>` (very last characters) | Same, and sets the returning-visitor flag when the program finishes (any completed render, however it was reached) |
| `<landing>` (very first characters, before any `<tag>`) | Marks the landing program for returning visitors. Not displayed; even a leading space disables it |
| `<delete-cookie>` | Clears the returning-visitor flag at that point in the program |
| `<have-cookie>yes<else>no</have-cookie>` | Branches on the returning-visitor flag. When the program starts, before anything else, the block is replaced by *yes* (flag set) or *no* (not set), exactly as written (spaces included), and that text then runs like any other program text: links, `<delay>`, `<gosub>`, even the program's closing `<stop>`, `<stop make-cookie>` or `<goto>`. `<else>` is required (a block without exactly one expands to nothing, with a console warning); either branch may be empty; blocks nest. Evaluated once per run, so a `<delete-cookie>` earlier in the same program doesn't change it (a BACK re-render evaluates it again). Keep `<landing>` and `<tag>` outside it. Templates' blocks resolve the same way |
| `<in-startup>yes<else>no</in-startup>` | Same rules as `<have-cookie>`, branching on whether the startup sequence is still on: true from launch until the sequence ends (a program ending in `<stop>`/`<stop make-cookie>` completes, or the programs run out; a `<goto>` or one-way link carries it on, and pages linked from it still count as in it). False from the start when launch goes straight to the `<landing>` program, and false for good once the sequence has ended. The two kinds nest inside each other |
| `<a href="files/report.pdf">text</a>` | A web link, underlined. Relative hrefs (no leading `/`) resolve against the page, so they work on localhost, GitHub Pages and `file://`; absolute `https://…` hrefs work too. Opens in the same tab (Ctrl/Cmd- or middle-click: new tab) |
| `<a href="…" download>` / `download="name.pdf"` | Download instead of navigate, optionally saving as *name*. Browsers honour this only for same-origin (relative) links; on an absolute link to another site it just opens |
| `<a href="…" target="_blank">` | Always open in a new tab |
| `<gosub ref="label">` | Pastes the program tagged *label* in place, as if written there: its text types and its commands (`<delay>`, `<cls>`, links, `<delete-cookie>`, …) run inline. Its own `<tag>`/`<landing>`/`<stop …>` are ignored. Templates can include templates; cycles and missing refs paste nothing |
| `<bottom-row>`, `<bottom-row delta=-1>` | Moves the write head and cursor to the left edge of the panel's last visible row, or `delta` rows above it (`delta` ≤ 0). Nothing is erased; text written there draws over whatever is on that row. Re-anchors when the window resizes. `<bottom-row delta=1>` parks the cursor one row below the bottom row, out of the way (e.g. as the last thing on a video page); it's a parking spot only, so don't type anything after it (the screen doesn't scroll for it) |
| `<top-row>`, `<top-row delta=2>` | Moves the write head and cursor to the left edge of the panel's top row, or `delta` rows below it (`delta` ≥ 0). Like `<bottom-row>`, nothing is erased. The program is responsible for a row that fits the panel |
| `<center>text</center>` | Centres *text* horizontally on its line: typing starts where the finished line will be centred. Tags inside work as usual (links, `<delay>`, …). The text must fit on one line; it never moves back over text already on that line |
| `<video-embed ref=YOUTUBE_ID>`, `<video-embed ref=YOUTUBE_ID t=90>` | A 16:9 YouTube player (standard embed: click to play; loops; suggestions limited to the same channel; fullscreen allowed; optional `t` = start offset in whole seconds, `90` or `90s`, quotes optional), as large as fits between the write head's row (the next row if the line has text) and the bottom row, which stays free for a label and links: text after the tag goes there; horizontally centred, top-aligned. Put it first to fill the panel; on a page with `< BACK` it starts below that line. The next clear removes it (any navigation, `<cls>`); a second one on the same screen replaces it. YouTube refuses to play it from a `file://` page ("Error 153 … Missing or Blocked Referrer Header"): test with a local server, e.g. `python3 -m http.server 8000`, then open http://localhost:8000 |
| `<image-embed ref="files/image.png">`, `<image-embed ref="files/a.png,files/b.jpg">` | An image (site-relative path with extension, quotes optional) in the same area as `<video-embed>`: from the write head's row (the next row if the line has text) down to just above the bottom row, which stays free for a caption and links (text after the tag goes there). It fills that height, takes its width from its aspect ratio and is centred horizontally; if that's wider than the text area, it shrinks (keeping its ratio, top-aligned) until it fits. Several paths separated by commas show side by side: the text area's width is split evenly between them, less a small gap between neighbours (`CFG.imageGap`, default 2 character widths), and each fits its share as above; the row of them is centred, so the outer margins stay at least the text margin. They appear once all have loaded (a missing file shows nothing, logs a warning and drops out of the row). The next clear removes it (any navigation, `<cls>`); a later image or video on the same screen replaces it. Works from `file://` too |
| `<freakout hold="1500ms" fade="3000ms">text</freakout>` | Types *text* normally; once it's all typed it holds still for `hold`, then shakes (a noisy x/y jiggle of the whole string) and blurs, both ramping up exponentially over `fade`; during the last 20% of `fade` it also fades linearly to invisible, and stays gone (the space it took stays empty). Quotes optional, either order, missing = 0 ms. Plain text only inside. An instant render shows the end state (nothing); under `prefers-reduced-motion` it blurs and fades without shaking |
| `<start-rain>` | Starts the rain: drops begin falling in a staggered wave. No-op if it's already raining. The rain never starts by itself |
| `<stop-rain>` | Stops the rain: drops already falling finish (and splash), no new ones form |
| `<gold-rain>` / `<green-rain>` | Drops that start from here on fall in "mainframe" gold (`goldColors`) / the normal green; drops already falling (and their splashes) keep their colour, so the change spreads as they finish. Green at launch; the colour carries over between programs. With the rain stopped, it sets the colour of the next `<start-rain>` |
| `<slow-spew>` / `<normal-spew>` | From here on, type at `CFG.slowCharMs` (default 60 ms) / back at `CFG.charMs`, both ±50% jitter. Every program starts at normal speed; backspacing and instant renders are unaffected |
| `<grey>text</grey>` | Draws *text* grey (`CFG.grayTextColor`, default 128,128,128) instead of green, to de-emphasise it. Tags inside work as usual: links stay clickable and underlined, just grey (the same grey as a broken link) and not bold. It can span a `<cls>`; the `< BACK` line stays green. Every program starts green, and an unclosed `<grey>` lasts to the end of the program |
| `<high>text</high>` | The opposite of `<grey>`: *text* in a lighter green (`CFG.highTextColor`, default 150,255,180) and bold (Courier Prime Bold, embedded like the regular face; same character widths, so nothing shifts). Links (`<prog>`, `<a>`) are always drawn this way, without the tag (not `< BACK`). Same rules otherwise: tags inside work (links stay clickable, underlined in the high colour), it can span a `<cls>` while `< BACK` stays normal, and every program starts normal. Don't combine it with `<grey>` (grey wins, still bold) |
| any other `<tag …>` | Not displayed (silently ignored); `<` followed by a space stays literal |

The console is a canvas: text is laid out on a monospace grid in Courier Prime at `1.25vmax`
(18 pt on a 1920×1080 window; height-limited beyond 16:9, `CFG.maxAspect`; Japanese falls back to the system CJK font), and WebGL composites it
with the cursor. A two-level bloom (tight halo plus wide haze) is built in but off for now
(`CFG.glow: false`). Cursor proportions were measured from a frame of the film; the colours sit
halfway between the film's pale mint and the rain's green. The cursor is a block about 1.75
characters wide: steady while typing; when idle it beats every 900 ms — on for 300 ms, fading out
over 200 ms, then dark for 400 ms. It stays steady under `prefers-reduced-motion`. Without WebGL it falls back to a 2D
canvas. Tuning (`charMs`, `slowCharMs`, `fontVmax`, colours, `glow`, `glowTight`/`glowWide`, `holdMs`, `fadeMs`,
`beatMs`, and for `<freakout>`: `freakShake` (max jiggle, em), `freakBlur` (max blur σ, em),
`freakCurve` (ramp steepness), `freakHz` (jiggle rate), `freakFadeOut` (fraction of `fade` spent fading out)) is in `CFG` at the top of `console.js`; call `MatrixConsole.refresh()` after changing it
at runtime.

**Pages:** clicking a prog-link opens the tagged program on its own, under a typed, clickable
`< BACK` (underlined while hovered); links stack. `< BACK` pops the stack and re-renders the previous
page instantly (with the one-shot flag below). Back on the startup sequence's page, the sequence
carries on after it unless that program ends with `<stop>` — so programs placed after a `<stop>`
are reachable only through links.

**One-shot `noDisplayDelay`:** while set, the next program runs with no waits at all — no `<delay>`
pauses, no typing gaps, and no replace effect (only the `<with>` text; `<freakout>` text already faded away) — so its final text appears
at once; `<cls>` still clears. It turns itself off once that program finishes. It starts OFF; `< BACK` sets it.

**Video pages:** a video with a hand-made label and prev/next links on the bottom row:
`'<tag>vid1</tag><video-embed ref=dQw4w9WgXcQ><prog ref="vid0" no-stack>< PREV</prog> Part 1 <prog ref="vid2" no-stack>NEXT ></prog><stop>'`.

**Image pages:** an image with a centred caption, and the cursor parked out of the way:
`'<tag>img1</tag><image-embed ref="files/image.png"><center>The caption</center><bottom-row delta=1><stop>'`. Two side by side: `ref="files/before.png,files/after.jpg"`.

**Footers:** `Content…<bottom-row>FOOTER TEXT<bottom-row delta=-1>` puts the footer on the last
row and leaves the cursor blinking at the left edge of the row above it.

**Templates:** a template is just a tagged program used via `<gosub>`. Since tagged programs also
run in the startup sequence, put templates after a `<stop>` program so they only appear where
they're included.

**Returning visitors:** the "cookie" is a presence-only flag in `localStorage`
(key `skip_long_intro`), so it also works from `file://`. At launch, if the number of programs starting
with `<landing>` isn't exactly one, the flag is cleared. With no flag, the console starts at program 0;
with the flag, the `<landing>` program runs first (as the base page). Either way the rain appears
only when a program runs `<start-rain>` — put one at the top of the landing program to have rain
straight away for returning visitors. Clearing the site's data resets it.

`<in-startup>` tells a first run through the startup sequence apart from everything after it: a
program that's both part of the sequence and the landing's `<goto>` target can tell which way the
visitor came in.

A program can also branch on the flag with `<have-cookie>`:

```js
'<tag>hello</tag><have-cookie>Welcome back.<else>First time here?</have-cookie><stop>',
'<tag>menu</tag><have-cookie><prog ref="news">What\'s new</prog><stop><else><prog ref="intro">Start here</prog><stop make-cookie></have-cookie>',
```

## JavaScript API

```js
MatrixRain.stop();                       // pause (stays paused across tab switches)
MatrixRain.start();                      // resume
MatrixRain.startRain(); MatrixRain.stopRain();  // rain on/off, as <start-rain>/<stop-rain>; MatrixRain.raining
MatrixRain.setRainColor('gold');         // or 'green', as <gold-rain>/<green-rain>; MatrixRain.rainColor
MatrixRain.setConfig({ density: 0.4 });  // change CFG keys and rebuild
MatrixRain.refresh();                    // re-read panel geometry and rebuild drops

MatrixConsole.run(2);                    // run program 2 now, then the programs after it
MatrixConsole.programs.push('Wake up<delay>2000ms</delay><cls>');  // add a program to the end
MatrixConsole.stop();  MatrixConsole.start();
MatrixConsole.navigate('about');         // open the program tagged "about" (as if its link was clicked)
MatrixConsole.navigate('about', { oneWay: true });  // as a one-way link: no < BACK, stack cleared
MatrixConsole.navigate('about', { noStack: true }); // as a no-stack link: replaces the current page
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
