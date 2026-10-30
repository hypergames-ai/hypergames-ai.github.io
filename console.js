// Panel console: runs short "programs" that clear the screen and type text behind a heartbeat
// cursor. Text is laid out on a monospace grid and drawn to an offscreen canvas; WebGL composites
// it with the cursor and a two-level bloom so both glow like a CRT. The programs run once, in order.
(() => {
  'use strict';

  const CFG = {
    charMs: 16,                 // mean gap between typed characters
    slowCharMs: 60,             // the gap after <slow-spew> (<normal-spew> returns to charMs)
    jitter: 0.5,                // ± fraction of charMs, so typing doesn't tick like a metronome
    eraseMinMs: 30,            // <replace>: gap between backspace pecks, random in [min, max]
    eraseMaxMs: 100,
    fontVmax: 1.25,             // 1.25vmax = 24px = 18pt on a 1920-wide window
    maxAspect: 16 / 9,          // in wider windows the font follows the height (as #panel's padding
                                // does in style.css), so the panel always fits the 16:9 row count
    lineHeight: 1.25,           // em
    // Halfway between the film frame's pale mint (text 135,209,189; cursor 197,218,212) and the
    // rain's green (0,255,65), so the console doesn't jump out from the rain around it.
    textColor: [68, 232, 127],
    cursorColor: [99, 237, 139],
    brokenLinkColor: [128, 128, 128],   // <prog> links whose tag doesn't exist
    grayTextColor: [128, 128, 128],     // <grey>: de-emphasised text
    highTextColor: [150, 255, 180],     // <high>: emphasised text (drawn bold, too)
    imageGap: 2,                // <image-embed> with several images: the gap between them, in character widths
    glow: false,                // bloom off for now (it showed a grid pattern on real GPUs)
    glowColor: [55, 127, 107],  // phosphor bloom is greener than the near-white cores it surrounds
    glowTight: [0.05, 0.35],    // [σ in cap heights, strength]: the halo hugging each glyph
    glowWide: [1.0, 2.2],       // [σ in cap heights, strength]: the broad haze around text and cursor
    beatMs: 900,                // heartbeat period: 300 on + 200 fade + 400 dark
    holdMs: 300,                // cursor fully on at the start of each beat
    fadeMs: 200,                // then decays to dark, phosphor-style; dark for the rest of the beat
    // <freakout>: at full effect the text jiggles by up to freakShake em and blurs to σ = freakBlur em.
    freakShake: 0.3,
    freakBlur: 0.15,
    freakCurve: 5,              // ramp steepness: intensity = (2^(k·p) − 1) / (2^k − 1) over the fade
    freakHz: 25,                // new jiggle targets per second
    freakFadeOut: 0.2,          // last fraction of the fade, over which the text fades linearly to invisible
  };

  // Cursor geometry in cap heights, measured from the film frame (top raised 0.14 by eye): a block
  // about 1.75 characters wide from above the capitals to below the descenders, just after the text.
  const CURSOR = { w: 1.62, h: 1.96, above: 0.44, gap: 0.15 };

  // Program syntax: plain text (\n for a new line), <delay>NNNNms</delay> to pause, <cls> to clear,
  // <replace hold="NNNNms">old<with hold="NNNNms">new</replace> to type old, hold, backspace it,
  // hold again and type new (both holds optional).
  // MM-DD-YY, HH:MM:SS and HH:MM become the local date and time when the program starts.
  // Every program begins with an implicit clear.
  // Pages: <tag>label</tag> as the very first characters names a program (label: a-z, 0-9, _);
  // <prog ref="label">text</prog> links to it (underlined, clickable; grey if no such tag); a
  // followed link shows that program under a clickable "< BACK". <prog ref="label" one-way> has no
  // BACK: the linked program becomes the base page and the nav stack starts over from it.
  // <prog ref="label" no-stack> (on a page that has a BACK) replaces the current page rather than
  // stacking on it, so BACK skips it, and its BACK reads "< MENU"; on the base page it acts as
  // one-way (no BACK).
  // Returning visitors: <stop make-cookie> sets a presence flag (the "cookie") when its program
  // finishes; <delete-cookie> clears it. At launch, if exactly one program starts with <landing>
  // (the very first characters) and the flag is set, the rain starts at once and that program runs
  // first; otherwise the flag is cleared and program 0 runs. Unrecognised tags render as nothing. <stop> as the very last
  // characters ends the startup sequence after that program.
  // <have-cookie>yes<else>no</have-cookie>: when the program starts, the branch for the flag's
  // state replaces the block verbatim and is then run as usual (<else> required; either branch may
  // be empty; blocks nest; a branch may hold the closing <stop> or <goto>). Keep <landing> and
  // <tag> outside it.
  // <in-startup>yes<else>no</in-startup>: the same, on whether the startup sequence is still on
  // (true from launch until a program ends the sequence with <stop> or the programs run out; a
  // <goto> carries it on; false from the start when launch goes straight to the <landing> program).
  // Templates: <gosub ref="label"> pastes that tagged program in place; its commands run inline.
  // <bottom-row> moves the write head (and cursor) to the left edge of the last visible row;
  // <bottom-row delta=-1> to the row above it (delta ≤ 0). Nothing is erased. <bottom-row delta=1>
  // parks the cursor one row below the bottom row, out of the way (nothing should be typed after it).
  // <top-row> moves it to the left edge of the top row; <top-row delta=2> to 2 rows below it
  // (delta ≥ 0; the caller keeps it within the panel).
  // Rain: <start-rain> starts it (no-op if raining), <stop-rain> lets falling drops finish and
  // forms no more. The rain doesn't start by itself. <gold-rain>/<green-rain> set the colour of
  // drops that start from then on (green at launch); drops already falling keep theirs.
  // Typing speed: <slow-spew> types at slowCharMs from there on, <normal-spew> back at charMs.
  // Every program starts at normal speed.
  // <grey>text</grey>: text (links and other tags inside included) in grey rather than
  // green, to de-emphasise it. Every program starts green.
  // <high>text</high>: the opposite: lighter green and bold (not to be combined with <grey>).
  // Links (<prog>, <a>) are always drawn <high>, unless inside <grey> or broken; < BACK isn't.
  // <freakout hold="1500ms" fade="3000ms">text</freakout>: text that, once typed, holds still for
  // hold, then shakes and blurs ever harder over fade, vanishing during its last 20%.
  // <goto ref="label"> as the very last characters (instead of <stop>) jumps to that program when
  // this one finishes, like a one-way link.
  // <video-embed ref=YOUTUBE_ID t=SEC dur=SEC> (t optional: start offset in seconds; dur optional:
  // pause, holding the frame, that long after t): a 16:9 YouTube player (click to play, loops) in the text area from
  // the current row down to just above the bottom row; text after it goes on the bottom row.
  // Removed by the next clear.
  // <image-embed ref="files/image.png">: an image (site-relative path) in the same area, as tall as
  // it allows, centred, narrowed to fit if it's too wide; text after it goes on the bottom row.
  // ref="files/a.png,files/b.jpg": two (or more) side by side, each in an even share of the width.
  // Removed by the next clear; it and <video-embed> replace each other.
  // <center>text</center>: text centred horizontally on its line (it must fit on one line;
  // tags inside work as usual).
  // Web links: <a href="…">text</a> (relative or absolute; add download or download="name" to
  // download instead, target="_blank" for a new tab).
  const PROGRAMS = [
    '<tag>start</tag><cls><delay>2200ms</delay>',
    '<tag>breach</tag><cls>Modal<start-rain> 101 Breach/USER Violation\nHost Alarm KIWW/HH:MM<delay>2300ms</delay><cls>Trace program: running<delay>1500ms</delay><cls>File not found<delay>1000ms</delay><cls>',
    'Call trans opt: received. MM-DD-YY HH:MM:SS REC:Log><delay>2000ms</delay><cls>Trace program: running<delay>1100ms</delay><cls>',
    "ALERT - PERIMETER BREACH\n========================\nMODAL ERROR: IR.AA.W1M: ON DEVICE D: AN ILLEGAL MEMORY ACCESS\nERROR: MISSING FILE 'MORPH.BLD.EXE'/'HEART O' THE CITY'\nCODE: 009952310\nCONTENT: モーフィアスはここを去った\n<delay>2500ms</delay><cls>",
    'Program restart initiated: closing modal...<stop-rain><delay>600ms</delay>.<delay>700ms</delay>.<delay>600ms</delay>.<delay>600ms</delay>....<delay>800ms</delay>RESTARTING PROGRAM<delay>2000ms</delay><cls><delay>1000ms</delay><in-startup><start-rain><delay>1000ms</delay><goto ref="i1"><else>Welcome to <replace hold="2000ms">The Desert of the Real!<with hold="1000ms">The Oasis of the Hyperreal!</replace><start-rain><delay>3000ms</delay></in-startup>',
    
    // Main Menu
    '<tag>welcome</tag>hypergames.ai | Hypergames: Building The Matrix in AR\n\n<high>Hypergames from First Principles</high>\n\n1. <prog ref="p1s1">We\'re becoming Cyborgs</prog>       HERE and THERE, The AI Merge\n2. Hyperreality Simulation      Reifying identities HERE and THERE\n3. Tulpas                       AI-Simulated (super) Humans\n4. Digital Consensus Reality    AI-Native Hero Systems\n5. Hypergames                   Hyperreality Games\n6. <a href="RedPillWhitepaper.pdf" download>Download the Whitepaper</a>      Warning: Actual Red Pill\n<gosub ref="footer"><delay>5000ms</delay><stop make-cookie>',

    // P1: We're becoming Cyborgs
    '<tag>p1s1</tag><in-startup><slow-spew>Billions of people<delay>250ms</delay> just<delay>200ms</delay> living out their lives... <delay>400ms</delay><normal-spew>oblivious<slow-spew><delay>800ms</delay><normal-spew>\n\nOblivious to the fact we<else>We</in-startup> are increasingly becoming <high>cyborgs</high>: part human, part digital.\nLet\'s understand how we got here...\n\nWith 1980s video game consoles, cyberspace was inaccessible, a world behind the fourth wall.\nCyberspace was THERE\n\nAfter the arrival of online games, social media and smartphones, we tunneled through the fourth wall.\nWE can now go THERE\n\nWith spatial AR headgear, the fourth wall is coming down.\nTHERE is coming HERE\n\nThe trend is clear, we\'re becoming cyborgs...  <prog ref="p1s2" no-stack>CONTINUE</prog><stop>',
    '<tag>p1s2</tag><image-embed ref="images/1980s-subway-1.jpeg,images/2020s-subway-2.png"><center>left: free-range humans (1980s); right: emerging cyborgs (2020s) <prog ref="p1s3" no-stack>CONTINUE</prog></center><stop>',
    '<tag>p1s3</tag><image-embed ref="images/1980s-subway-2.jpg,images/2020s-subway-1.jpg"><center>1980s: Cyberspace was THERE (accessed from home/arcades); Today: WE can go THERE; TOMORROW... <prog ref="p1s4" no-stack>CONTINUE</prog></center><stop>',
    '<tag>p1s4</tag><video-embed ref=YJg02ivYzSs t=227 dur=31><center>Tomorrow: THERE comes HERE. Click Video to Play, or <prog ref="p1s5" no-stack>CONTINUE</prog></center><stop>',
    '<tag>p1s5</tag><image-embed ref="images/1980s-concert-1.jpg,images/2020s-concert-1.jpg"><center>1980s: Be HERE now; Today: Be HERE later. <prog ref="p1s6" no-stack>CONTINUE</prog></center><stop>',
    '<tag>p1s6</tag><image-embed ref="images/1980s-concert-2.webp,images/2020s-concert-2.webp"><center>1980s: Concert is HERE; Today: Concert channeled from HERE to THERE; TOMORROW... <prog ref="p1s7" no-stack>CONTINUE</prog></center><stop>',
    '<tag>p1s7</tag><image-embed ref="images/2030s-concert.jpg"><center>Tomorrow: Intimacy. Venue: dozens, not 10,000s. AI celebrity has unique relationship with everyone in the room.</center>\n<center>Think: An evening with dozens of personalized performances from a celebrity, witnessed by all. <prog ref="p1s8" one-way>CONTINUE</prog></center><stop>',
    '<tag>p1s8</tag>Today, we live HERE (physical) and THERE (digital). They\'re bridged, not merged.\n\n"The AI Merge": AI lives THERE, but AI is also very lucrative HERE: enormous market\npressure will force AI into HERE wherever it fits. <high>HERE and THERE merge.</high> We\'ll use\nAI almost every waking hour. The distinction between online and offline goes away.\n\nCyborgs blend physical and digital selves. Social identity is anchored on the physical\nside. <high>Post AI Merge, the digital identity clothes the physical one.</high> Hypergame players\nenroll in identity-enhancing hero quests led by AR-projected AI humans operating\nin the real world. <high>Hypergame players level up in real life.</high>\n\nIn Roblox, Fortnite, Minecraft, Pokémon GO, and AI-generated games, you don’t level up outside\nthe game. <high>We\'re becoming cyborgs</high> and the AI Merge\'s upside risks being squandered because\ntoday\'s establishment insists on building walled gardens for the humans we used to be.\n\n<prog ref="welcome" one-way>MAIN MENU</prog><stop>',
    




// \n\nWe SIMULATE our social identities into existence (reification). A shopping mall Santa reifies\ntheir identity by wearing a costume and sincerely "playing the part". physical & digital realms: games can help reify your digital self.\n\nBut they don\'t! You reify a fantasy identity, not yours. Fantasy is good, but games that simulate your actual social identity can help you level up in the real-world.\n\n
    

 //   '<tag>i3</tag>By SIMULATING an identity (reifying it), WE CAN AFFECT OTHERS\' CONSENSUS REALITY\nA city mayor doing their job changes consensus reality; a METAVERSE city mayor doesn\'t.\n\nBy NOT reifying your actual identity and instead reifying an "account" identity,\nsocial media, video games and the metaverse forgo the opportunity to AUTHOR meaningful\nchanges to consensus reality.\n\nAI-generated and remixed games are also anachronistically targeting the needs of\npre-cyborg humans. We\'re proposing a solution to leverage AI-generated games in ways\nthat evolve our identities and thus consensus reality. Games become lived experiences.\n\nWe don\'t make "kids\' games" for adults; we shouldn\'t be designing games for the needs of\n1980s free-range humans instead of today\'s emerging cyborg humans...  <prog ref="q1" no-stack>CONTINUE</prog><stop>',



    // footer
    '<tag>footer</tag><bottom-row delta=-1>Red Pills:\n<a href="RedPillWhitepaper.pdf" download>Download the Whitepaper</a> | <a href="https://x.com/mm_hypergames">Follow me on 𝕏</a> | <a href="https://github.com/hypergames-ai">Fun GitHub Projects</a> | <prog ref="morpheus_red_pill" one-way>Give Agent Morpheus a Red Pill</prog><bottom-row delta=1>',

    '<tag>morpheus_red_pill</tag><cls><stop-rain><delay>3000ms</delay>Agent Morpheus: "You call this a choice?"\n<delay>2000ms</delay>\nYou: "The choice is an illusion. You already know what you have to do."\n<delay>2000ms</delay>\nAgent Morpheus: "Truth."<delay>800ms</delay> (selects Red Pill and swallows it)<start-rain>\n\n<delay>2000ms</delay>Agent Morpheus: <freakout hold=800ms fade=3000ms>"Whoa, what’s happening????"</freakout>\n<delay>5000ms</delay><goto ref="breach">',
    '<landing><start-rain><goto ref="welcome">',
  ];

  const FONT_STACK = "'Courier Prime', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', monospace";
  const panel = document.getElementById('panel');
  const canvas = document.getElementById('console');
  const src = document.createElement('canvas');          // glyphs in white; coverage in alpha
  const sctx = src.getContext('2d');
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---- Screen state -------------------------------------------------------------------------

  // <bottom-row>/<top-row> is kept in the screen text as this marker, so re-layout (and resizes) re-anchor it.
  const ROW_MARK = '\uE000';
  // <video-embed>/<image-embed> likewise: layout() places the video or image from wherever this marker falls.
  const MEDIA_MARK = '\uE001';
  // <center>: moves the write head so the text up to </center> ends up centred on its line.
  const CENTER_MARK = '\uE002';
  let screenText = '';
  let attrs = [];                // per code point of screenText: null, or the link object it belongs to
  let typing = false;
  let beatStart = performance.now();
  let dirty = true;              // text or geometry changed: re-lay out and re-upload the glyphs

  function clearScreen() { screenText = ''; attrs = []; dirty = true; }
  function typeChar(ch, attr = null) { screenText += ch; attrs.push(attr); dirty = true; }

  function deleteChar() {                               // backspace: drop the last code point
    const n = screenText.length, low = screenText.charCodeAt(n - 1);
    screenText = screenText.slice(0, n - (low >= 0xDC00 && low <= 0xDFFF ? 2 : 1));
    attrs.pop();
    dirty = true;
  }

  function setTyping(on) {
    if (typing && !on) beatStart = performance.now();    // first beat after typing starts "on"
    typing = on;
  }

  function cursorOpacity(now) {
    if (typing || reduceQuery.matches) return 1;
    const p = (now - beatStart) % CFG.beatMs;
    if (p < CFG.holdMs) return 1;
    const f = (p - CFG.holdMs) / CFG.fadeMs;
    if (f >= 1) return 0;
    const k = 4;                                         // exponential decay, normalised to end at 0
    return (Math.exp(-k * f) - Math.exp(-k)) / (1 - Math.exp(-k));
  }

  // ---- Geometry and layout (CSS px, relative to the panel's padding box) --------------------

  let dpr = 1, boxW = 0, boxH = 0, padX = 0, padY = 0;
  let fontPx = 0, lineH = 0, baseOff = 0, cap = 0, cursorOffset = 0;
  const widths = new Map();
  let glyphs = [];               // [ch, x, y, w, attr]: baseline positions
  let linkRects = [];            // { x, top, w, h, attr } per linked glyph, for hit-testing
  let cursor = { x: 0, y: 0, w: 0, h: 0 };

  function measure() {
    sctx.font = `${fontPx}px ${FONT_STACK}`;
    const mg = sctx.measureText('Mg');
    const asc = mg.fontBoundingBoxAscent ?? fontPx * 0.8;
    const desc = mg.fontBoundingBoxDescent ?? fontPx * 0.2;
    cap = sctx.measureText('T').actualBoundingBoxAscent;
    lineH = CFG.lineHeight * fontPx;
    baseOff = (lineH - asc - desc) / 2 + asc;
    // Cursor x relative to the end of the last character's cell: chosen so the ink gap after a
    // typical glyph ('g', as in the film frame) is CURSOR.gap cap heights.
    const advance = sctx.measureText('M').width;
    cursorOffset = sctx.measureText('g').actualBoundingBoxRight + CURSOR.gap * cap - advance;
    widths.clear();
  }

  function charWidth(ch) {
    let w = widths.get(ch);
    if (w === undefined) { w = sctx.measureText(ch).width; widths.set(ch, w); }
    return w;
  }

  const LINK_KINDS = new Set(['prog', 'broken', 'back', 'url']);
  const isLink = attr => Boolean(attr && LINK_KINDS.has(attr.kind));
  const GRAY = { gray: true };   // the attr of plain text inside <grey>
  const HIGH = { high: true };   // and inside <high>

  function layout() {
    const maxW = boxW - 2 * padX, maxH = boxH - 2 * padY;
    const cw = CURSOR.w * cap;
    const bottomRow = Math.max(0, Math.floor(maxH / lineH) - 1);   // last row that fits entirely
    const placed = [];
    let x = 0, line = 0, k = 0, media = null, mediaTop = 0;
    let parked = false;            // after <bottom-row delta=1>, before any more text: the cursor's out of sight
    for (const ch of screenText) {                       // by code point, so CJK stays whole
      const attr = attrs[k++];
      if (ch === '\n') { x = 0; line++; parked = false; continue; }
      if (ch === ROW_MARK) { x = 0; line = attr.row ?? Math.max(0, bottomRow + attr.delta); parked = attr.delta > 0; continue; }   // <bottom-row>, <top-row>
      if (ch === CENTER_MARK) {                          // <center>: start where the whole run will be centred
        let runW = 0;
        for (const c of attr.text) runW += charWidth(c);
        x = Math.max(x, (maxW - runW) / 2);              // never back over text already on the line
        continue;
      }
      if (ch === MEDIA_MARK) {                           // <video-embed>, <image-embed>: from the next whole row; text after it goes on the bottom row
        if (!(media && x === 0 && line === bottomRow)) mediaTop = x > 0 ? line + 1 : line;   // straight after another: its area
        media = attr; x = 0; line = bottomRow; continue;
      }
      const w = charWidth(ch);
      if (x > 0 && x + w > maxW) { x = 0; line++; }
      placed.push([ch, x, line, w, attr]);
      x += w;
      parked = false;
    }
    let cx = x > 0 ? x + cursorOffset : 0;
    if (cx > 0 && cx + cw > maxW) { cx = 0; line++; }
    // If the text ever outgrows the panel, scroll so the cursor's line stays visible (not a
    // parked cursor's: that row is below the last one on purpose).
    const scroll = Math.max(0, ((parked ? bottomRow : line) + 1) * lineH - maxH);
    const base = l => padY + l * lineH + baseOff - scroll;
    glyphs = placed.map(([ch, gx, l, w, attr]) => [ch, padX + gx, base(l), w, attr]);
    const mediaY = padY + mediaTop * lineH - scroll, mediaH = Math.max(0, bottomRow - mediaTop) * lineH;
    placeVideo(media && media.kind === 'video' ? media : null, mediaY, mediaH);   // the last embed wins; the other goes
    placeImage(media && media.kind === 'image' ? media : null, mediaY, mediaH);
    cursor = { x: padX + cx, y: base(line) - (1 + CURSOR.above) * cap, w: cw, h: CURSOR.h * cap };
    linkRects = glyphs.filter(g => isLink(g[4])).map(([, gx, y, w, attr]) => ({ x: gx, top: y - baseOff, w, h: lineH, attr }));
    if (hoverLink && !attrs.includes(hoverLink)) setHover(null);   // the hovered link left the screen
  }
  // <video-embed ref=id>: one 16:9 YouTube player in the text area between the row where the tag
  // ran and the bottom row (kept free for a label and links): as large as fits, horizontally
  // centred, top-aligned. Click to play; loops. It goes with
  // the screen: the next clear (any navigation, <cls>) leaves no marker, so it's removed.
  // dur=SEC: pauses the player (holding the frame) each time playback reaches t + dur.
  let videoFrame = null;
  function placeVideo(attr, top, areaH) {
    const src = attr && `https://www.youtube.com/embed/${attr.id}?loop=1&playlist=${attr.id}&rel=0&playsinline=1`
      + (attr.start ? `&start=${attr.start}` : '')
      + (attr.dur ? `&enablejsapi=1&origin=${encodeURIComponent(location.origin)}` : '');
    // Only a different video gets a new player (re-layout mustn't reload it). Compared with our own
    // copy of the src: the player API may rewrite the iframe's.
    if (videoFrame && (!attr || videoFrame.dataset.src !== src)) { videoFrame.remove(); videoFrame = null; }
    if (!attr) return;
    if (!videoFrame) {
      videoFrame = document.createElement('iframe');
      videoFrame.id = 'video';
      videoFrame.title = 'YouTube video';
      videoFrame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      videoFrame.allowFullscreen = true;
      videoFrame.referrerPolicy = 'strict-origin-when-cross-origin';   // YouTube refuses embeds without a referrer
      videoFrame.src = videoFrame.dataset.src = src;
      panel.appendChild(videoFrame);
      if (attr.dur) pauseAt(videoFrame, attr.start + attr.dur);
    }
    const areaW = boxW - 2 * padX, w = Math.min(areaW, areaH * 16 / 9);
    Object.assign(videoFrame.style, { left: padX + (areaW - w) / 2 + 'px', top: top + 'px', width: w + 'px', height: w * 9 / 16 + 'px' });
  }
  // YouTube's IFrame Player API (only the time it reports and pauseVideo() are used), loaded on first use.
  let youTubeApi = null;
  function loadYouTubeApi() {
    youTubeApi ||= new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) { resolve(window.YT); return; }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { youTubeApi = null; reject(new Error("couldn't load https://www.youtube.com/iframe_api")); };
      document.head.appendChild(s);
    });
    return youTubeApi;
  }
  // Pauses `frame`'s player when playback runs forward across `at` seconds: not on a seek past it,
  // nor straight away when play resumes from the pause.
  const PAUSE_POLL_MS = 50;
  function pauseAt(frame, at) {
    loadYouTubeApi().then(YT => {
      if (videoFrame !== frame) return;                   // gone (or replaced) while the API loaded
      let timer = 0, last = 0;
      const player = new YT.Player(frame, { events: { onStateChange: e => {
        clearInterval(timer);
        if (e.data !== YT.PlayerState.PLAYING) return;
        last = player.getCurrentTime();
        timer = setInterval(() => {
          if (videoFrame !== frame) { clearInterval(timer); return; }
          const now = player.getCurrentTime();
          if (last < at && now >= at && now - last < 1) { clearInterval(timer); player.pauseVideo(); }
          last = now;
        }, PAUSE_POLL_MS);
      } } });
    }, e => console.warn(`console: <video-embed dur> won't pause: ${e.message}`));
  }
  // <image-embed ref="a.png,b.jpg">: one image, or several side by side, in the same area. The text
  // area's width is split evenly between them (less CFG.imageGap between neighbours); each is the
  // area's full height, its width from its aspect ratio, narrowed (keeping the ratio) if that's
  // wider than its share. The row of them is centred, top-aligned. Hidden until they've all loaded
  // or failed (sizes aren't known before; a failed one drops out). Goes with the screen, too.
  let imageEls = [];
  function placeImage(attr, top, areaH) {
    const srcs = attr ? attr.srcs : [];
    while (imageEls.length > srcs.length) imageEls.pop().remove();
    while (imageEls.length < srcs.length) {
      const el = document.createElement('img');
      el.className = 'image';
      el.alt = '';
      el.draggable = false;
      el.addEventListener('load', () => { dirty = true; });   // now it has a size: lay out again
      el.addEventListener('error', () => { dirty = true; console.warn(`console: <image-embed> couldn't load ${el.getAttribute('src')}`); });
      panel.appendChild(el);
      imageEls.push(el);
    }
    imageEls.forEach((el, i) => { if (el.getAttribute('src') !== srcs[i]) el.src = srcs[i]; });   // only on change: re-layout mustn't reload
    const hide = el => { el.style.visibility = 'hidden'; };
    if (!imageEls.every(el => el.complete)) { imageEls.forEach(hide); return; }   // complete: loaded or failed
    const ok = imageEls.filter(el => el.naturalWidth && el.naturalHeight);
    imageEls.forEach(el => { if (!ok.includes(el)) hide(el); });
    if (!ok.length) return;
    const areaW = boxW - 2 * padX, gap = ok.length > 1 ? CFG.imageGap * charWidth(' ') : 0;
    const share = (areaW - gap * (ok.length - 1)) / ok.length;
    const sizes = ok.map(el => {
      const aspect = el.naturalWidth / el.naturalHeight;
      let h = areaH, w = h * aspect;
      if (w > share) { w = share; h = w / aspect; }
      return [w, h];
    });
    let left = padX + (areaW - sizes.reduce((s, [w]) => s + w, 0) - gap * (ok.length - 1)) / 2;
    ok.forEach((el, i) => {
      const [w, h] = sizes[i];
      Object.assign(el.style, { visibility: 'visible', left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
      left += w + gap;
    });
  }


  const css = c => `rgb(${c.join(',')})`;

  // <freakout> at time `now`: intensity e (0 → 1 on an exponential ramp after the hold), the
  // string's jiggle offset and its blur σ in CSS px, and its opacity (1 → 0 over the fade's end). t0 is when its text finished typing
  // (Infinity while it's still typing, -Infinity for an instant render).
  function freakState(f, now) {
    const since = now - f.t0 - f.hold;
    const p = f.fade > 0 ? Math.min(1, Math.max(0, since / f.fade)) : since >= 0 ? 1 : 0;
    const k = CFG.freakCurve, e = k > 0 ? (2 ** (k * p) - 1) / (2 ** k - 1) : p;
    const amp = reduceQuery.matches ? 0 : e * CFG.freakShake * fontPx, s = now / 1000 * CFG.freakHz;
    const out = CFG.freakFadeOut, alpha = p < 1 - out ? 1 : out > 0 ? (1 - p) / out : 0;
    return { e, alpha, dx: amp * noise(f.seedX, s), dy: amp * noise(f.seedY, s), blur: e * CFG.freakBlur * fontPx,
             animating: f.t0 !== Infinity && (p < 1 || (amp > 0 && alpha > 0)) };
  }

  // Jitter: a new random target in [-1, 1] every unit of s, eased into from the previous one.
  function noise(seed, s) {
    const i = Math.floor(s), t = s - i, u = t * t * (3 - 2 * t);
    return hash(seed + i) * (1 - u) + hash(seed + i + 1) * u;
  }

  function hash(n) {
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return ((n ^ (n >>> 16)) >>> 0) / 0x7fffffff - 1;
  }

  // Blurred text by way of its shadow, which blurs in every browser (ctx.filter doesn't): the glyph
  // itself lands well off the canvas and the shadow is offset back into place. Shadow offset and
  // blur ignore the transform, so they're in device px; shadowBlur is 2σ.
  function fillBlurred(ctx, ch, x, y, sigma) {
    if (sigma < 0.05) { ctx.fillText(ch, x, y); return; }
    const off = boxW + 100;
    ctx.save();
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 2 * sigma * dpr;
    ctx.shadowOffsetX = off * dpr;
    ctx.shadowOffsetY = 0;
    ctx.fillText(ch, x - off, y);
    ctx.restore();
  }

  // Glyphs in their own colours, with link underlines: prog and broken links always, < BACK
  // only while hovered. Returns whether a <freakout> needs redrawing next frame.
  function drawGlyphs(ctx, now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${fontPx}px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    const ulOff = 0.2 * cap, ulH = Math.max(1 / dpr, 0.08 * cap);
    let bold = false;                                     // <high> text: Courier Prime Bold (same advance widths)
    const freaks = new Map();                             // one state per <freakout>: it shakes as a whole
    let animating = false;
    for (const [ch, x, y, w, attr] of glyphs) {
      ctx.fillStyle = css(attr && attr.kind === 'broken' ? CFG.brokenLinkColor : attr && attr.gray ? CFG.grayTextColor
        : attr && attr.high ? CFG.highTextColor : CFG.textColor);
      if (Boolean(attr && attr.high) !== bold) { bold = !bold; ctx.font = `${bold ? 'bold ' : ''}${fontPx}px ${FONT_STACK}`; }
      if (attr && attr.kind === 'freak') {
        let f = freaks.get(attr);
        if (!f) { f = freakState(attr, now); freaks.set(attr, f); animating ||= f.animating; }
        if (f.alpha <= 0) continue;
        ctx.globalAlpha = f.alpha;
        fillBlurred(ctx, ch, x + f.dx, y + f.dy, f.blur);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.fillText(ch, x, y);
      if (isLink(attr) && (attr.kind !== 'back' || attr === hoverLink)) ctx.fillRect(x, y + ulOff, w, ulH);
    }
    return animating;
  }

  // ---- WebGL bloom ---------------------------------------------------------------------------

  const VS = 'attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
  // Pixel coordinates reach several thousand: mediump isn't precise enough for crisp cursor edges.
  const PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  const SOURCE = PRECISION + `
    varying vec2 v;
    uniform sampler2D uText;
    uniform vec4 uCursor;        // cursor rect in uv: x0, y0, x1, y1
    uniform vec2 uSize;          // render-target size in px, for antialiased cursor edges
    uniform float uCursorA;
    uniform vec3 uCursorC;
    vec4 source() {              // rgb = text + cursor colour; a = their coverage
      vec2 px = v * uSize;
      vec2 lo = clamp(px - uCursor.xy * uSize + 0.5, 0.0, 1.0);
      vec2 hi = clamp(uCursor.zw * uSize - px + 0.5, 0.0, 1.0);
      vec4 t = texture2D(uText, v);                      // glyphs in their own colours, premultiplied
      float k = lo.x * lo.y * hi.x * hi.y * uCursorA;
      return vec4(t.rgb + k * uCursorC, clamp(t.a + k, 0.0, 1.0));
    }`;
  const FS_COMPOSE = SOURCE + 'void main() { gl_FragColor = vec4(source().rgb, 1.0); }';
  const FS_BLUR = PRECISION + `
    varying vec2 v;
    uniform sampler2D uSrc;
    uniform vec2 uStep;          // one tap = σ/2, so 13 taps span ±3σ (a shorter span leaves box edges)
    void main() {
      vec3 c = vec3(0.0); float sum = 0.0;
      for (int i = -6; i <= 6; i++) {
        float x = float(i), w = exp(-x * x / 8.0);
        c += texture2D(uSrc, v + uStep * x).rgb * w; sum += w;
      }
      gl_FragColor = vec4(c / sum, 1.0);
    }`;
  // 2× downsample: four bilinear taps cover a 4×4 block, enough prefiltering to avoid aliasing.
  const FS_DOWN = PRECISION + `
    varying vec2 v;
    uniform sampler2D uSrc;
    uniform vec2 uTexel;         // one source texel in uv
    void main() {
      gl_FragColor = 0.25 * (texture2D(uSrc, v + uTexel * vec2(-1.0, -1.0)) + texture2D(uSrc, v + uTexel * vec2(1.0, -1.0)) +
                             texture2D(uSrc, v + uTexel * vec2(-1.0, 1.0)) + texture2D(uSrc, v + uTexel * vec2(1.0, 1.0)));
    }`;
  const FS_FINAL = SOURCE + `
    uniform sampler2D uTight, uWide;
    uniform float uKt, uKw;
    uniform vec3 uGlowC;         // glow hue, brightest channel = 1
    void main() {
      // Glow only where the glyphs and cursor aren't, so their cores keep their exact colour.
      vec4 s = source();
      vec3 g = uKt * texture2D(uTight, v).rgb + uKw * texture2D(uWide, v).rgb;
      vec3 glow = dot(g, vec3(0.2126, 0.7152, 0.0722)) * uGlowC;
      float dither = (fract(sin(dot(v * uSize, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;   // hides 8-bit banding in the haze
      gl_FragColor = vec4(min(s.rgb + glow * (1.0 - s.a) + dither, 1.0), 1.0);
    }`;

  let gl = null, progs = null, textTex = null, fbo = null, ctx2d = null;

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, code] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }

  function newTexture(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  function newTarget(w, h) {
    const tex = newTexture(w, h), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  function initGL() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) return false;
    progs = { compose: compile(VS, FS_COMPOSE), blur: compile(VS, FS_BLUR), down: compile(VS, FS_DOWN), final: compile(VS, FS_FINAL) };
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one big triangle
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);         // canvas rows run top-down, GL bottom-up
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // so edges filter cleanly between colours
    textTex = newTexture(0, 0);
    fbo = null;
    return true;
  }

  function sizeTargets() {
    const W = canvas.width, H = canvas.height;
    const size = k => [Math.max(1, Math.round(W / k)), Math.max(1, Math.round(H / k))];
    fbo = { a2: newTarget(...size(2)), b2: newTarget(...size(2)), a4: newTarget(...size(4)),
            a8: newTarget(...size(8)), b8: newTarget(...size(8)) };
  }

  function pass(prog, target, uniforms) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
    let unit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (loc == null) continue;
      if (value && value.tex !== undefined) {                       // a texture
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value.tex);
        gl.uniform1i(loc, unit++);
      } else if (typeof value === 'number') gl.uniform1f(loc, value);
      else if (value.length === 2) gl.uniform2fv(loc, value);
      else if (value.length === 3) gl.uniform3fv(loc, value);
      else gl.uniform4fv(loc, value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function renderGL(a) {
    const rgb = c => c.map(x => x / 255);
    const cur = [cursor.x / boxW, 1 - (cursor.y + cursor.h) / boxH, (cursor.x + cursor.w) / boxW, 1 - cursor.y / boxH];
    const base = { uText: { tex: textTex }, uCursor: cur, uCursorA: a, uCursorC: rgb(CFG.cursorColor) };
    if (!CFG.glow) {                                       // text and cursor only, straight to the screen
      pass(progs.compose, null, { ...base, uSize: [canvas.width, canvas.height] });
      return;
    }
    if (!fbo) sizeTargets();
    // Separable Gaussian; one tap = σ/2. In uv the step is the same at every resolution.
    const blur = (from, via, to, sigmaCap) => {
      const tapPx = sigmaCap * cap * dpr / 2;
      pass(progs.blur, via, { uSrc: from, uStep: [tapPx / canvas.width, 0] });
      pass(progs.blur, to, { uSrc: via, uStep: [0, tapPx / canvas.height] });
    };
    const down = (from, to) => pass(progs.down, to, { uSrc: from, uTexel: [1 / from.w, 1 / from.h] });
    // Tight halo at half resolution; the wide haze at an eighth, reached by prefiltered downsampling
    // so its widely spaced taps don't alias.
    pass(progs.compose, fbo.a2, { ...base, uSize: [fbo.a2.w, fbo.a2.h] });
    blur(fbo.a2, fbo.b2, fbo.a2, CFG.glowTight[0]);
    down(fbo.a2, fbo.a4);
    down(fbo.a4, fbo.a8);
    blur(fbo.a8, fbo.b8, fbo.a8, CFG.glowWide[0]);
    pass(progs.final, null, { ...base, uSize: [canvas.width, canvas.height], uTight: fbo.a2, uWide: fbo.a8,
                              uKt: CFG.glowTight[1], uKw: CFG.glowWide[1],
                              uGlowC: CFG.glowColor.map(c => c / Math.max(...CFG.glowColor)) });
  }

  // Without WebGL: the same layout on a 2D canvas, glowing with canvas shadows.
  function render2D(a, now) {
    ctx2d.shadowColor = css(CFG.textColor);
    ctx2d.shadowBlur = CFG.glow ? CFG.glowTight[0] * 4 * cap * dpr : 0;
    const animating = drawGlyphs(ctx2d, now);
    ctx2d.globalAlpha = a;
    ctx2d.fillStyle = css(CFG.cursorColor);
    ctx2d.fillRect(cursor.x, cursor.y, cursor.w, cursor.h);
    ctx2d.globalAlpha = 1;
    ctx2d.shadowBlur = 0;
    return animating;
  }

  // ---- Frame loop ----------------------------------------------------------------------------

  let lastA = -1, contextLost = false, animating = false;   // animating: a <freakout> is in motion

  function frame(now) {
    requestAnimationFrame(frame);
    if (contextLost || !boxW) return;
    const a = cursorOpacity(now);
    if (!dirty && !animating && a === lastA) return;      // nothing changed: skip the GPU work
    if (dirty) layout();
    if (gl && (dirty || animating)) {
      animating = drawGlyphs(sctx, now);
      gl.bindTexture(gl.TEXTURE_2D, textTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    dirty = false;
    lastA = a;
    if (gl) renderGL(a); else animating = render2D(a, now);
  }

  function resize() {
    const r = panel.getBoundingClientRect(), cs = getComputedStyle(panel);
    const border = parseFloat(cs.borderTopWidth) || 0;
    const newDpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = r.width - 2 * border, h = r.height - 2 * border;
    if (w === boxW && h === boxH && newDpr === dpr && fontPx) return;
    dpr = newDpr; boxW = w; boxH = h;
    padX = parseFloat(cs.paddingLeft) || 0;
    padY = parseFloat(cs.paddingTop) || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    fontPx = CFG.fontVmax * Math.min(Math.max(vw, vh), vh * CFG.maxAspect) / 100;
    for (const c of [canvas, src]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
    fbo = null;
    measure();
    dirty = true;
  }

  let resizeTimer = 0;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 100);
  }

  // ---- Program runner ------------------------------------------------------------------------

  const pad = n => String(n).padStart(2, '0');

  function stamp(text, now = new Date()) {
    return text
      .replace(/MM-DD-YY/g, `${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getFullYear() % 100)}`)
      .replace(/HH:MM:SS/g, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
      .replace(/HH:MM/g, `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  }

  // Program-level markers, not displayed: <landing> (only as the very first characters), then
  // <tag>label</tag>; and as the very last characters <stop>, <stop make-cookie> or
  // <goto ref="label">.
  function readProgram(src) {
    let body = src, label = null, stop = false, makeCookie = false, goto;
    const lm = /^<landing\s*\/?>/.exec(body);
    const landing = Boolean(lm);
    if (landing) body = body.slice(lm[0].length);
    const t = /^<tag>([a-z0-9_]+)<\/tag>/.exec(body);
    if (t) { label = t[1]; body = body.slice(t[0].length); }
    const end = /(?:<stop(\s+make-cookie)?\s*\/?>|<goto ref="([^"]*)"\s*\/?>)$/.exec(body);
    if (end) {
      if (end[2] !== undefined) goto = end[2];
      else { stop = true; makeCookie = Boolean(end[1]); }
      body = body.slice(0, end.index);
    }
    return { landing, label, stop, makeCookie, goto, body };
  }

  // Anything tag-shaped that isn't recognised renders as nothing. "< BACK" or "a < b" (a space
  // after the "<") isn't tag-shaped and stays literal.
  const UNKNOWN_TAG = '<\\/?[A-Za-z][^<>]*>';
  const stripTags = text => text.replace(new RegExp(UNKNOWN_TAG, 'g'), '');

  // Scans every time: the list is short, and programs may be pushed at runtime.
  function taggedIndex(label) {
    return PROGRAMS.findIndex(p => readProgram(p).label === label);
  }

  // <gosub ref="label">: paste the tagged program's body (its <landing>, <tag> and trailing
  // <stop …> stripped) into the caller's text, so its commands run inline. Recursive; a label
  // already being expanded (a cycle) or a missing ref expands to nothing.
  function expandGosubs(text, chain = []) {
    return text.replace(/<gosub ref="([^"]*)"\s*\/?>/g, (_, label) => {
      const i = taggedIndex(label);
      if (i < 0 || chain.includes(label) || chain.length >= 16) return '';
      return expandGosubs(readProgram(expandConditionals(PROGRAMS[i])).body, [...chain, label]);
    });
  }

  // <have-cookie>yes<else>no</have-cookie>, <in-startup>yes<else>no</in-startup>: resolved when a
  // program starts, before anything else reads it. The branch for the condition's state replaces
  // the block verbatim, so it may hold any commands, even the closing <stop> or <goto>. Nests,
  // either kind in the other (innermost first); a block without exactly one <else> expands to nothing.
  const CONDITIONAL = /<(have-cookie|in-startup)\s*>((?:(?!<\/?(?:have-cookie|in-startup)\b)[\s\S])*?)<\/\1\s*>/;
  function expandConditionals(text) {
    const state = { 'have-cookie': hasCookie(), 'in-startup': inStartup };   // one snapshot per program start
    for (let m; (m = CONDITIONAL.exec(text));) {
      const parts = m[2].split(/<else\s*\/?>/);
      if (parts.length !== 2) console.warn(`console: <${m[1]}> needs exactly one <else>`);
      text = text.slice(0, m.index) + (parts.length === 2 ? parts[state[m[1]] ? 0 : 1] : '') + text.slice(m.index + m[0].length);
    }
    return text;
  }

  // → [{ cls: true }, { text: '…', link?, back? }, { delay: ms }, { erase: n }, …]
  // A linked page (back = its label, "< BACK" or "< MENU") gets that typed line after every clear.
  function parse(text, back = '') {
    const ops = [{ cls: true }];
    const re = new RegExp(/<delay>(\d+)ms<\/delay>|<cls>|<replace(?:\s+hold="(\d+)ms")?>([\s\S]*?)<with(?:\s+hold="(\d+)ms")?>([\s\S]*?)<\/replace>|<prog ref="([^"]*)"((?:\s+(?:one-way|no-stack))*)\s*>([^<]*)<\/prog>|<a\s+([^<>]*)>([^<]*)<\/a>|<bottom-row(?:\s+delta\s*=\s*"?(-?\d+)"?)?\s*\/?>|<freakout\b([^<>]*)>([^<]*)<\/freakout>|<top-row(?:\s+delta\s*=\s*"?(-?\d+)"?)?\s*\/?>/.source
                        + '|' + UNKNOWN_TAG, 'g');
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) ops.push({ text: text.slice(last, m.index) });
      if (m[1] !== undefined) ops.push({ delay: Number(m[1]) });
      else if (m[0] === '<cls>') ops.push({ cls: true });
      else if (/^<delete-cookie\s*\/?>$/.test(m[0])) ops.push({ deleteCookie: true });
      else if (/^<(start|stop)-rain\s*\/?>$/.test(m[0])) ops.push({ rain: m[0].startsWith('<start') });
      else if (/^<center\s*>$/.test(m[0])) {
        // Centre on what ends up displayed up to </center>: its text ops, less <replace>'s erased
        // old text (tags inside it run as usual).
        const end = text.indexOf('</center>', re.lastIndex);
        const inner = parse(text.slice(re.lastIndex, end < 0 ? text.length : end));
        ops.push({ center: inner.filter(op => op.text !== undefined && !op.replaceOld).map(op => op.text).join('') });
      }
      else if (/^<video-embed\b/.test(m[0])) {
        // <video-embed ref=ID t=SEC dur=SEC>: any order, quotes optional; t (whole seconds, optional
        // trailing "s") is the start offset; dur (seconds, decimals allowed) pauses that long after
        // t. A missing or malformed ref drops the tag.
        const ref = /\bref\s*=\s*(?:"([^"]*)"|([^\s"\/>]+))/.exec(m[0]), t = /\bt\s*=\s*"?(\d+)s?"?(?=[\s\/>])/.exec(m[0]);
        const dur = /\bdur\s*=\s*"?(\d+(?:\.\d+)?)s?"?(?=[\s\/>])/.exec(m[0]);
        const id = ref && (ref[1] ?? ref[2]);
        if (id && /^[A-Za-z0-9_-]+$/.test(id)) ops.push({ video: id, start: t ? Number(t[1]) : 0, dur: dur ? Number(dur[1]) : 0 });
      }
      else if (/^<image-embed\b/.test(m[0])) {
        // <image-embed ref="files/a.png,files/b.jpg">: one path, or several separated by commas (side
        // by side); quotes optional (an unquoted ref keeps its slashes, less a trailing one from
        // "/>"). A missing or empty ref drops the tag.
        const ref = /\bref\s*=\s*(?:"([^"]*)"|([^\s">]+))/.exec(m[0]);
        const paths = ref ? (ref[1] ?? ref[2].replace(/\/$/, '')).split(',').map(p => p.trim()).filter(Boolean) : [];
        if (paths.length) ops.push({ images: paths });
      }
      else if (/^<(gold|green)-rain\s*\/?>$/.test(m[0])) ops.push({ rainColor: m[0].startsWith('<gold') ? 'gold' : 'green' });
      else if (/^<(slow|normal)-spew\s*\/?>$/.test(m[0])) ops.push({ slow: m[0].startsWith('<slow') });
      else if (/^<\/?grey\s*>$/.test(m[0])) ops.push({ gray: !m[0].startsWith('</') });
      else if (/^<\/?high\s*>$/.test(m[0])) ops.push({ high: !m[0].startsWith('</') });
      else if (m[6] !== undefined) ops.push({ text: m[8], link: m[6], oneWay: /one-way/.test(m[7]), noStack: /no-stack/.test(m[7]) });
      else if (m[3] !== undefined) {
        // <replace>: old and new are plain text (tags stripped), so the backspace count is exact.
        // The <replace> hold runs before backspacing; the <with> hold after it, before new is typed.
        // The markers let a noDisplayDelay run drop the effect and type only the new text.
        const oldText = stripTags(m[3]), newText = stripTags(m[5]);
        if (oldText) ops.push({ text: oldText, replaceOld: true });
        ops.push({ delay: Number(m[2] || 0), replaceHold: true }, { erase: [...oldText].length });
        if (m[4]) ops.push({ delay: Number(m[4]), replaceHold: true });
        if (newText) ops.push({ text: newText });
      } else if (m[13] !== undefined) {
        // <freakout hold="…ms" fade="…ms">: either order, quotes optional, missing = 0.
        const at = { hold: 0, fade: 0 };
        for (const [, k, ms] of m[12].matchAll(/\b(hold|fade)\s*=\s*"?(\d+)ms"?/g)) at[k] = Number(ms);
        ops.push({ text: m[13], freak: { hold: at.hold, fade: at.fade } });
      } else if (m[0].startsWith('<top-row')) {
        ops.push({ row: Math.max(0, Number(m[14] || 0)) });   // delta: 0 or positive
      } else if (m[0].startsWith('<bottom-row')) {
        ops.push({ bottomRow: Math.min(1, Number(m[11] || 0)) });   // delta: ≤ 0, or 1 to park the cursor
      } else if (m[9] !== undefined) {
        // <a href="…" download? target?>text</a>: a web link; without an href it's plain text.
        const at = {};
        for (const [, k, val] of m[9].matchAll(/([a-z][\w-]*)(?:\s*=\s*"([^"]*)")?/gi)) at[k.toLowerCase()] = val ?? '';
        ops.push(at.href !== undefined
          ? { text: m[10], href: at.href, download: at.download, newTab: at.target === '_blank' }
          : { text: m[10] });
      }
      // else: an unrecognised tag, dropped
      last = re.lastIndex;
    }
    if (last < text.length) ops.push({ text: text.slice(last) });
    return back ? ops.flatMap(op => op.cls ? [op, { text: back, back: true }, { text: '\n\n' }] : [op]) : ops;
  }

  // The "cookie": a presence-only flag in localStorage (works from file://, no expiry to manage).
  // Blocked storage reads as "no cookie" and ignores writes.
  const COOKIE_KEY = 'skip_long_intro';
  function makeCookie() { try { localStorage.setItem(COOKIE_KEY, '1'); } catch (e) { /* storage blocked */ } }
  function deleteCookie() { try { localStorage.removeItem(COOKIE_KEY); } catch (e) { /* storage blocked */ } }
  function hasCookie() { try { return localStorage.getItem(COOKIE_KEY) !== null; } catch (e) { return false; } }

  // stop() and run() bump `gen`; a program from an older generation bails out at its next wait.
  let gen = 0, running = false, next = 0;
  let inStartup = true;         // <in-startup>: until the startup sequence ends, or launch goes straight to <landing>
  let noDisplayDelay = false;   // one-shot: next program skips delays and <replace> (BACK sets it)
  let navStack = [];            // pages to go back to ({ i: program index, back: its BACK label }); empty = on the startup sequence
  let pageIndex = -1;           // the program on screen
  let pageBack = '';            // and its BACK label ('' on the base page)
  const ABORT = Symbol('abort');
  const CATCH_UP_MS = 250;      // typing more than this far behind schedule restarts the schedule

  // Resolves after `ms` of visible time: the countdown pauses while the tab is hidden, so the
  // console stops with the rain and picks up where it left off.
  let waitCount = 0;            // waits started so far; lets <goto> tell a waiting program from a spinning one
  function wait(ms, g) {
    waitCount++;
    return new Promise((resolve, reject) => {
      let left = ms, t0 = 0, timer = 0;
      const arm = () => { t0 = performance.now(); timer = setTimeout(done, left); };
      const onVisibility = () => {
        if (document.hidden) { clearTimeout(timer); left -= performance.now() - t0; }
        else arm();
      };
      const done = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        if (g === gen) resolve(); else reject(ABORT);
      };
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) arm();
    });
  }

  async function runProgram(i, g, back = '') {
    pageIndex = i;
    pageBack = back;
    const skip = noDisplayDelay;   // no pauses, no typing gaps, no <replace> effect: the text appears at once
    const prog = readProgram(expandConditionals(PROGRAMS[i]));
    const waitsAtStart = waitCount;
    let charMs = CFG.charMs;       // <slow-spew>/<normal-spew> switch it; every program starts normal
    let gray = false, high = false;   // inside <grey>, <high>
    for (const op of parse(stamp(expandGosubs(prog.body, prog.label ? [prog.label] : [])), back)) {
      if (skip && (op.delay !== undefined || op.erase !== undefined || op.replaceOld)) continue;
      if (op.cls) {
        clearScreen();
      } else if (op.bottomRow !== undefined) {
        typeChar(ROW_MARK, { kind: 'row', delta: op.bottomRow });   // a directive, not typed: no wait
      } else if (op.center !== undefined) {
        typeChar(CENTER_MARK, { kind: 'center', text: op.center });   // a directive: no wait
      } else if (op.video !== undefined) {
        typeChar(MEDIA_MARK, { kind: 'video', id: op.video, start: op.start, dur: op.dur });   // a directive: no wait
      } else if (op.images) {
        typeChar(MEDIA_MARK, { kind: 'image', srcs: op.images });
      } else if (op.row !== undefined) {
        typeChar(ROW_MARK, { kind: 'row', row: op.row });
      } else if (op.rain !== undefined) {
        if (window.MatrixRain) op.rain ? window.MatrixRain.startRain() : window.MatrixRain.stopRain();
      } else if (op.rainColor) {
        if (window.MatrixRain) window.MatrixRain.setRainColor(op.rainColor);
      } else if (op.deleteCookie) {
        deleteCookie();
      } else if (op.slow !== undefined) {
        charMs = op.slow ? CFG.slowCharMs : CFG.charMs;
      } else if (op.gray !== undefined) {
        gray = op.gray;
      } else if (op.high !== undefined) {
        high = op.high;
      } else if (op.delay !== undefined) {
        await wait(op.delay, g);
      } else if (op.erase !== undefined) {
        // Backspace one peck at a time: the first as the hold ends, then eraseMin–eraseMax ms apart.
        setTyping(true);
        for (let k = 0; k < op.erase; k++) {
          if (k > 0) await wait(CFG.eraseMinMs + Math.random() * (CFG.eraseMaxMs - CFG.eraseMinMs), g);
          else if (g !== gen) throw ABORT;
          deleteChar();
        }
        setTyping(false);
      } else {
        // One link object per occurrence, shared by its characters (hover highlights just this one).
        let attr = op.back ? { kind: 'back' }
          : op.link !== undefined ? { kind: taggedIndex(op.link) >= 0 ? 'prog' : 'broken', ref: op.link, oneWay: op.oneWay, noStack: op.noStack }
          : op.href !== undefined ? { kind: 'url', href: op.href, download: op.download, newTab: op.newTab }
          : op.freak ? { kind: 'freak', ...op.freak, t0: Infinity, seedX: randomSeed(), seedY: randomSeed() } : null;
        if (gray && !op.back) {                           // < BACK after a <cls> stays green
          if (attr) attr.gray = true; else attr = GRAY;
        }
        const linkHigh = attr && (attr.kind === 'prog' || attr.kind === 'url') && !gray;   // links are <high>, unless in <grey>
        if ((high || linkHigh) && !op.back) {
          if (attr) attr.high = true; else attr = HIGH;
        }
        if (skip) {
          for (const ch of op.text) typeChar(ch, attr);
          if (op.freak) attr.t0 = -Infinity;              // the final state: full freakout, faded away
          continue;
        }
        setTyping(true);                                  // steady while typing, heartbeat when idle
        // Type to a schedule, not a fixed sleep per character: timers always fire a little late,
        // and that lateness would add up. Sleep only when ahead; when behind, type straight away.
        let due = performance.now();
        for (const ch of op.text) {
          due += charMs * (1 + CFG.jitter * (2 * Math.random() - 1));
          const now = performance.now();
          if (now - due > CATCH_UP_MS) due = now;         // after a stall (hidden tab), resume rather than burst
          if (due > now) await wait(due - now, g);
          else if (g !== gen) throw ABORT;
          typeChar(ch, attr);
        }
        if (op.freak) { attr.t0 = performance.now(); dirty = true; }   // its hold starts once it's all there
        setTyping(false);
      }
    }
    if (skip) noDisplayDelay = false;                     // one-shot: only once the program is done
    if (prog.makeCookie) makeCookie();                    // <stop make-cookie>: only on a completed run
    if (prog.goto !== undefined) return scheduleGoto(prog.goto, g, waitCount === waitsAtStart);
    if (prog.stop) return 'stop';
  }

  // <goto ref="label"> at the end of a completed program: jump like a one-way link (stack cleared,
  // the target becomes the base page). Deferred so the finishing loop exits first, and dropped if
  // anything else started meanwhile. A broken ref stops like <stop>. A cycle of programs that
  // finish without waiting at all is cut off after GOTO_SPIN_LIMIT jumps.
  const GOTO_SPIN_LIMIT = 32;
  let gotoSpins = 0;
  function scheduleGoto(label, g, finishedWithoutWaiting) {
    const i = taggedIndex(label);
    if (i < 0) return 'stop';
    gotoSpins = finishedWithoutWaiting ? gotoSpins + 1 : 0;
    if (gotoSpins > GOTO_SPIN_LIMIT) {
      console.warn(`console: <goto> loop without any waits stopped at "${label}"`);
      gotoSpins = 0;
      return 'stop';
    }
    setTimeout(() => { if (gen === g) run(i); }, 0);
    return 'goto';
  }

  const randomSeed = () => Math.floor(Math.random() * 0x40000000);

  // The one place to change program order (e.g. random cycling later). -1 = no more programs.
  function nextProgram() {
    return next < PROGRAMS.length ? next++ : -1;
  }

  // Runs the remaining programs once, stopping early after a program that ends with <stop>; the
  // console stays as the last program left it.
  async function loop(g) {
    try {
      let r;
      for (let i; (i = nextProgram()) >= 0;) {
        r = await runProgram(i, g);
        if (r === 'goto' || r === 'stop') break;          // 'stop': a broken goto, or the program's <stop>
      }
      if (r !== 'goto') inStartup = false;                // the startup sequence is over (<goto> carries it on)
      if (g === gen) running = false;                     // a goto may already have started a newer loop
    } catch (e) {
      if (e !== ABORT) throw e;
    }
  }

  function start() {
    if (running) return;
    running = true;
    loop(++gen);
  }

  function stop() {
    running = false;
    gen++;
    setTyping(false);
  }

  // Run program n now, then the ones after it.
  function run(n) {
    navStack = [];
    stop();
    next = n;
    start();
  }

  // ---- Pages ---------------------------------------------------------------------------------

  // A linked page runs on its own: it doesn't carry on into the programs after it. `back` is the
  // label of its BACK link.
  const BACK_LABEL = '< BACK', MENU_LABEL = '< MENU';
  function showPage(i, back) {
    stop();
    running = true;
    const g = ++gen;
    runProgram(i, g, back).then(() => { if (g === gen) running = false; }, e => { if (e !== ABORT) throw e; });
  }

  // A one-way link has no < BACK: it clears the stack and makes the program the base page, as run() does.
  // A no-stack link replaces the current page instead of stacking on it, so BACK skips that page;
  // replacing the base page makes the target the new base page, which is just a one-way link.
  // A page reached by a no-stack link labels its BACK "< MENU" (it skips the pages in between).
  function navigate(label, { oneWay = false, noStack = false } = {}) {
    const i = taggedIndex(label);
    if (i < 0) return;                                    // broken link: no-op
    if (oneWay || (noStack && !navStack.length)) { run(i); return; }
    if (!noStack) navStack.push({ i: pageIndex, back: pageBack });
    showPage(i, noStack ? MENU_LABEL : BACK_LABEL);
  }

  // Re-render the previous page instantly. Back on the startup sequence's page, the sequence then
  // carries on after it, unless that program ends with <stop>.
  function back() {
    if (!navStack.length) return;
    const { i, back: label } = navStack.pop();
    noDisplayDelay = true;
    if (navStack.length) showPage(i, label);
    else { stop(); next = i; start(); }
  }

  let hoverLink = null;

  function setHover(link) {
    if (link === hoverLink) return;
    if ((link && link.kind === 'back') || (hoverLink && hoverLink.kind === 'back')) dirty = true;   // underline on hover
    hoverLink = link;
    canvas.style.cursor = link && link.kind !== 'broken' ? 'pointer' : '';
    canvas.title = link && link.kind === 'url' ? link.href : '';     // native tooltip shows the URL
  }

  // Follow an <a> link through a real, temporary anchor, so the browser applies its own URL
  // resolution and download rules (download works for same-origin URLs only). Called from the
  // visitor's click, which counts as user activation for new tabs and downloads.
  function followUrl(link, newTab) {
    let url;
    try { url = new URL(link.href, document.baseURI); } catch (e) { return; }
    if (url.protocol === 'javascript:' || url.protocol === 'vbscript:') return;
    const a = document.createElement('a');
    a.href = link.href;
    if (link.download !== undefined) a.download = link.download;
    else if (newTab || link.newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function linkAt(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = linkRects.find(l => x >= l.x && x < l.x + l.w && y >= l.top && y < l.top + l.h);
    return hit ? hit.attr : null;
  }

  canvas.addEventListener('pointermove', e => setHover(linkAt(e)));
  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener('click', e => {
    const link = linkAt(e);
    if (link && link.kind === 'prog') navigate(link.ref, { oneWay: link.oneWay, noStack: link.noStack });
    else if (link && link.kind === 'back') back();
    else if (link && link.kind === 'url') followUrl(link, e.ctrlKey || e.metaKey);
  });
  canvas.addEventListener('auxclick', e => {                // middle-click: a web link in a new tab
    const link = e.button === 1 ? linkAt(e) : null;
    if (link && link.kind === 'url') followUrl(link, true);
  });

  // Re-measure and redraw, e.g. after changing CFG.
  function refresh() {
    fontPx = 0;
    resize();
  }

  // ---- Start-up ------------------------------------------------------------------------------

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); contextLost = true; });
  canvas.addEventListener('webglcontextrestored', () => { initGL(); contextLost = false; dirty = true; });
  try {
    if (!initGL()) ctx2d = canvas.getContext('2d');
  } catch (e) {
    console.warn('console: WebGL unavailable, using 2D glow', e);
    gl = null;
    ctx2d = canvas.getContext('2d');
  }

  window.addEventListener('resize', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  // Canvas text needs the faces loaded (bold: <high>).
  Promise.all([document.fonts.load("16px 'Courier Prime'"), document.fonts.load("bold 16px 'Courier Prime'")]).then(refresh);

  window.MatrixConsole = {
    start, stop, run, refresh, navigate, back, makeCookie, hasCookie, deleteCookie, programs: PROGRAMS, CFG,
    get navDepth() { return navStack.length; },
    get inStartup() { return inStartup; },
    get noDisplayDelay() { return noDisplayDelay; },
    set noDisplayDelay(on) { noDisplayDelay = Boolean(on); },
  };

  resize();
  requestAnimationFrame(frame);

  // Launch: a returning visitor (flag set, exactly one <landing> program) starts on the landing
  // program. Otherwise the flag is cleared and the sequence starts at 0. (Rain starts only from a
  // program's <start-rain>.)
  const landings = PROGRAMS.filter(p => readProgram(p).landing);
  if (landings.length !== 1) deleteCookie();
  if (hasCookie()) { next = PROGRAMS.indexOf(landings[0]); inStartup = false; }
  start();
})();
