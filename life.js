/* Conway's Game of Life: B3/S23 on a torus, ink on paper. Decorative. */
(function () {
  "use strict";
  var canvas = document.querySelector(".life");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var N = 128;         /* cells per side */
  var SIZE = 160;      /* CSS pixels */
  var STEP_MS = 100;   /* 10 generations per second */
  var DENSITY = 0.38;  /* seed density inside the centre patch */
  var FADE = 8;        /* reseed cross-fade, in generations */

  var cells = new Uint8Array(N * N);
  var next = new Uint8Array(N * N);
  var prev = new Uint8Array(N * N); /* state two generations back */
  var old = new Uint8Array(N * N);  /* fading-out state after a reseed */
  var fade = 0;

  var ink = "#1a1a1a";
  var paper = "#f0efec";
  var edges = []; /* cell boundaries in device pixels, so cells stay crisp */

  function readTheme() {
    var s = getComputedStyle(document.documentElement);
    ink = s.getPropertyValue("--ink").trim() || ink;
    paper = s.getPropertyValue("--paper").trim() || paper;
  }

  function fit() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = canvas.width;
    edges = [];
    for (var i = 0; i <= N; i++) edges.push(Math.round(i * canvas.width / N));
  }

  /* A vigorous patch in the centre quarter of the board; life expands
     outward into empty space. */
  function seed(a) {
    a.fill(0);
    var lo = N >> 2;
    var hi = N - lo;
    for (var y = lo; y < hi; y++) {
      for (var x = lo; x < hi; x++) {
        a[y * N + x] = Math.random() < DENSITY ? 1 : 0;
      }
    }
  }

  function step(src, dst) {
    for (var y = 0; y < N; y++) {
      var up = ((y + N - 1) % N) * N;
      var row = y * N;
      var down = ((y + 1) % N) * N;
      for (var x = 0; x < N; x++) {
        var l = (x + N - 1) % N;
        var r = (x + 1) % N;
        var n = src[up + l] + src[up + x] + src[up + r] +
                src[row + l] + src[row + r] +
                src[down + l] + src[down + x] + src[down + r];
        dst[row + x] = (n === 3 || (n === 2 && src[row + x])) ? 1 : 0;
      }
    }
  }

  function paint(a) {
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        if (a[y * N + x]) {
          ctx.fillRect(edges[x], edges[y],
                       edges[x + 1] - edges[x], edges[y + 1] - edges[y]);
        }
      }
    }
  }

  function draw() {
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    var t = cells; cells = next; next = t;
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

  /* Static but interesting: settle a fresh soup, draw once, no loop. */
  function still() {
    seed(cells);
    for (var i = 0; i < 60; i++) {
      step(cells, next);
      var t = cells; cells = next; next = t;
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
    fit();
    draw();
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
