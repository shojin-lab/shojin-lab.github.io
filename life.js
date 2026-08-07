/* Conway's Game of Life: B3/S23 with dead edges. A small ball of cells
   near the bottom-right corner grows out across the page. Decorative
   background; cell opacity is the --life-alpha token in style.css. */
(function () {
  "use strict";
  var canvas = document.querySelector(".life");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var CELL = 4;        /* CSS pixels per cell */
  var STEP_MS = 100;   /* 10 generations per second */
  var BALL_R = 14;     /* seed ball radius, in cells */
  var BALL_GAP = 12;   /* gap between ball edge and page edge, in cells */
  var DENSITY = 0.5;   /* seed density inside the ball */
  var FADE = 8;        /* reseed cross-fade, in generations */

  /* The board is (cols x rows) inside a one-cell dead ring, so the
     stepping loop never needs bounds checks and nothing wraps. */
  var cols = 0, rows = 0, W = 0, H = 0;
  var cells, next, prev, old;
  var fade = 0;
  var ink = "#1a1a1a";
  var edgesX = [], edgesY = []; /* cell boundaries in device pixels */

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

  /* A dense ball inset from the bottom-right corner. */
  function seed(a) {
    a.fill(0);
    var cx = Math.max(1 + BALL_R, cols - BALL_R - BALL_GAP);
    var cy = Math.max(1 + BALL_R, rows - BALL_R - BALL_GAP);
    var rr = BALL_R * BALL_R;
    for (var dy = -BALL_R; dy <= BALL_R; dy++) {
      for (var dx = -BALL_R; dx <= BALL_R; dx++) {
        if (dx * dx + dy * dy > rr) continue;
        if (Math.random() < DENSITY) a[(cy + dy) * W + cx + dx] = 1;
      }
    }
  }

  function step(src, dst) {
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
      ctx.globalAlpha = fade / FADE;
      paint(old);
      ctx.globalAlpha = 1 - fade / FADE;
      paint(cells);
      ctx.globalAlpha = 1;
    } else {
      paint(cells);
    }
  }

  function reseed() {
    old.set(cells);
    seed(cells);
    prev.set(cells);
    fade = FADE;
  }

  function tick() {
    step(cells, next);
    var dead = true, p1 = true, p2 = true;
    for (var i = 0; i < next.length; i++) {
      if (next[i]) dead = false;
      if (next[i] !== cells[i]) p1 = false;
      if (next[i] !== prev[i]) p2 = false;
    }
    prev.set(cells);
    var t = cells;
    cells = next;
    next = t;
    if (fade > 0) fade--;
    if (dead || p1 || p2) reseed();
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

  /* Static but interesting: let the ball bloom, draw once, no loop. */
  function still() {
    seed(cells);
    for (var i = 0; i < 80; i++) {
      step(cells, next);
      var t = cells;
      cells = next;
      next = t;
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

  /* Resizing refits the grid and reseeds from the ball: simpler than
     remapping state across grids, and the arc restarts anyway. */
  var resizeTimer = 0;
  function refit() {
    fit();
    fade = 0;
    if (motion.matches) {
      still();
    } else {
      seed(cells);
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
    seed(cells);
    prev.set(cells);
    draw();
    update();
  }
})();
