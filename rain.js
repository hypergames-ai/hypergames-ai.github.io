// Matrix rain: rain canvas behind the panel, fixed 60 Hz simulation, per-drop trail decay,
// splashes on the panel's top edge drawn on a canvas in front of it.
(() => {
  'use strict';

  const CFG = {
    cellU: 1.2,                 // glyph cell in u  (≈23 px on a 1920-wide window → ~84 columns)
    minCellPx: 0,               // floor in px; 0 = pure scaling, per spec
    dropsPerColumn: 3,          // independent drops sharing each column
    speedMin: 8,  speedMax: 24, // cells per second
    tailMin: 10,  tailMax: 30,  // cells past the bottom before recycling (at least until the trail is gone)
    fade: 0.0645,               // trail decay per simulation step for the shortest trail (1 − 0.92^0.8: 1.25× slower than 0.08)
    trailMin: 1,  trailMax: 4,  // per-drop trail length as a multiple of the shortest; bell curve between
    mutate: 0.02,               // flicker probability per drop per cell advanced
    maxWait: 2.0,               // seconds before a finished drop restarts
    density: 1.0,               // fraction of drops that are ever active
    splashChance: 0.5,          // fraction of drops that splatter on reaching the panel; the rest pass behind
    splashMin: 8, splashMax: 14,
    maxParticles: 400,
    colors: { head: '#e6ffe6', body: '#00ff41', bg: '#000' },
    reducedMotion: 'auto',      // honours prefers-reduced-motion: halves density and speed
    startDelayMs: 1500,         // black screen this long after load before the rain begins
  };

  const STEP = 1000 / 60;       // ms per simulation step
  const DT = STEP / 1000;       // s per simulation step
  const FLICKER_SPAN = 12;      // max cells above the head eligible for mutation
  const TRAIL_CUTOFF = 8 / 255; // trail cells dimmer than this aren't drawn
  const DASH_LIFE = 0.2;        // s, splat dash fade
  const DASH_U = 0.25;          // splat dash thickness in u
  const DEG = Math.PI / 180;
  const FONT = 'ui-monospace, Menlo, Consolas, monospace';
  const HEAD = 0, BODY = 1;     // sprite sheet rows

  // Half-width katakana U+FF66–U+FF9D, digits, a little ASCII.
  let GLYPHS = '';
  for (let c = 0xFF66; c <= 0xFF9D; c++) GLYPHS += String.fromCharCode(c);
  GLYPHS += '0123456789:."=*+-<>|';

  const rainCanvas = document.getElementById('rain');
  const fxCanvas = document.getElementById('fx');
  const panel = document.getElementById('panel');
  const ctx = rainCanvas.getContext('2d');      // works in device pixels (identity transform)
  const fxCtx = fxCanvas.getContext('2d');      // works in CSS pixels (dpr transform)
  const sheet = document.createElement('canvas');
  const sheetCtx = sheet.getContext('2d');
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let w = 0, h = 0, dpr = 1, u = 0, cell = 0, cols = 0, rows = 0;
  let cellDev = 0, sprite = 0;  // cell and sprite size in device px
  let motion = 1;               // 0.5 under reduced motion: scales density and speed
  let panelRect = null;         // read from the DOM on every resize; the only source of panel geometry
  let panelBorder = 0;          // px; particles may overlap the border line but never the interior
  let drops = [];
  // Per-cell grids, column-major (index = x * rows + y).
  let glyphGrid = new Uint8Array(0);   // glyph each cell currently shows
  let alphaGrid = new Float32Array(0); // brightness this frame: the brightest drop covering the cell
  let headGrid = new Uint8Array(0);    // 1 where a drop's head is
  let hiddenGrid = new Uint8Array(0);  // 1 where the cell is entirely behind the panel
  let particles = [];           // { x, y, vx, vy, age, life, size } in px, px/s, s
  let dashes = [];              // { x, age } splat marks on the panel's top edge
  let fxDirty = false;          // #fx still shows something that needs clearing
  let simTime = 0;              // seconds of simulated time; drives drop waits
  let running = false, rafId = 0, last = 0, acc = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const bell = (a, b) => a + (b - a) * (Math.random() + Math.random() + Math.random()) / 3;
  const randGlyph = () => (Math.random() * GLYPHS.length) | 0;

  function newDrop(x) {
    const d = { x, y: 0, speed: 0, lastCell: 0, tail: 0, decay: 0, reach: 0,
                state: 'falling', waitUntil: 0, splatters: false, splashed: false,
                active: Math.random() < CFG.density * motion };
    respawn(d);
    // Spread the first wave over a screen's height so drops sharing a column don't fall in step.
    d.y -= rand(0, rows);
    d.lastCell = Math.floor(d.y);
    return d;
  }

  function respawn(d) {
    d.y = rand(-30, -2);
    d.speed = rand(CFG.speedMin, CFG.speedMax) * motion;
    d.tail = rand(CFG.tailMin, CFG.tailMax);
    // Per-drop decay: the trail lasts `scale` times as long as the shortest one. `decay` is the
    // log-brightness lost per cell behind the head; `reach` is how many cells stay visible.
    const scale = bell(CFG.trailMin, CFG.trailMax);
    d.decay = Math.log(1 - CFG.fade) / scale / (d.speed * DT);
    d.reach = Math.log(TRAIL_CUTOFF) / d.decay;
    d.lastCell = Math.floor(d.y);
    d.splatters = Math.random() < CFG.splashChance;
    d.splashed = false;
    d.state = 'falling';
  }

  // Every glyph, pre-mirrored, in head and body colour, at the current device-pixel cell size.
  function buildSprites() {
    sprite = Math.ceil(cellDev);
    sheet.width = sprite * GLYPHS.length;
    sheet.height = sprite * 2;
    sheetCtx.font = `${cellDev}px ${FONT}`;
    sheetCtx.textBaseline = 'top';
    sheetCtx.textAlign = 'center';
    [CFG.colors.head, CFG.colors.body].forEach((color, row) => {
      sheetCtx.fillStyle = color;
      for (let i = 0; i < GLYPHS.length; i++) {
        // Clip to the sprite's own cell: some glyphs overshoot the em box and would bleed
        // into the neighbouring sprite, showing up as stray dots next to the drawn glyph.
        sheetCtx.save();
        sheetCtx.beginPath();
        sheetCtx.rect(i * sprite, row * sprite, sprite, sprite);
        sheetCtx.clip();
        sheetCtx.setTransform(-1, 0, 0, 1, i * sprite + sprite / 2, row * sprite);
        sheetCtx.fillText(GLYPHS[i], 0, 0);
        sheetCtx.restore();
      }
    });
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function simulate() {
    simTime += DT;

    for (const d of drops) {
      if (!d.active) continue;

      if (d.state === 'waiting') {
        if (simTime >= d.waitUntil) respawn(d);
        else continue;
      }

      d.y += d.speed * DT;
      const cur = Math.floor(d.y);
      if (cur > d.lastCell) {
        // Splash when a splattering drop's head cell bottom first crosses the panel's top edge.
        const prevBottom = (d.lastCell + 1) * cell, newBottom = (cur + 1) * cell;
        const cx = d.x * cell + cell / 2;
        if (d.splatters && !d.splashed && prevBottom < panelRect.top && newBottom >= panelRect.top &&
            cx >= panelRect.left && cx < panelRect.right) {
          d.splashed = true;
          splash(cx);
        }

        // The head writes a fresh glyph into each cell it enters; trails show what's written.
        const base = d.x * rows;
        for (let c = Math.max(d.lastCell + 1, 0); c <= cur && c < rows; c++) glyphGrid[base + c] = randGlyph();
        d.lastCell = cur;

        // Flicker: swap one glyph in the visible part of the trail.
        if (Math.random() < CFG.mutate) {
          const c = cur - 1 - Math.floor(Math.random() * Math.min(FLICKER_SPAN, d.reach));
          if (c >= 0 && c < rows) glyphGrid[base + c] = randGlyph();
        }
      }

      // Recycle once the head is `tail` cells past the bottom and the whole trail has left.
      if (d.y > rows + Math.max(d.tail, d.reach)) {
        d.state = 'waiting';
        d.waitUntil = simTime + rand(0, CFG.maxWait);
      }
    }

    stepParticles();
  }

  // Redraw every visible trail from simulation state. A trail cell was last lit at full
  // brightness when the head left it, and has decayed at the drop's own rate since.
  function renderRain() {
    ctx.fillStyle = CFG.colors.bg;
    ctx.fillRect(0, 0, rainCanvas.width, rainCanvas.height);
    alphaGrid.fill(0);
    headGrid.fill(0);

    for (const d of drops) {
      if (!d.active || d.state !== 'falling') continue;
      const cur = Math.floor(d.y), base = d.x * rows;
      for (let c = Math.min(cur - 1, rows - 1); c >= 0; c--) {
        const a = Math.exp(d.decay * (d.y - c - 1));
        if (a < TRAIL_CUTOFF) break;
        if (a > alphaGrid[base + c]) alphaGrid[base + c] = a;
      }
      if (cur >= 0 && cur < rows) { alphaGrid[base + cur] = 1; headGrid[base + cur] = 1; }
    }

    for (let x = 0, i = 0; x < cols; x++) {
      const x0 = Math.round(x * cellDev);
      for (let y = 0; y < rows; y++, i++) {
        const a = alphaGrid[i];
        if (!a || hiddenGrid[i]) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(sheet, glyphGrid[i] * sprite, headGrid[i] ? 0 : sprite, sprite, sprite,
                      x0, Math.round(y * cellDev), sprite, sprite);
      }
    }
    ctx.globalAlpha = 1;
  }

  function splash(cx) {
    const top = panelRect.top;
    const n = Math.round(rand(CFG.splashMin, CFG.splashMax));
    for (let i = 0; i < n && particles.length < CFG.maxParticles; i++) {
      // Triangular distribution over [-160°, -20°], peaking at -90° (straight up).
      const a = (-90 + 70 * (Math.random() + Math.random() - 1)) * DEG;
      const s = rand(12, 36) * u;
      particles.push({ x: cx, y: top, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
                       age: 0, life: rand(0.3, 0.7), size: rand(0.15, 0.35) * u });
    }
    dashes.push({ x: cx - cell / 2, age: 0 });
  }

  function stepParticles() {
    const g = 160 * u, { top, left, right } = panelRect;
    let n = 0;
    for (const p of particles) {
      p.age += DT;
      p.vy += g * DT;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      const landed = p.vy > 0 && p.y >= top && p.x >= left && p.x < right;
      if (p.age < p.life && !landed && p.y < h + p.size) particles[n++] = p;
    }
    particles.length = n;

    n = 0;
    for (const d of dashes) { d.age += DT; if (d.age < DASH_LIFE) dashes[n++] = d; }
    dashes.length = n;
  }

  // Everything on #fx is clipped to outside the panel's padding box: splashes may sit on the
  // border line, never inside the panel.
  function renderFx() {
    if (!fxDirty && !particles.length && !dashes.length) return;
    fxCtx.clearRect(0, 0, w, h);
    fxDirty = particles.length > 0 || dashes.length > 0;
    if (!fxDirty) return;

    const r = panelRect, b = panelBorder;
    fxCtx.save();
    fxCtx.beginPath();
    fxCtx.rect(0, 0, w, h);
    fxCtx.rect(r.left + b, r.top + b, r.width - 2 * b, r.height - 2 * b);
    fxCtx.clip('evenodd');

    const [hr, hg, hb] = HEAD_RGB, [br, bg, bb] = BODY_RGB;
    for (const p of particles) {
      const t = p.age / p.life;
      fxCtx.globalAlpha = 1 - t;
      fxCtx.fillStyle = `rgb(${hr + (br - hr) * t | 0}, ${hg + (bg - hg) * t | 0}, ${hb + (bb - hb) * t | 0})`;
      fxCtx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }

    const t = DASH_U * u;
    fxCtx.fillStyle = CFG.colors.head;
    for (const d of dashes) {
      fxCtx.globalAlpha = 1 - d.age / DASH_LIFE;
      fxCtx.fillRect(d.x, r.top - t, cell, t + b);
    }
    fxCtx.restore();
  }

  const hexRGB = hex => { const v = parseInt(hex.slice(1), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
  let HEAD_RGB = hexRGB(CFG.colors.head), BODY_RGB = hexRGB(CFG.colors.body);

  function frame(now) {
    if (!running) return;
    const dt = Math.min(Math.max(now - last, 0), 100);   // clamp: no catch-up burst
    acc += dt;
    last = now;
    let stepped = false;
    while (acc >= STEP) { simulate(); acc -= STEP; stepped = true; }
    if (stepped) renderRain();          // rain only changes on a simulation step
    renderFx();
    rafId = requestAnimationFrame(frame);
  }

  function resize(force = false) {
    const newDpr = Math.min(window.devicePixelRatio || 1, 2);
    const newW = window.innerWidth, newH = window.innerHeight;
    // visualViewport fires for pinch-zoom and on-screen keyboards without changing the layout
    // size; resizing the canvas would wipe it for nothing.
    if (!force && newW === w && newH === h && newDpr === dpr) return;
    dpr = newDpr;
    w = newW;
    h = newH;
    u = Math.max(w, h) / 100;

    for (const canvas of [rainCanvas, fxCanvas]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    motion = CFG.reducedMotion === true || (CFG.reducedMotion === 'auto' && reduceQuery.matches) ? 0.5 : 1;
    cell = Math.max(CFG.cellU * u, CFG.minCellPx);
    cellDev = cell * dpr;
    const newCols = Math.ceil(w / cell);
    const newRows = Math.ceil(h / cell);
    panelRect = panel.getBoundingClientRect();
    panelBorder = parseFloat(getComputedStyle(panel).borderTopWidth) || 0;
    particles = [];             // pixel positions are meaningless at the new size
    dashes = [];
    fxDirty = false;            // #fx was just cleared by the resize
    HEAD_RGB = hexRGB(CFG.colors.head);
    BODY_RGB = hexRGB(CFG.colors.body);
    buildSprites();

    // Drop state is in cells, so it survives a resize unless the column count changes.
    const rebuild = force || newCols !== cols;
    cols = newCols;
    if (rebuild || newRows !== rows) {
      rows = newRows;
      glyphGrid = Uint8Array.from({ length: cols * rows }, randGlyph);
      alphaGrid = new Float32Array(cols * rows);
      headGrid = new Uint8Array(cols * rows);
    }
    if (rebuild) {
      drops = [];
      for (let x = 0; x < cols; x++) for (let k = 0; k < CFG.dropsPerColumn; k++) drops.push(newDrop(x));
    }

    hiddenGrid = new Uint8Array(cols * rows);
    const { left, right, top, bottom } = panelRect;
    for (let x = 0; x < cols; x++) {
      if (x * cell < left || (x + 1) * cell > right) continue;
      for (let y = 0; y < rows; y++) if (y * cell >= top && (y + 1) * cell <= bottom) hiddenGrid[x * rows + y] = 1;
    }

    renderRain();               // resizing cleared the canvas
  }

  let resizeTimer = 0;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => resize(), 100);
  }

  // Dragging a window to a display with a different pixel ratio doesn't always fire 'resize'.
  function watchDpr() {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener('change', () => { scheduleResize(); watchDpr(); }, { once: true });
  }

  function start() {
    if (running || document.hidden) return;
    running = true;
    last = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function refresh() { resize(true); }

  function setConfig(partial) {
    Object.assign(CFG, partial);
    refresh();
  }

  window.addEventListener('resize', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  reduceQuery.addEventListener('change', refresh);
  watchDpr();

  let wantRunning = false;      // stop() from the API should survive a tab switch; false until startDelayMs
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (running) stop(); }
    else if (wantRunning) start();
  });

  window.MatrixRain = {
    start() { wantRunning = true; start(); },
    stop() { wantRunning = false; stop(); },
    setConfig,
    refresh,
  };

  resize(true);
  setTimeout(() => { wantRunning = true; start(); }, CFG.startDelayMs);
})();
