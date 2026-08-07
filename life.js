/* Conway's Game of Life: B3/S23 on a torus the size of the viewport.
   An arc of colonization: a ball seeded in the text column blooms and
   settles; each time the board goes quiet a small seed drips onto the
   colony's outward edge and ignites it further; when enough of the
   page is claimed, the board cross-fades out and the arc restarts.
   Decorative background; cell opacity is --life-alpha in style.css. */
(function () {
  "use strict";
  var canvas = document.querySelector(".life");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var CELL = 2;         /* CSS pixels per cell */
  var STEP_MS = 100;    /* 10 generations per second */
  var SEED_R_PX = 56;   /* arc seed ball radius, CSS pixels */
  var DRIP_R_PX = 40;   /* drip ball radius, CSS pixels */
  var DENSITY = 0.5;    /* density inside a ball */
  var FADE = 8;         /* drip fade-in, in generations */
  var ARC_FADE = 16;    /* whole-board rebirth cross-fade */
  var QUIET = 50;       /* gens of periodic activity = board is quiet */
  var PMAX = 6;         /* activity periods checked, covers p2+p3 ash */
  var DRIP_MAX = 450;   /* max gens between events, whatever activity says */
  var ARC_MAX = 12000;  /* max gens per arc */
  var COVER = 0.38;     /* claimed fraction that ends the arc */
  var BLOCK = 16;       /* cells per occupancy block, for coverage/frontier */

  /* Board is (cols x rows) inside a one-cell ghost ring; wrapEdges
     copies the opposite edges into the ring before each step, which
     keeps the inner loop branch-free while the world wraps. */
  var cols = 0, rows = 0, W = 0, H = 0;
  var cells, next, prev, old;
  var fade = 0, fadeTotal = FADE;
  var ink = "#1a1a1a";
  var edgesX = [], edgesY = []; /* cell boundaries in device pixels */
  var sinceDrip = 0, age = 0;
  /* Activity histogram ring: runs[p] counts how long the per-gen
     activity has equalled its own value p+1 gens earlier. Settled ash
     (blinkers, pulsars, orbiting gliders) is periodic; active growth
     is not. */
  var actHist = [], actRuns = [], actHead = 0;

  function resetActivity() {
    actHist = [];
    actRuns = [];
    for (var p = 0; p < PMAX; p++) {
      actHist.push(-1);
      actRuns.push(0);
    }
    actHead = 0;
    sinceDrip = 0;
  }

  function readTheme() {
    var s = getComputedStyle(document.documentElement);
    ink = s.getPropertyValue("--ink").trim() || ink;
  }

  function fit() {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    cols = Math.max(24, Math.round(rect.width / CELL));
    rows = Math.max(24, Math.round(rect.height / CELL));
    W = cols + 2;
    H = rows + 2;
    cells = new Uint8Array(W * H);
    next = new Uint8Array(W * H);
    prev = new Uint8Array(W * H);
    old = new Uint8Array(W * H);
    edgesX = [];
    edgesY = [];
    for (var i = 0; i <= cols; i++) edgesX.push(Math.round(i * canvas.width / cols));
    for (var j = 0; j <= rows; j++) edgesY.push(Math.round(j * canvas.height / rows));
  }

  function ball(a, cx, cy, r) {
    var rr = r * r;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rr) continue;
        var x = ((cx + dx - 1 + cols) % cols) + 1;
        var y = ((cy + dy - 1 + rows) % rows) + 1;
        if (Math.random() < DENSITY) a[y * W + x] = 1;
      }
    }
  }

  /* Arc seed: a ball centred on the text column, mid-viewport. */
  function seedArc(a) {
    a.fill(0);
    var page = document.querySelector(".page");
    var r = page ? page.getBoundingClientRect() : canvas.getBoundingClientRect();
    var cx = Math.round((r.left + r.width / 2) / CELL);
    var cy = Math.round(rows / 2);
    ball(a, Math.min(cols, Math.max(1, cx)), cy, Math.round(SEED_R_PX / CELL));
    resetActivity();
    age = 0;
  }

  /* Coverage and frontier over a coarse block grid: a block is claimed
     if it holds any live cell. A drip site is an empty block touching
     a claimed one, preferring the most open neighbourhood, so new
     seeds land on the colony's outward edge rather than inside it. */
  function dripSite() {
    var BW = Math.ceil(cols / BLOCK), BH = Math.ceil(rows / BLOCK);
    var occ = new Uint8Array(BW * BH);
    for (var y = 1; y <= rows; y++) {
      var row = y * W;
      var by = ((y - 1) / BLOCK) | 0;
      for (var x = 1; x <= cols; x++) {
        if (cells[row + x]) occ[by * BW + (((x - 1) / BLOCK) | 0)] = 1;
      }
    }
    var claimed = 0;
    for (var i = 0; i < occ.length; i++) claimed += occ[i];
    var best = [], bestCrowd = 1e9;
    for (var b = 0; b < BW * BH; b++) {
      if (occ[b]) continue;
      var bx = b % BW, byy = (b / BW) | 0;
      var adj = 0, crowd = 0;
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          var v = occ[((byy + dy + BH) % BH) * BW + ((bx + dx + BW) % BW)];
          crowd += v;
          if (v && dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) adj = 1;
        }
      }
      if (!adj) continue;
      if (crowd < bestCrowd) {
        bestCrowd = crowd;
        best = [b];
      } else if (crowd === bestCrowd) {
        best.push(b);
      }
    }
    var pick = best.length ? best[(Math.random() * best.length) | 0] : -1;
    return {
      coverage: claimed / (BW * BH),
      x: pick < 0 ? -1 : 1 + (pick % BW) * BLOCK + (BLOCK >> 1),
      y: pick < 0 ? -1 : 1 + ((pick / BW) | 0) * BLOCK + (BLOCK >> 1),
    };
  }

  function wrapEdges(a) {
    for (var y = 1; y <= rows; y++) {
      var row = y * W;
      a[row] = a[row + cols];
      a[row + cols + 1] = a[row + 1];
    }
    a.copyWithin(0, rows * W, (rows + 1) * W);
    a.copyWithin((rows + 1) * W, W, 2 * W);
  }

  function step(src, dst) {
    wrapEdges(src);
    for (var y = 1; y <= rows; y++) {
      var row = y * W;
      var up = row - W;
      var down = row + W;
      for (var x = 1; x <= cols; x++) {
        var n = src[up + x - 1] + src[up + x] + src[up + x + 1] +
                src[row + x - 1] + src[row + x + 1] +
                src[down + x - 1] + src[down + x] + src[down + x + 1];
        dst[row + x] = (n === 3 || (n === 2 && src[row + x])) ? 1 : 0;
      }
    }
  }

  function paint(a) {
    for (var y = 1; y <= rows; y++) {
      var row = y * W;
      var y0 = edgesY[y - 1];
      var h = edgesY[y] - y0;
      for (var x = 1; x <= cols; x++) {
        if (a[row + x]) {
          ctx.fillRect(edgesX[x - 1], y0, edgesX[x] - edgesX[x - 1], h);
        }
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;
    if (fade > 0) {
      ctx.globalAlpha = fade / fadeTotal;
      paint(old);
      ctx.globalAlpha = 1 - fade / fadeTotal;
      paint(cells);
      ctx.globalAlpha = 1;
    } else {
      paint(cells);
    }
  }

  /* The board went quiet: drip a seed on the colony edge, or, if the
     page is substantially claimed (or the arc is old, or nothing is
     left to grow from), cross-fade to a fresh arc. */
  function onQuiet() {
    var site = dripSite();
    old.set(cells);
    if (site.x < 0 || site.coverage >= COVER || age >= ARC_MAX) {
      seedArc(cells);
      fade = fadeTotal = ARC_FADE;
    } else {
      ball(cells, site.x, site.y, Math.round(DRIP_R_PX / CELL));
      fade = fadeTotal = FADE;
    }
    prev.set(cells);
    resetActivity();
  }

  function tick() {
    step(cells, next);
    var act = 0, pop = 0, p2 = true;
    for (var y = 1; y <= rows; y++) {
      var row = y * W;
      for (var x = 1; x <= cols; x++) {
        var v = next[row + x];
        pop += v;
        if (v !== cells[row + x]) act++;
        if (v !== prev[row + x]) p2 = false;
      }
    }
    prev.set(cells);
    var t = cells;
    cells = next;
    next = t;
    if (fade > 0) fade--;
    age++;
    sinceDrip++;
    var periodic = false;
    for (var p = 0; p < PMAX; p++) {
      actRuns[p] = act === actHist[(actHead - p + PMAX) % PMAX] ? actRuns[p] + 1 : 0;
      if (actRuns[p] >= QUIET) periodic = true;
    }
    actHead = (actHead + 1) % PMAX;
    actHist[actHead] = act;
    /* Quiet: dead, still, period-2, periodic activity (settled ash and
       orbiting gliders), or overdue for an event. */
    if (pop === 0 || act === 0 || p2 || periodic || sinceDrip >= DRIP_MAX) {
      onQuiet();
    }
  }

  var running = false;
  var rafId = 0;
  var last = 0;

  function frame(now) {
    if (!running) return;
    if (now - last >= STEP_MS) {
      last = now;
      tick();
      draw();
    }
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  /* Static mid-arc frame: colony plus a couple of drips, drawn once. */
  function still() {
    seedArc(cells);
    var gens = [140, 100, 60];
    for (var d = 0; d < gens.length; d++) {
      if (d > 0) {
        var site = dripSite();
        if (site.x >= 0) ball(cells, site.x, site.y, Math.round(DRIP_R_PX / CELL));
      }
      for (var i = 0; i < gens[d]; i++) {
        step(cells, next);
        var t = cells;
        cells = next;
        next = t;
      }
    }
    fade = 0;
    draw();
  }

  var motion = matchMedia("(prefers-reduced-motion: reduce)");
  var scheme = matchMedia("(prefers-color-scheme: dark)");

  function update() {
    if (motion.matches || document.hidden) stop();
    else start();
  }

  /* Resizing refits the grid and restarts the arc: simpler than
     remapping colony state across grids. */
  var resizeTimer = 0;
  function refit() {
    fit();
    fade = 0;
    if (motion.matches) {
      still();
    } else {
      seedArc(cells);
      prev.set(cells);
      draw();
    }
  }

  scheme.addEventListener("change", function () {
    readTheme();
    draw();
  });
  motion.addEventListener("change", function () {
    if (motion.matches) {
      stop();
      still();
    } else {
      update();
    }
  });
  document.addEventListener("visibilitychange", update);
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, 200);
  });

  readTheme();
  fit();
  if (motion.matches) {
    still();
  } else {
    seedArc(cells);
    prev.set(cells);
    draw();
    update();
  }
})();
