// Panel console: runs short "programs" that clear the screen and type text behind a heartbeat
// cursor. Text is laid out on a monospace grid and drawn to an offscreen canvas; WebGL composites
// it with the cursor and a two-level bloom so both glow like a CRT. Programs cycle 0, 1, 2, 3, 0, …
(() => {
  'use strict';

  const CFG = {
    charMs: 18,                 // mean gap between typed characters
    jitter: 0.5,                // ± fraction of charMs, so typing doesn't tick like a metronome
    fontVmax: 1.25,             // 1.25vmax = 24px = 18pt on a 1920-wide window
    lineHeight: 1.25,           // em
    // Halfway between the film frame's pale mint (text 135,209,189; cursor 197,218,212) and the
    // rain's green (0,255,65), so the console doesn't jump out from the rain around it.
    textColor: [68, 232, 127],
    cursorColor: [99, 237, 139],
    glow: false,                // bloom off for now (it showed a grid pattern on real GPUs)
    glowColor: [55, 127, 107],  // phosphor bloom is greener than the near-white cores it surrounds
    glowTight: [0.05, 0.35],    // [σ in cap heights, strength]: the halo hugging each glyph
    glowWide: [1.0, 2.2],       // [σ in cap heights, strength]: the broad haze around text and cursor
    beatMs: 900,                // heartbeat period: 300 on + 200 fade + 400 dark
    holdMs: 300,                // cursor fully on at the start of each beat
    fadeMs: 200,                // then decays to dark, phosphor-style; dark for the rest of the beat
  };

  // Cursor geometry in cap heights, measured from the film frame (top raised 0.14 by eye): a block
  // about 1.75 characters wide from above the capitals to below the descenders, just after the text.
  const CURSOR = { w: 1.62, h: 1.96, above: 0.44, gap: 0.15 };

  // Program syntax: plain text (\n for a new line), <delay>NNNNms</delay> to pause, <cls> to clear.
  // MM-DD-YY and HH:MM:SS become the local date and time when the program starts.
  // Every program begins with an implicit clear.
  const PROGRAMS = [
    '<delay>4000ms</delay>',
    'Modal 101 Breach/USER Violation\nHost Alarm KIWW/12:15<delay>2000ms</delay><cls>Trace program: running<delay>4000ms</delay><cls>File not found<delay>2000ms</delay><cls>',
    'Call trans opt: received. MM-DD-YY HH:MM:SS REC:Log><delay>4000ms</delay><cls>Trace program: running<delay>4000ms</delay><cls>',
    "ALERT - PERIMETER BREACH\n========================\nMODAL ERROR: IR.AA.W1M: ON DEVICE D: AN ILLEGAL MEMORY ACCESS\nERROR: MISSING FILE 'MORPH.BLD.EXE'/'HEART O' THE CITY'\nCODE: 009952310\nCONTENT: モーフィアスはここを去った\n<delay>4000ms</delay><cls>",
  ];

  const FONT_STACK = "'Courier Prime', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', monospace";
  const panel = document.getElementById('panel');
  const canvas = document.getElementById('console');
  const src = document.createElement('canvas');          // glyphs in white; coverage in alpha
  const sctx = src.getContext('2d');
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---- Screen state -------------------------------------------------------------------------

  let screenText = '';
  let typing = false;
  let beatStart = performance.now();
  let dirty = true;              // text or geometry changed: re-lay out and re-upload the glyphs

  function clearScreen() { screenText = ''; dirty = true; }
  function typeChar(ch) { screenText += ch; dirty = true; }

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
  let glyphs = [];               // [ch, x, y] baseline positions
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

  function layout() {
    const maxW = boxW - 2 * padX, maxH = boxH - 2 * padY;
    const cw = CURSOR.w * cap;
    const placed = [];
    let x = 0, line = 0;
    for (const ch of screenText) {                       // by code point, so CJK stays whole
      if (ch === '\n') { x = 0; line++; continue; }
      const w = charWidth(ch);
      if (x > 0 && x + w > maxW) { x = 0; line++; }
      placed.push([ch, x, line]);
      x += w;
    }
    let cx = x > 0 ? x + cursorOffset : 0;
    if (cx > 0 && cx + cw > maxW) { cx = 0; line++; }
    // If the text ever outgrows the panel, scroll so the cursor's line stays visible.
    const scroll = Math.max(0, (line + 1) * lineH - maxH);
    const base = l => padY + l * lineH + baseOff - scroll;
    glyphs = placed.map(([ch, gx, l]) => [ch, padX + gx, base(l)]);
    cursor = { x: padX + cx, y: base(line) - (1 + CURSOR.above) * cap, w: cw, h: CURSOR.h * cap };
  }

  function drawGlyphs(ctx, color) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${fontPx}px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    for (const [ch, x, y] of glyphs) ctx.fillText(ch, x, y);
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
    uniform vec3 uTextC, uCursorC;
    vec4 source() {              // rgb = text + cursor colour; a = their coverage
      vec2 px = v * uSize;
      vec2 lo = clamp(px - uCursor.xy * uSize + 0.5, 0.0, 1.0);
      vec2 hi = clamp(uCursor.zw * uSize - px + 0.5, 0.0, 1.0);
      float t = texture2D(uText, v).a, k = lo.x * lo.y * hi.x * hi.y * uCursorA;
      return vec4(t * uTextC + k * uCursorC, clamp(t + k, 0.0, 1.0));
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
    const base = { uText: { tex: textTex }, uCursor: cur, uCursorA: a, uTextC: rgb(CFG.textColor), uCursorC: rgb(CFG.cursorColor) };
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
  function render2D(a) {
    const css = c => `rgb(${c.join(',')})`;
    ctx2d.shadowColor = css(CFG.textColor);
    ctx2d.shadowBlur = CFG.glow ? CFG.glowTight[0] * 4 * cap * dpr : 0;
    drawGlyphs(ctx2d, css(CFG.textColor));
    ctx2d.globalAlpha = a;
    ctx2d.fillStyle = css(CFG.cursorColor);
    ctx2d.fillRect(cursor.x, cursor.y, cursor.w, cursor.h);
    ctx2d.globalAlpha = 1;
    ctx2d.shadowBlur = 0;
  }

  // ---- Frame loop ----------------------------------------------------------------------------

  let lastA = -1, contextLost = false;

  function frame(now) {
    requestAnimationFrame(frame);
    if (contextLost || !boxW) return;
    const a = cursorOpacity(now);
    if (!dirty && a === lastA) return;                    // nothing changed: skip the GPU work
    if (dirty) {
      layout();
      if (gl) {
        drawGlyphs(sctx, '#fff');
        gl.bindTexture(gl.TEXTURE_2D, textTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      }
      dirty = false;
    }
    lastA = a;
    if (gl) renderGL(a); else render2D(a);
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
    fontPx = CFG.fontVmax * Math.max(window.innerWidth, window.innerHeight) / 100;
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
      .replace(/HH:MM:SS/g, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  }

  // → [{ cls: true }, { text: '…' }, { delay: ms }, …]
  function parse(text) {
    const ops = [{ cls: true }];
    const re = /<delay>(\d+)ms<\/delay>|<cls>/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) ops.push({ text: text.slice(last, m.index) });
      ops.push(m[1] !== undefined ? { delay: Number(m[1]) } : { cls: true });
      last = re.lastIndex;
    }
    if (last < text.length) ops.push({ text: text.slice(last) });
    return ops;
  }

  // stop() and run() bump `gen`; a program from an older generation bails out at its next wait.
  let gen = 0, running = false, next = 0;
  const ABORT = Symbol('abort');
  const CATCH_UP_MS = 250;      // typing more than this far behind schedule restarts the schedule

  // Resolves after `ms` of visible time: the countdown pauses while the tab is hidden, so the
  // console stops with the rain and picks up where it left off.
  function wait(ms, g) {
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

  async function runProgram(i, g) {
    for (const op of parse(stamp(PROGRAMS[i]))) {
      if (op.cls) {
        clearScreen();
      } else if (op.delay !== undefined) {
        await wait(op.delay, g);
      } else {
        setTyping(true);                                  // steady while typing, heartbeat when idle
        // Type to a schedule, not a fixed sleep per character: timers always fire a little late,
        // and that lateness would add up. Sleep only when ahead; when behind, type straight away.
        let due = performance.now();
        for (const ch of op.text) {
          due += CFG.charMs * (1 + CFG.jitter * (2 * Math.random() - 1));
          const now = performance.now();
          if (now - due > CATCH_UP_MS) due = now;         // after a stall (hidden tab), resume rather than burst
          if (due > now) await wait(due - now, g);
          else if (g !== gen) throw ABORT;
          typeChar(ch);
        }
        setTyping(false);
      }
    }
  }

  // The one place to change program order (e.g. random cycling later).
  function nextProgram() {
    const i = next % PROGRAMS.length;
    next = i + 1;
    return i;
  }

  async function loop(g) {
    try {
      for (;;) await runProgram(nextProgram(), g);
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

  // Run program n now, then carry on cycling from n + 1.
  function run(n) {
    stop();
    next = n;
    start();
  }

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
  document.fonts.load("16px 'Courier Prime'").then(refresh);   // canvas text needs the face loaded

  window.MatrixConsole = { start, stop, run, refresh, programs: PROGRAMS, CFG };

  resize();
  requestAnimationFrame(frame);
  start();
})();
