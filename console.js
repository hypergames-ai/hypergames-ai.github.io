// Panel console: runs short "programs" that clear the screen and type text behind a heartbeat
// cursor. Text is laid out on a monospace grid and drawn to an offscreen canvas; WebGL composites
// it with the cursor and a two-level bloom so both glow like a CRT. The programs run once, in order.
(() => {
  'use strict';

  const CFG = {
    charMs: 18,                 // mean gap between typed characters
    jitter: 0.5,                // ± fraction of charMs, so typing doesn't tick like a metronome
    eraseMinMs: 30,            // <replace>: gap between backspace pecks, random in [min, max]
    eraseMaxMs: 100,
    fontVmax: 1.25,             // 1.25vmax = 24px = 18pt on a 1920-wide window
    lineHeight: 1.25,           // em
    // Halfway between the film frame's pale mint (text 135,209,189; cursor 197,218,212) and the
    // rain's green (0,255,65), so the console doesn't jump out from the rain around it.
    textColor: [68, 232, 127],
    cursorColor: [99, 237, 139],
    brokenLinkColor: [128, 128, 128],   // <prog> links whose tag doesn't exist
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

  // Program syntax: plain text (\n for a new line), <delay>NNNNms</delay> to pause, <cls> to clear,
  // <replace hold="NNNNms">old<with hold="NNNNms">new</replace> to type old, hold, backspace it,
  // hold again and type new (both holds optional).
  // MM-DD-YY, HH:MM:SS and HH:MM become the local date and time when the program starts.
  // Every program begins with an implicit clear.
  // Pages: <tag>label</tag> as the very first characters names a program (label: a-z, 0-9, _);
  // <prog ref="label">text</prog> links to it (underlined, clickable; grey if no such tag); a
  // followed link shows that program under a clickable "< BACK". <prog ref="label" one-way> has no
  // BACK: the linked program becomes the base page and the nav stack starts over from it.
  // Returning visitors: <stop make-cookie/> sets a presence flag (the "cookie") when its program
  // finishes; <delete-cookie/> clears it. At launch, if exactly one program starts with <landing/>
  // (the very first characters) and the flag is set, the rain starts at once and that program runs
  // first; otherwise the flag is cleared and program 0 runs. Unrecognised tags render as nothing. <stop/> as the very last
  // characters ends the startup sequence after that program.
  // Templates: <gosub ref="label"/> pastes that tagged program in place; its commands run inline.
  // Web links: <a href="…">text</a> (relative or absolute; add download or download="name" to
  // download instead, target="_blank" for a new tab).
  const PROGRAMS = [
    '<delay>2200ms</delay>',
    'Modal 101 Breach/USER Violation\nHost Alarm KIWW/HH:MM<delay>2500ms</delay><cls>Trace program: running<delay>3000ms</delay><cls>File not found<delay>1500ms</delay><cls>',
    'Call trans opt: received. MM-DD-YY HH:MM:SS REC:Log><delay>4000ms</delay><cls>Trace program: running<delay>3000ms</delay><cls>',
    "ALERT - PERIMETER BREACH\n========================\nMODAL ERROR: IR.AA.W1M: ON DEVICE D: AN ILLEGAL MEMORY ACCESS\nERROR: MISSING FILE 'MORPH.BLD.EXE'/'HEART O' THE CITY'\nCODE: 009952310\nCONTENT: モーフィアスはここを去った\n<delay>4000ms</delay><cls>",
    'Program restart initiated: closing modal...<delay>600ms</delay>.<delay>700ms</delay>.<delay>600ms</delay>.<delay>600ms</delay>....<delay>800ms</delay>RESTARTING PROGRAM<delay>2000ms</delay><cls><delay>1000ms</delay>',
    '<landing/>Welcome to <replace hold="2000ms">The Desert of the Real!<with hold="1000ms">The Oasis of the Hyperreal!</replace><delay>1000ms</delay>\n\nhypergames.ai is an information 𝕏 website.\nFind out <prog ref="q1">more</prog> here.\n<delay>150000ms</delay><stop make-cookie/>',
    '<tag>q1</tag>This is an informational page.<delay>1000ms</delay>The Matrix has you<stop/>',
  ];

  const FONT_STACK = "'Courier Prime', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', monospace";
  const panel = document.getElementById('panel');
  const canvas = document.getElementById('console');
  const src = document.createElement('canvas');          // glyphs in white; coverage in alpha
  const sctx = src.getContext('2d');
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---- Screen state -------------------------------------------------------------------------

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

  function layout() {
    const maxW = boxW - 2 * padX, maxH = boxH - 2 * padY;
    const cw = CURSOR.w * cap;
    const placed = [];
    let x = 0, line = 0, k = 0;
    for (const ch of screenText) {                       // by code point, so CJK stays whole
      const attr = attrs[k++];
      if (ch === '\n') { x = 0; line++; continue; }
      const w = charWidth(ch);
      if (x > 0 && x + w > maxW) { x = 0; line++; }
      placed.push([ch, x, line, w, attr]);
      x += w;
    }
    let cx = x > 0 ? x + cursorOffset : 0;
    if (cx > 0 && cx + cw > maxW) { cx = 0; line++; }
    // If the text ever outgrows the panel, scroll so the cursor's line stays visible.
    const scroll = Math.max(0, (line + 1) * lineH - maxH);
    const base = l => padY + l * lineH + baseOff - scroll;
    glyphs = placed.map(([ch, gx, l, w, attr]) => [ch, padX + gx, base(l), w, attr]);
    cursor = { x: padX + cx, y: base(line) - (1 + CURSOR.above) * cap, w: cw, h: CURSOR.h * cap };
    linkRects = glyphs.filter(g => g[4]).map(([, gx, y, w, attr]) => ({ x: gx, top: y - baseOff, w, h: lineH, attr }));
    if (hoverLink && !attrs.includes(hoverLink)) setHover(null);   // the hovered link left the screen
  }

  const css = c => `rgb(${c.join(',')})`;

  // Glyphs in their own colours, with link underlines: prog and broken links always, < BACK
  // only while hovered.
  function drawGlyphs(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${fontPx}px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    const ulOff = 0.2 * cap, ulH = Math.max(1 / dpr, 0.08 * cap);
    for (const [ch, x, y, w, attr] of glyphs) {
      ctx.fillStyle = css(attr && attr.kind === 'broken' ? CFG.brokenLinkColor : CFG.textColor);
      ctx.fillText(ch, x, y);
      if (attr && (attr.kind !== 'back' || attr === hoverLink)) ctx.fillRect(x, y + ulOff, w, ulH);
    }
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
  function render2D(a) {
    ctx2d.shadowColor = css(CFG.textColor);
    ctx2d.shadowBlur = CFG.glow ? CFG.glowTight[0] * 4 * cap * dpr : 0;
    drawGlyphs(ctx2d);
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
        drawGlyphs(sctx);
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
      .replace(/HH:MM:SS/g, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
      .replace(/HH:MM/g, `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  }

  // Program-level markers, not displayed: <landing/> (only as the very first characters), then
  // <tag>label</tag>, and <stop/> or <stop make-cookie/> as the very last characters.
  function readProgram(src) {
    let body = src, label = null, stop = false, makeCookie = false;
    const landing = body.startsWith('<landing/>');
    if (landing) body = body.slice('<landing/>'.length);
    const t = /^<tag>([a-z0-9_]+)<\/tag>/.exec(body);
    if (t) { label = t[1]; body = body.slice(t[0].length); }
    const st = /<stop(\s+make-cookie)?\/>$/.exec(body);
    if (st) { stop = true; makeCookie = Boolean(st[1]); body = body.slice(0, st.index); }
    return { landing, label, stop, makeCookie, body };
  }

  // Anything tag-shaped that isn't recognised renders as nothing. "< BACK" or "a < b" (a space
  // after the "<") isn't tag-shaped and stays literal.
  const UNKNOWN_TAG = '<\\/?[A-Za-z][^<>]*>';
  const stripTags = text => text.replace(new RegExp(UNKNOWN_TAG, 'g'), '');

  // Scans every time: the list is short, and programs may be pushed at runtime.
  function taggedIndex(label) {
    return PROGRAMS.findIndex(p => readProgram(p).label === label);
  }

  // <gosub ref="label"/>: paste the tagged program's body (its <landing/>, <tag> and trailing
  // <stop …/> stripped) into the caller's text, so its commands run inline. Recursive; a label
  // already being expanded (a cycle) or a missing ref expands to nothing.
  function expandGosubs(text, chain = []) {
    return text.replace(/<gosub ref="([^"]*)"\s*\/?>/g, (_, label) => {
      const i = taggedIndex(label);
      if (i < 0 || chain.includes(label) || chain.length >= 16) return '';
      return expandGosubs(readProgram(PROGRAMS[i]).body, [...chain, label]);
    });
  }

  // → [{ cls: true }, { text: '…', link?, back? }, { delay: ms }, { erase: n }, …]
  // A linked page (back = true) gets a typed "< BACK" line after every clear.
  function parse(text, back = false) {
    const ops = [{ cls: true }];
    const re = new RegExp(/<delay>(\d+)ms<\/delay>|<cls>|<replace(?:\s+hold="(\d+)ms")?>([\s\S]*?)<with(?:\s+hold="(\d+)ms")?>([\s\S]*?)<\/replace>|<prog ref="([^"]*)"(\s+one-way)?>([^<]*)<\/prog>|<a\s+([^<>]*)>([^<]*)<\/a>/.source
                        + '|' + UNKNOWN_TAG, 'g');
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) ops.push({ text: text.slice(last, m.index) });
      if (m[1] !== undefined) ops.push({ delay: Number(m[1]) });
      else if (m[0] === '<cls>') ops.push({ cls: true });
      else if (m[0] === '<delete-cookie/>') ops.push({ deleteCookie: true });
      else if (m[6] !== undefined) ops.push({ text: m[8], link: m[6], oneWay: Boolean(m[7]) });
      else if (m[3] !== undefined) {
        // <replace>: old and new are plain text (tags stripped), so the backspace count is exact.
        // The <replace> hold runs before backspacing; the <with> hold after it, before new is typed.
        // The markers let a noDisplayDelay run drop the effect and type only the new text.
        const oldText = stripTags(m[3]), newText = stripTags(m[5]);
        if (oldText) ops.push({ text: oldText, replaceOld: true });
        ops.push({ delay: Number(m[2] || 0), replaceHold: true }, { erase: [...oldText].length });
        if (m[4]) ops.push({ delay: Number(m[4]), replaceHold: true });
        if (newText) ops.push({ text: newText });
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
    return back ? ops.flatMap(op => op.cls ? [op, { text: '< BACK', back: true }, { text: '\n\n' }] : [op]) : ops;
  }

  // The "cookie": a presence-only flag in localStorage (works from file://, no expiry to manage).
  // Blocked storage reads as "no cookie" and ignores writes.
  const COOKIE_KEY = 'hypergames.cookie';
  function makeCookie() { try { localStorage.setItem(COOKIE_KEY, '1'); } catch (e) { /* storage blocked */ } }
  function deleteCookie() { try { localStorage.removeItem(COOKIE_KEY); } catch (e) { /* storage blocked */ } }
  function hasCookie() { try { return localStorage.getItem(COOKIE_KEY) !== null; } catch (e) { return false; } }

  // stop() and run() bump `gen`; a program from an older generation bails out at its next wait.
  let gen = 0, running = false, next = 0;
  let noDisplayDelay = false;   // one-shot: next program skips delays and <replace> (BACK sets it)
  let navStack = [];            // pages to go back to (program indices); empty = on the startup sequence
  let pageIndex = -1;           // the program on screen
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

  async function runProgram(i, g, back = false) {
    pageIndex = i;
    const skip = noDisplayDelay;   // no pauses, no typing gaps, no <replace> effect: the text appears at once
    const prog = readProgram(PROGRAMS[i]);
    for (const op of parse(stamp(expandGosubs(prog.body, prog.label ? [prog.label] : [])), back)) {
      if (skip && (op.delay !== undefined || op.erase !== undefined || op.replaceOld)) continue;
      if (op.cls) {
        clearScreen();
      } else if (op.deleteCookie) {
        deleteCookie();
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
        const attr = op.back ? { kind: 'back' }
          : op.link !== undefined ? { kind: taggedIndex(op.link) >= 0 ? 'prog' : 'broken', ref: op.link, oneWay: op.oneWay }
          : op.href !== undefined ? { kind: 'url', href: op.href, download: op.download, newTab: op.newTab } : null;
        if (skip) { for (const ch of op.text) typeChar(ch, attr); continue; }
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
          typeChar(ch, attr);
        }
        setTyping(false);
      }
    }
    if (skip) noDisplayDelay = false;                     // one-shot: only once the program is done
    if (prog.makeCookie) makeCookie();                    // <stop make-cookie/>: only on a completed run
  }

  // The one place to change program order (e.g. random cycling later). -1 = no more programs.
  function nextProgram() {
    return next < PROGRAMS.length ? next++ : -1;
  }

  // Runs the remaining programs once, stopping early after a program that ends with <stop/>; the
  // console stays as the last program left it.
  async function loop(g) {
    try {
      for (let i; (i = nextProgram()) >= 0;) {
        await runProgram(i, g);
        if (readProgram(PROGRAMS[i]).stop) break;
      }
      running = false;
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

  // A linked page runs on its own: it doesn't carry on into the programs after it.
  function showPage(i) {
    stop();
    running = true;
    const g = ++gen;
    runProgram(i, g, true).then(() => { if (g === gen) running = false; }, e => { if (e !== ABORT) throw e; });
  }

  // A one-way link has no < BACK: it clears the stack and makes the program the base page, as run() does.
  function navigate(label, { oneWay = false } = {}) {
    const i = taggedIndex(label);
    if (i < 0) return;                                    // broken link: no-op
    if (oneWay) { run(i); return; }
    navStack.push(pageIndex);
    showPage(i);
  }

  // Re-render the previous page instantly. Back on the startup sequence's page, the sequence then
  // carries on after it, unless that program ends with <stop/>.
  function back() {
    if (!navStack.length) return;
    const i = navStack.pop();
    noDisplayDelay = true;
    if (navStack.length) showPage(i);
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
    if (link && link.kind === 'prog') navigate(link.ref, { oneWay: link.oneWay });
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
  document.fonts.load("16px 'Courier Prime'").then(refresh);   // canvas text needs the face loaded

  window.MatrixConsole = {
    start, stop, run, refresh, navigate, back, makeCookie, hasCookie, deleteCookie, programs: PROGRAMS, CFG,
    get navDepth() { return navStack.length; },
    get noDisplayDelay() { return noDisplayDelay; },
    set noDisplayDelay(on) { noDisplayDelay = Boolean(on); },
  };

  resize();
  requestAnimationFrame(frame);

  // Launch: a returning visitor (flag set, exactly one <landing/> program) gets the rain at once
  // and the landing program first. Otherwise the flag is cleared and the sequence starts at 0.
  const landings = PROGRAMS.filter(p => readProgram(p).landing);
  if (landings.length !== 1) deleteCookie();
  if (hasCookie()) {
    if (window.MatrixRain) window.MatrixRain.start();    // its own delayed start becomes a no-op
    next = PROGRAMS.indexOf(landings[0]);
  }
  start();
})();
