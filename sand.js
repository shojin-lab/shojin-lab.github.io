/* Digital sand: the wordmark, seeded as one grain per filled cell of its own SVG,
   on the same 2px grid as the Game of Life background. A gust arrives from the
   right, the mark granulates, the right edge of each glyph lets go first and the
   grains tumble left; as the gust passes a spring gathers them home and the mark
   re-crisps. One cycle on load, another on hover. Progressive enhancement: with
   no JS, or with reduced motion, the plain <img> is what shows. */
(function () {
  "use strict";

  /* --- tunables ------------------------------------------------------------ */
  var GRAIN_STEP = 2;        /* CSS px per grain: the Game of Life cell size */
  var WIND_STRENGTH = 1000;  /* leftward acceleration at the peak of a gust, CSS px/s^2 */
  var GUST_PERIOD = 2800;    /* one whole cycle: gust plus the time allowed to re-gather, ms */
  var GUST_DURATION = 950;   /* how long the wind actually blows inside that cycle, ms */
  var DETACH_BIAS = 0.8;     /* 0 = grains let go at random, 1 = strictly right edge first */
  var TURBULENCE = 190;      /* tumble from the noise field, CSS px/s^2, so grains do not slide */
  var SPRING = 75;           /* pull home, CSS px/s^2 per CSS px of displacement */
  var DAMPING = 4;           /* velocity decay per second: how thick the air is */
  var FADE = 0.45;           /* how far a fully detached grain thins out */

  var DETACH_REACH = 0.52;   /* share of the mark a gust gets through before it passes */
  var GRIP = 0.06;           /* spring left on a detached grain: it let go, it did not forget home */
  var RELEASE = 22;          /* how fast a grain lets go and takes hold again, per second */
  var WIND_SPREAD = 0.55;    /* grain to grain variation in how far the air takes one */
  var SMEAR = 0.014;         /* seconds of tail drawn behind a moving grain, so speed reads */
  var EDGE_FADE = 18;        /* CSS px over which a grain blown off the page dissolves */
  var LOFT = 0.65;           /* vertical share of the turbulence: grains streak more than they hop */
  var GRANULATE = 1.6;       /* how quickly a lifting grain trades places with the crisp mark */
  var QUIVER = 0.55;         /* displacement, CSS px, a grain may shift before it starts to show */
  var NOISE_SCALE = 0.055;   /* size of the turbulence eddies: 1 / CSS px */
  var NOISE_DRIFT = 1.1;     /* how fast the eddies blow through, fields per second */
  var PAD_LEFT = 96;         /* canvas overscan downwind, CSS px */
  var PAD_RIGHT = 10;        /* canvas overscan upwind, CSS px */
  var PAD_Y = 20;            /* canvas overscan above and below, CSS px */
  var STEP_MS = 1000 / 120;  /* fixed physics step, so the feel does not follow the refresh rate */

  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var dark = window.matchMedia("(prefers-color-scheme: dark)");

  var link = document.querySelector(".wordmark");
  var img = link && link.querySelector("img");
  if (!link || !img || !window.requestAnimationFrame) return;

  var canvas = null, ctx = null, art = null;
  var grains = [];
  var dpr = 1, markW = 0, markH = 0, totalW = 0, totalH = 0, viewLeft = 0;
  var ink = "#1a1a1a";
  var raf = 0, gustStart = 0, prev = 0, lag = 0;

  /* --- cheap value noise: an integer hash on a lattice, smoothstepped ------- */
  function hash(x, y) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) & 65535) / 32768 - 1;
  }

  function noise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash(xi, yi), b = hash(xi + 1, yi);
    var c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    var top = a + (b - a) * u;
    return top + (c + (d - c) * u - top) * v;
  }

  /* Fast attack, long tail: a gust hits and then dies away. Peaks at 1. */
  function gust(t) {
    if (t <= 0 || t >= GUST_DURATION) return 0;
    var p = t / GUST_DURATION;
    return Math.pow(p, 0.4) * Math.pow(1 - p, 1.2) / 0.4064;
  }

  function readInk() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    if (v) ink = v;
  }

  /* --- seeding -------------------------------------------------------------- */
  /* Draw the logo three times over at grain resolution and box average it, so each
     grain carries the coverage of the cell it stands for and the edges stay soft. */
  function sample() {
    var SS = 3;
    var gw = Math.max(1, Math.round(markW / GRAIN_STEP));
    var gh = Math.max(1, Math.round(markH / GRAIN_STEP));
    var c = document.createElement("canvas");
    c.width = gw * SS;
    c.height = gh * SS;
    var g = c.getContext("2d");
    g.drawImage(art, 0, 0, c.width, c.height);
    var data = g.getImageData(0, 0, c.width, c.height).data;
    var cover = new Float32Array(gw * gh);
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var sum = 0;
        for (var sy = 0; sy < SS; sy++) {
          for (var sx = 0; sx < SS; sx++) {
            sum += data[(((y * SS + sy) * c.width) + (x * SS + sx)) * 4 + 3];
          }
        }
        cover[y * gw + x] = sum / (SS * SS * 255);
      }
    }
    return { w: gw, h: gh, cover: cover };
  }

  /* Columns of the mark run together into glyphs across the gaps between letters,
     so each glyph can shed its own right edge while the front sweeps the whole mark. */
  function glyphSpans(s) {
    var spans = [], start = -1;
    for (var x = 0; x <= s.w; x++) {
      var filled = false;
      if (x < s.w) {
        for (var y = 0; y < s.h; y++) {
          if (s.cover[y * s.w + x] > 0.35) { filled = true; break; }
        }
      }
      if (filled && start < 0) start = x;
      if (!filled && start >= 0) { spans.push([start, x - 1]); start = -1; }
    }
    return spans;
  }

  function seed() {
    var s = sample();
    var spans = glyphSpans(s);
    var owner = new Int16Array(s.w);
    for (var i = 0; i < s.w; i++) owner[i] = -1;
    for (var k = 0; k < spans.length; k++) {
      for (var x = spans[k][0]; x <= spans[k][1]; x++) owner[x] = k;
    }
    grains = [];
    for (var gy = 0; gy < s.h; gy++) {
      for (var gx = 0; gx < s.w; gx++) {
        var cov = s.cover[gy * s.w + gx];
        if (cov <= 0.35) continue;
        var span = owner[gx] >= 0 ? spans[owner[gx]] : [0, s.w - 1];
        var wide = Math.max(1, span[1] - span[0]);
        var inGlyph = (gx - span[0]) / wide;          /* 0 at the glyph's left edge, 1 at its right */
        var inMark = s.w > 1 ? gx / (s.w - 1) : 0;    /* the same across the whole wordmark */
        var thr = DETACH_BIAS * (0.3 * (1 - inGlyph) + 0.7 * (1 - inMark)) +
                  (1 - DETACH_BIAS) * Math.random();
        var hx = PAD_LEFT + gx * GRAIN_STEP;
        var hy = PAD_Y + gy * GRAIN_STEP;
        grains.push({
          hx: hx, hy: hy, x: hx, y: hy, vx: 0, vy: 0,
          thr: thr, free: 0, vis: 0, alpha: 0.45 + 0.55 * Math.min(1, cov),
          lift: 1 + (Math.random() - 0.5) * 2 * WIND_SPREAD
        });
      }
    }
  }

  /* --- physics -------------------------------------------------------------- */
  function step(dt, t) {
    var env = gust(t);
    var damp = Math.exp(-DAMPING * dt);
    var take = 1 - Math.exp(-RELEASE * dt);
    var drift = (t / 1000) * NOISE_DRIFT;
    var worst = 0;
    for (var i = 0; i < grains.length; i++) {
      var p = grains[i];
      p.free += ((env * DETACH_REACH > p.thr ? 1 : 0) - p.free) * take;
      var k = SPRING * (1 - p.free * (1 - GRIP));
      var stir = 0.07 + p.free;
      var nx = p.x * NOISE_SCALE, ny = p.y * NOISE_SCALE;
      var ax = -k * (p.x - p.hx) -
               WIND_STRENGTH * env * p.lift * (0.03 + 0.97 * p.free) +
               TURBULENCE * stir * noise(nx + drift, ny);
      var ay = -k * (p.y - p.hy) +
               TURBULENCE * LOFT * stir * noise(nx + drift + 91.7, ny - drift);
      p.vx = (p.vx + ax * dt) * damp;
      p.vy = (p.vy + ay * dt) * damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      var dx = p.x - p.hx, dy = p.y - p.hy;
      var d = Math.sqrt(dx * dx + dy * dy);
      /* A grain shows once it has lifted; the mark loses exactly what the air takes. */
      p.vis = Math.max(0, Math.min(1, Math.max(p.free * GRANULATE, (d - QUIVER) / GRAIN_STEP)));
      if (d > worst) worst = d;
    }
    return { env: env, worst: worst };
  }

  function settled(t, worst) {
    if (t < GUST_DURATION) return false;
    if (worst > 0.12) return false;
    for (var i = 0; i < grains.length; i++) {
      if (Math.abs(grains[i].vx) + Math.abs(grains[i].vy) > 1.5) return false;
    }
    return true;
  }

  function home() {
    for (var i = 0; i < grains.length; i++) {
      var p = grains[i];
      p.x = p.hx; p.y = p.hy; p.vx = 0; p.vy = 0; p.free = 0; p.vis = 0;
    }
  }

  /* --- drawing -------------------------------------------------------------- */
  /* The mark is drawn once, crisp, from its own SVG. Every grain that has lifted is
     then punched out of it and redrawn where the air has carried it, so the letterform
     wears away exactly where the wind has taken it and re-crisps when the grains land. */
  function draw() {
    var i, p, size = Math.max(1, Math.round(GRAIN_STEP * dpr));
    var bite = Math.max(1, Math.round((GRAIN_STEP + 1) * dpr));
    var lip = (bite - size) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(art, PAD_LEFT * dpr, PAD_Y * dpr, markW * dpr, markH * dpr);

    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (i = 0; i < grains.length; i++) {
      p = grains[i];
      if (p.vis < 0.01) continue;
      ctx.globalAlpha = p.vis;
      ctx.fillRect(Math.round(p.hx * dpr) - lip, Math.round(p.hy * dpr) - lip, bite, bite);
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = ink;
    for (i = 0; i < grains.length; i++) {
      p = grains[i];
      if (p.vis < 0.01) continue;
      var a = p.vis * p.alpha * (1 - FADE * p.free);
      if (viewLeft + p.x < EDGE_FADE) {          /* off the page is gone, not guillotined */
        a *= Math.max(0, (viewLeft + p.x) / EDGE_FADE);
        if (a < 0.01) continue;
      }
      var tx = p.x + p.vx * SMEAR, ty = p.y + p.vy * SMEAR;
      /* a grain moving fast leaves the air behind it darker, which is what reads as speed */
      if (Math.abs(tx - p.x) >= 1 || Math.abs(ty - p.y) >= 1) {
        ctx.globalAlpha = a * 0.4;
        ctx.fillRect(Math.round(tx * dpr), Math.round(ty * dpr), size, size);
      }
      ctx.globalAlpha = a;
      ctx.fillRect(Math.round(p.x * dpr), Math.round(p.y * dpr), size, size);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!prev) prev = now;
    lag += Math.min(100, now - prev);
    prev = now;
    var t = now - gustStart;
    var worst = 0;
    while (lag >= STEP_MS) {
      worst = step(STEP_MS / 1000, t - lag).worst;
      lag -= STEP_MS;
    }
    draw();
    if (settled(t, worst) || t > GUST_PERIOD) {
      home();
      draw();
      raf = 0;
      prev = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function blow() {
    if (motion.matches || !ctx || !grains.length || raf) return;
    home();
    viewLeft = canvas.getBoundingClientRect().left;
    gustStart = performance.now();
    prev = 0;
    lag = 0;
    raf = requestAnimationFrame(frame);
  }

  /* --- setup ---------------------------------------------------------------- */
  function artSrc() {
    return dark.matches ? "/assets/shojin_dark.svg" : "/assets/shojin_light.svg";
  }

  function load(src) {
    return new Promise(function (done, fail) {
      var im = new Image();
      im.onload = function () { done(im); };
      im.onerror = fail;
      im.src = src;
    });
  }

  function fit() {
    dpr = window.devicePixelRatio || 1;
    var box = img.getBoundingClientRect();
    markW = box.width || 105;
    markH = box.height || 25;
    totalW = markW + PAD_LEFT + PAD_RIGHT;
    totalH = markH + PAD_Y * 2;
    canvas.style.width = totalW + "px";
    canvas.style.height = totalH + "px";
    canvas.style.left = -PAD_LEFT + "px";
    canvas.style.top = -PAD_Y + "px";
    canvas.width = Math.round(totalW * dpr);
    canvas.height = Math.round(totalH * dpr);
    viewLeft = canvas.getBoundingClientRect().left;
  }

  function build() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    readInk();
    fit();
    seed();
    home();
    draw();
  }

  function teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    ctx = null;
    link.classList.remove("sand-on");
  }

  function start() {
    if (motion.matches) return;
    load(artSrc())
      .then(function (im) {
        art = im;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.className = "sand";
          canvas.setAttribute("aria-hidden", "true");
          ctx = canvas.getContext("2d");
          link.appendChild(canvas);
          link.classList.add("sand-on");
        }
        build();
        setTimeout(blow, 420);
      })
      .catch(function () { teardown(); });
  }

  var resizeTimer = 0;
  function relayout() {
    if (!canvas) return;
    if (raf) { resizeTimer = setTimeout(relayout, 200); return; }  /* not mid-gust */
    build();
  }
  window.addEventListener("resize", function () {
    if (!canvas) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 200);
  });

  link.addEventListener("mouseenter", blow);
  link.addEventListener("focus", blow);

  function onScheme() {
    if (!canvas) return;
    load(artSrc()).then(function (im) { art = im; build(); });
  }

  function onMotion() {
    if (motion.matches) teardown();
    else if (!canvas) start();
  }

  if (dark.addEventListener) {
    dark.addEventListener("change", onScheme);
    motion.addEventListener("change", onMotion);
  }

  if (img.complete) start();
  else img.addEventListener("load", start);
})();
