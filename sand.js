/* Digital sand: the wordmark stands in a wind and makes the weather visible.

   The mark itself never moves and never erodes. It is the plain <img>, painted above the
   canvas, so it is exactly as crisp as it is with this script switched off. What the
   letters do is generate and obstruct.

   Generate: grains a fraction of a pixel across and barely there are born under the
   letterforms, weighted toward the downwind side of every stroke, so they peel off the
   left of the mark and blow away right to left.

   Obstruct: a signed distance field of the rasterised mark gives every point in the air
   an outward normal for the nearest stroke and a sense of how close that stroke is. The
   flow is base wind, minus whatever part of it would drive into a letter, plus a shove
   out of any letter the air is inside, plus curl noise for eddies, all of it slackened
   in the lee that each letter casts downwind. Streamlines part around the letters and
   wakes trail behind them.

   Each grain keeps a fraction of a second of its own path and redraws it every frame as one
   hairline polyline, which is what turns a grain into a wisp. The canvas is cleared
   outright each time, so nothing of the page behind it is ever tinted. With no JS, or
   with reduced motion, the <img> is all there is and no canvas is created. */
(function () {
  "use strict";

  /* --- tunables ------------------------------------------------------------- */
  /* Every length and speed here is quoted for a mark REFERENCE px tall and scales with
     it, and the two counts scale with its area, so the same weather blows over a 25px
     masthead and a 64px hero. Times and opacities do not scale: a second is a second. */
  var REFERENCE = 25;        /* the mark height these numbers are quoted at, CSS px */
  var DOWNWIND = -1;         /* which way the wind blows: -1 is right to left, 1 is left to right */
  var EMIT_RATE = 78;        /* wisps born per second in the resting wind */
  var WIND = 48;             /* speed of the air over open ground, CSS px/s */
  var GUST_PERIOD = 5.5;     /* mean seconds from the end of one gust to the start of the next */
  var GUST_LENGTH = 2.2;     /* how long a gust takes to arrive and die away, s */
  var GUST_AMPLITUDE = 0.85; /* extra wind and emission at the peak of a gust, as a share of the rest */
  var TURBULENCE = 25;       /* speed of the eddies in the noise field, CSS px/s */
  var NOISE_SCALE = 0.05;    /* size of those eddies, 1 / CSS px */
  var NOISE_DRIFT = 0.85;    /* how fast the eddy field blows downwind, fields per second */
  var LOFT = 0.55;           /* vertical share of the eddies: sand streaks more than it climbs */
  var INFLUENCE = 7;         /* CSS px a letterform's presence reaches out into the air */
  var OBSTACLE_PUSH = 70;    /* how hard a letterform shoves out air that is inside it, CSS px/s */
  var OBSTACLE_SLIP = 2.5;   /* how completely a letter refuses air driving into it: 1 = perfect slip */
  var WAKE_SHELTER = 0.70;   /* share of the wind a letter takes out of its own lee */
  var WAKE_LENGTH = 15;      /* CSS px the lee of a letter reaches downwind */
  var TRAIL_FADE = 0.50;     /* seconds of path drawn behind a wisp, tapering to nothing */
  var TRAIL_POINTS = 7;      /* samples that tail is made of: more is smoother and dearer */
  var TRAIL_TAPER = 0.5;     /* share of a wisp's ink laid along its whole tail; the rest goes
                                on the half nearest the head, which is what makes it a comet */
  var LIFETIME = 2.0;        /* seconds a wisp lives, before its own scatter */
  var LIFE_SPREAD = 0.45;    /* wisp to wisp variation in that lifetime */
  var PARTICLE_ALPHA = 0.34; /* ink one wisp lays per CSS px of its length, at its strongest */
  var ALPHA_CEILING = 0.86;  /* however fine the screen's pixels are, a wisp is never solid */
  var DARK_TRIM = 0.72;      /* wisps are trimmed in the dark scheme: pale ink on dark paper blooms */
  var POPULATION_CAP = 420;  /* hard ceiling on live wisps at REFERENCE, whatever a gust asks for */
  var EDGE_BIAS = 0.55;      /* 0 = wisps leave the whole letterform, 1 = only its downwind edges */
  var RESPONSE = 14;         /* how fast a wisp takes up the speed of the air around it, per second */
  var HOVER_GAIN = 1.1;      /* extra wind and emission while the mark is hovered or focused */
  var HOVER_RESPONSE = 2.6;  /* how fast that swell rises and falls, per second */
  var ALPHA_STEPS = 8;       /* opacity buckets, so a frame of wisps costs a handful of strokes */
  var PAD_UPWIND = 16;       /* canvas overscan on the windward side of the mark, CSS px */
  var PAD_DOWNWIND = 132;    /* canvas overscan on the leeward side, CSS px: how far wisps carry */
  var PAD_Y = 22;            /* canvas overscan above and below, CSS px */
  var EDGE_FADE = 26;        /* CSS px over which a wisp leaving the canvas or the page dissolves */
  var STEP_MAX = 1 / 30;     /* longest physics step taken, s: a stall must not teleport the air */
  var WATCH_EVERY = 0.4;     /* seconds between checks that the page has changed under the effect */

  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var dark = window.matchMedia("(prefers-color-scheme: dark)");

  var link = document.querySelector(".wordmark");
  var img = link && link.querySelector("img");
  if (!link || !img || !window.requestAnimationFrame) return;

  var canvas = null, ctx = null, art = null;
  var dpr = 1, k = 1, markW = 0, markH = 0, totalW = 0, totalH = 0;
  var padA = 0, padB = 0, padY = 0;   /* canvas overscan around the mark, CSS px */
  var cap = 0;               /* POPULATION_CAP for the size the mark actually is */
  var floorX = 0, ceilX = 0; /* canvas x where the page begins and ends, so wisps leave rather than clip */
  var ink = "#1a1a1a";
  var raf = 0, prev = 0, clock = 0, emitAcc = 0;
  var hover = 0, hovered = false, onScreen = true, watchAcc = 0;
  var gustAt = 1.6;          /* clock time the next gust starts, s */

  /* the steady flow, one sample per CSS px of canvas, in CSS px/s */
  var fw = 0, fh = 0, flowX = null, flowY = null;
  /* where wisps are born: cell indices into the same grid, with a cumulative weight */
  var seedAt = null, seedCdf = null, seedTotal = 0;

  /* live wisps, as parallel arrays so a frame allocates nothing */
  var px, py, vx, vy, age, life, amp, live = 0;
  /* the tail: a ring of TRAIL_POINTS - 1 past positions per wisp, sampled on a clock so
     the tail is the same length in seconds whatever the refresh rate is */
  var hx, hy, tail = 0, head = 0, sampleAcc = 0, sampleEvery = 0;
  /* one path per opacity step, for whole tails and for their near halves */
  var bucket = [], nearer = [], nearTail = 0;

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

  function readInk() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    if (v) ink = v;
  }

  /* --- the mark, as coverage on a one pixel grid ---------------------------- */
  /* Drawn three times over and box averaged, so a cell carries how much of it the
     letterform actually fills and the edges of the field stay soft. */
  function rasterise(art) {
    var SS = 3;
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(markW)) * SS;
    c.height = Math.max(1, Math.round(markH)) * SS;
    var g = c.getContext("2d");
    g.drawImage(art, 0, 0, c.width, c.height);
    var data = g.getImageData(0, 0, c.width, c.height).data;
    var cover = new Float32Array(fw * fh);
    var w = Math.round(markW), h = Math.round(markH);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0;
        for (var sy = 0; sy < SS; sy++) {
          for (var sx = 0; sx < SS; sx++) {
            sum += data[(((y * SS + sy) * c.width) + (x * SS + sx)) * 4 + 3];
          }
        }
        cover[(y + padY) * fw + (x + padA)] = sum / (SS * SS * 255);
      }
    }
    return cover;
  }

  /* separable box blur with a running sum, so the cost does not follow the radius */
  function blur(src, r) {
    var tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    var n = 2 * r + 1, x, y, i, sum;
    for (y = 0; y < fh; y++) {
      var row = y * fw;
      sum = src[row] * (r + 1);
      for (i = 1; i <= r; i++) sum += src[row + Math.min(i, fw - 1)];
      for (x = 0; x < fw; x++) {
        tmp[row + x] = sum / n;
        sum += src[row + Math.min(x + r + 1, fw - 1)] - src[row + Math.max(x - r, 0)];
      }
    }
    for (x = 0; x < fw; x++) {
      sum = tmp[x] * (r + 1);
      for (i = 1; i <= r; i++) sum += tmp[Math.min(i, fh - 1) * fw + x];
      for (y = 0; y < fh; y++) {
        out[y * fw + x] = sum / n;
        sum += tmp[Math.min(y + r + 1, fh - 1) * fw + x] - tmp[Math.max(y - r, 0) * fw + x];
      }
    }
    return out;
  }

  /* Distance to the nearest set cell, by two chamfer sweeps. The weights are the ones
     that keep a 3x3 chamfer within a few percent of true Euclidean distance. */
  function chamfer(solid) {
    var A = 0.96194, B = 1.36039, BIG = 1e9;
    var d = new Float32Array(fw * fh);
    var i, x, y, v;
    for (i = 0; i < d.length; i++) d[i] = solid[i] ? 0 : BIG;
    for (y = 0; y < fh; y++) {
      for (x = 0; x < fw; x++) {
        i = y * fw + x;
        v = d[i];
        if (y > 0) {
          if (x > 0) v = Math.min(v, d[i - fw - 1] + B);
          v = Math.min(v, d[i - fw] + A);
          if (x < fw - 1) v = Math.min(v, d[i - fw + 1] + B);
        }
        if (x > 0) v = Math.min(v, d[i - 1] + A);
        d[i] = v;
      }
    }
    for (y = fh - 1; y >= 0; y--) {
      for (x = fw - 1; x >= 0; x--) {
        i = y * fw + x;
        v = d[i];
        if (y < fh - 1) {
          if (x > 0) v = Math.min(v, d[i + fw - 1] + B);
          v = Math.min(v, d[i + fw] + A);
          if (x < fw - 1) v = Math.min(v, d[i + fw + 1] + B);
        }
        if (x < fw - 1) v = Math.min(v, d[i + 1] + A);
        d[i] = v;
      }
    }
    return d;
  }

  /* --- the flow the letters shape ------------------------------------------ */
  /* soft is the letterforms' presence in the air: 1 at a stroke's surface, over 1 inside
     it, falling to nothing INFLUENCE px away. It is built from a signed distance field
     rather than a blur, and that choice is the whole difference at this size: the
     gradient of a blurred wordmark points at the word's centre of mass, so every letter
     pushes the same way and the mark reads as one lump, while the gradient of a distance
     field points away from the NEAREST stroke, so each letter is its own obstacle with a
     halo as wide as you like. From soft: an outward normal, a shove out of any letter the
     air is inside, and the removal of whatever part of the wind would drive into a
     surface, which is what makes a streamline part rather than pass through. The lee is a
     downwind sweep of the mark itself: a letter shelters what is behind it until the wind
     recovers, and that slack is where a wake becomes visible. */
  function buildFlow(cover) {
    var n = fw * fh, i, x, y;
    var solid = new Uint8Array(n), air = new Uint8Array(n);
    for (i = 0; i < n; i++) { solid[i] = cover[i] >= 0.5 ? 1 : 0; air[i] = 1 - solid[i]; }
    var out = chamfer(solid), into = chamfer(air);
    var reach = INFLUENCE * k;
    var soft = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var c = cover[i];
      /* On a boundary cell the surface is a fraction of a pixel away, and at this size
         that fraction is most of a stroke, so read it off the coverage, not off the grid. */
      var sd = (c > 0.03 && c < 0.97) ? 0.5 - c : out[i] - into[i];
      soft[i] = Math.max(0, 1 - sd / reach);
    }
    soft = blur(soft, 1);            /* takes the staircase off a one pixel distance field */
    var dense = blur(cover, 1);      /* where a letter actually is, for the shove outward */

    var lee = new Float32Array(n);
    var keep = Math.exp(-1 / (WAKE_LENGTH * k));
    var from = DOWNWIND < 0 ? fw - 1 : 0, to = DOWNWIND < 0 ? -1 : fw;
    for (y = 0; y < fh; y++) {
      var carry = 0;
      for (x = from; x !== to; x += DOWNWIND) {
        i = y * fw + x;
        carry = Math.max(cover[i], carry * keep);
        lee[i] = carry;
      }
    }
    lee = blur(lee, Math.max(1, Math.round(3 * k)));   /* one soft shadow, not a row of stripes */

    flowX = new Float32Array(n);
    flowY = new Float32Array(n);
    for (y = 0; y < fh; y++) {
      for (x = 0; x < fw; x++) {
        i = y * fw + x;
        var xm = x > 0 ? i - 1 : i, xp = x < fw - 1 ? i + 1 : i;
        var ym = y > 0 ? i - fw : i, yp = y < fh - 1 ? i + fw : i;
        var gx = (soft[xp] - soft[xm]) * 0.5;
        var gy = (soft[yp] - soft[ym]) * 0.5;
        var len = Math.sqrt(gx * gx + gy * gy);
        var nx = 0, ny = 0;
        if (len > 1e-6) { nx = -gx / len; ny = -gy / len; }   /* outward from the letter */
        var wx = WIND * k * DOWNWIND * (1 - WAKE_SHELTER * Math.min(1, lee[i]));
        var wy = 0;
        var drive = wx * nx + wy * ny;
        if (drive < 0) {                                      /* air driving into a surface */
          var slip = Math.min(1, soft[i] * OBSTACLE_SLIP);
          wx -= slip * drive * nx;
          wy -= slip * drive * ny;
        }
        flowX[i] = wx + OBSTACLE_PUSH * k * dense[i] * nx;
        flowY[i] = wy + OBSTACLE_PUSH * k * dense[i] * ny;
      }
    }
    return soft;
  }

  /* --- where wisps come from ----------------------------------------------- */
  /* Only from inside the letterform, so a wisp is hidden by the mark until it has left
     it, and mostly from the downwind side of a stroke, where the air is letting go. */
  function buildSeeds(cover, soft) {
    var at = [], cdf = [], total = 0;
    for (var y = 1; y < fh - 1; y++) {
      for (var x = 1; x < fw - 1; x++) {
        var i = y * fw + x;
        if (cover[i] < 0.5) continue;
        var gx = (soft[i + 1] - soft[i - 1]) * 0.5;
        var gy = (soft[i + fw] - soft[i - fw]) * 0.5;
        var len = Math.sqrt(gx * gx + gy * gy);
        /* the outward normal is -g/|g|, so this is how squarely the cell faces downwind */
        var downwind = len > 1e-6 ? Math.max(0, -DOWNWIND * gx / len) : 0;
        total += cover[i] * (1 - EDGE_BIAS + EDGE_BIAS * downwind);
        at.push(i);
        cdf.push(total);
      }
    }
    seedAt = new Int32Array(at);
    seedCdf = new Float32Array(cdf);
    seedTotal = total;
  }

  /* --- wisps ---------------------------------------------------------------- */
  function allocate() {
    cap = Math.round(POPULATION_CAP * k * k);
    tail = Math.max(1, TRAIL_POINTS - 1);
    sampleEvery = TRAIL_FADE / tail;
    sampleAcc = 0;
    head = 0;
    hx = new Float32Array(cap * tail);
    hy = new Float32Array(cap * tail);
    px = new Float32Array(cap);
    py = new Float32Array(cap);
    vx = new Float32Array(cap);
    vy = new Float32Array(cap);
    age = new Float32Array(cap);
    life = new Float32Array(cap);
    amp = new Float32Array(cap);
    live = 0;
    nearTail = Math.max(1, Math.round(tail / 2));
    bucket = [];
    nearer = [];
    for (var b = 0; b < ALPHA_STEPS; b++) { bucket.push([]); nearer.push([]); }
  }

  function birth() {
    if (live >= cap || !seedTotal) return;
    var r = Math.random() * seedTotal;
    var lo = 0, hi = seedCdf.length - 1;
    while (lo < hi) {                                  /* the weighted pick, by bisection */
      var mid = (lo + hi) >> 1;
      if (seedCdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    var cell = seedAt[lo];
    var i = live++;
    px[i] = (cell % fw) + Math.random();
    py[i] = Math.floor(cell / fw) + Math.random();
    for (var t = 0; t < tail; t++) {      /* a new wisp has no tail yet, only a position */
      hx[i * tail + t] = px[i];
      hy[i * tail + t] = py[i];
    }
    vx[i] = 0;
    vy[i] = 0;
    age[i] = 0;
    life[i] = LIFETIME * (1 + (Math.random() - 0.5) * 2 * LIFE_SPREAD);
    amp[i] = 0.55 + 0.45 * Math.random();
  }

  function kill(i) {
    var last = --live;
    if (i === last) return;
    px[i] = px[last]; py[i] = py[last];
    vx[i] = vx[last]; vy[i] = vy[last];
    age[i] = age[last]; life[i] = life[last]; amp[i] = amp[last];
    for (var t = 0; t < tail; t++) {
      hx[i * tail + t] = hx[last * tail + t];
      hy[i * tail + t] = hy[last * tail + t];
    }
  }

  /* Bilinear read of the steady flow. Two returns, so they land in module scope
     rather than in an object this loop would have to allocate. */
  var sx = 0, sy = 0;
  function sampleFlow(x, y) {
    var cx = x - 0.5, cy = y - 0.5;
    var x0 = Math.floor(cx), y0 = Math.floor(cy);
    var tx = cx - x0, ty = cy - y0;
    if (x0 < 0) { x0 = 0; tx = 0; } else if (x0 > fw - 2) { x0 = fw - 2; tx = 1; }
    if (y0 < 0) { y0 = 0; ty = 0; } else if (y0 > fh - 2) { y0 = fh - 2; ty = 1; }
    var a = y0 * fw + x0, b = a + fw;
    var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
    var w01 = (1 - tx) * ty, w11 = tx * ty;
    sx = flowX[a] * w00 + flowX[a + 1] * w10 + flowX[b] * w01 + flowX[b + 1] * w11;
    sy = flowY[a] * w00 + flowY[a + 1] * w10 + flowY[b] * w01 + flowY[b + 1] * w11;
  }

  /* A gust: a fast arrival and a long dying fall, peaking at exactly one, then a
     jittered gap so the weather never gets metronomic. Hover swells the same wind. */
  function envelope(dt) {
    hover += ((hovered ? 1 : 0) - hover) * (1 - Math.exp(-HOVER_RESPONSE * dt));
    var u = (clock - gustAt) / GUST_LENGTH;
    var bump = 0;
    if (u >= 1) {
      gustAt = clock + GUST_PERIOD * (0.6 + 0.8 * Math.random());
    } else if (u > 0) {
      bump = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.6)), 1.4);
    }
    return 1 + GUST_AMPLITUDE * bump + HOVER_GAIN * hover;
  }

  var NOISE_EPS = 0.7;       /* finite difference used to curl the noise, in noise units */

  function step(dt, env) {
    var take = 1 - Math.exp(-RESPONSE * dt);
    var drift = clock * NOISE_DRIFT;
    var turb = TURBULENCE * k * Math.sqrt(env);
    var scale = NOISE_SCALE / k;
    for (var i = 0; i < live; i++) {
      age[i] += dt;
      if (age[i] >= life[i] || px[i] < floorX || px[i] > ceilX ||
          py[i] < -4 || py[i] > totalH + 4) {
        kill(i); i--; continue;
      }
      sampleFlow(px[i], py[i]);
      /* curl of the value noise, so the eddies swirl instead of pumping air in and out */
      var nx = px[i] * scale - DOWNWIND * drift, ny = py[i] * scale;
      var ex = noise(nx, ny + NOISE_EPS) - noise(nx, ny - NOISE_EPS);
      var ey = noise(nx - NOISE_EPS, ny) - noise(nx + NOISE_EPS, ny);
      var wx = sx * env + turb * ex;
      var wy = sy * env + turb * LOFT * ey;
      vx[i] += (wx - vx[i]) * take;
      vy[i] += (wy - vy[i]) * take;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
    }
  }

  function emit(dt, env) {
    var born = EMIT_RATE * k * k * env * dt;
    emitAcc += born;
    /* a frame that ran long is owed its own wisps and no more, so a stall cannot cash
       itself out as a cloud of sand the moment the tab comes back */
    if (emitAcc > born + 8) emitAcc = born + 8;
    while (emitAcc >= 1) { emitAcc -= 1; birth(); }
  }

  /* Every wisp's recent path, on a clock rather than per frame, so a tail is TRAIL_FADE
     seconds long at any refresh rate. */
  function sample(dt) {
    sampleAcc += dt;
    if (sampleAcc < sampleEvery) return;
    sampleAcc = sampleAcc > sampleEvery * 2 ? 0 : sampleAcc - sampleEvery;
    head = (head + 1) % tail;
    for (var i = 0; i < live; i++) {
      hx[i * tail + head] = px[i];
      hy[i * tail + head] = py[i];
    }
  }

  /* --- drawing -------------------------------------------------------------- */
  /* The canvas is cleared outright every frame and every wisp redraws its whole tail
     from its stored path. The obvious alternative, a persistent buffer faded a little
     each frame, cannot actually reach zero: the fade is a multiply on eight bit alpha,
     so anything at or under 0.5 / fade rounds back to itself and a permanent haze in
     the shape of the plume settles over the page. Clearing cannot leave residue, and it
     costs a clearRect and four short segments per wisp. Segments are batched into a
     path per opacity step, so a frame is ALPHA_STEPS strokes however busy the air is. */
  function draw() {
    var b, i, t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (b = 0; b < ALPHA_STEPS; b++) { bucket[b].length = 0; nearer[b].length = 0; }
    var fade = EDGE_FADE * k;

    for (i = 0; i < live; i++) {
      var u = age[i] / life[i];
      var a = amp[i] * Math.min(1, u * 9) * (1 - u * u);
      /* a wisp reaching the end of the canvas, or the edge of the page, thins out
         over EDGE_FADE rather than being cut off at a straight line */
      if (px[i] < floorX + fade) a *= Math.max(0, (px[i] - floorX) / fade);
      else if (px[i] > ceilX - fade) a *= Math.max(0, (ceilX - px[i]) / fade);
      if (a <= 0.03) continue;
      /* head first, then back along the ring: the whole tail once, its near half a
         second time, so the wisp darkens toward its head in two strokes rather than
         one per segment. Two figures per wisp instead of TRAIL_POINTS is most of the
         frame cost, and a joined path also stops the ink doubling at every joint. */
      var af = a * TRAIL_TAPER, an = a - af;
      var far = af > 0.03 ? bucket[Math.min(ALPHA_STEPS - 1, (af * ALPHA_STEPS) | 0)] : null;
      var near = an > 0.03 ? nearer[Math.min(ALPHA_STEPS - 1, (an * ALPHA_STEPS) | 0)] : null;
      var base = i * tail, x = px[i] * dpr, y = py[i] * dpr;
      if (far) far.push(x, y);
      if (near) near.push(x, y);
      for (t = 0; t < tail; t++) {
        var s = (head - t + tail * 2) % tail;
        x = hx[base + s] * dpr;
        y = hy[base + s] * dpr;
        if (far) far.push(x, y);
        if (near && t < nearTail) near.push(x, y);
      }
    }

    /* A wisp is one device pixel wide: the finest mark the screen can make, and the one
       stroke width Skia has a dedicated path for, which is worth about five times the
       frame cost of any wider line. Opacity carries the pixel ratio instead, so a wisp
       lays the same ink per CSS px of length whatever the display is. */
    var peak = Math.min(ALPHA_CEILING, PARTICLE_ALPHA * dpr) * (dark.matches ? DARK_TRIM : 1);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (b = 0; b < ALPHA_STEPS; b++) {
      var wide = bucket[b], slim = nearer[b];
      if (!wide.length && !slim.length) continue;
      ctx.globalAlpha = peak * (b + 0.5) / ALPHA_STEPS;
      ctx.beginPath();
      trace(wide, TRAIL_POINTS);
      trace(slim, nearTail + 1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* one polyline per run of `n` points in a flat list of coordinates */
  function trace(pts, n) {
    var stride = n * 2;
    for (var i = 0; i < pts.length; i += stride) {
      ctx.moveTo(pts[i], pts[i + 1]);
      for (var j = 2; j < stride; j += 2) ctx.lineTo(pts[i + j], pts[i + j + 1]);
    }
  }

  /* The change event on a MediaQueryList is not something to bet the colours on: a list
     made early in a script can go on reporting the right answer in `matches` and never
     fire at all, which leaves wisps drawn in the old scheme's ink on the new scheme's
     paper. Reading the ink back off the page every so often does not care how the theme
     moved, and costs one style read twice a second. A different ink re-seeds the air. */
  function watch(dt) {
    watchAcc += dt;
    if (watchAcc < WATCH_EVERY) return false;
    watchAcc = 0;
    if (motion.matches) { teardown(); return true; }
    var was = ink;
    readInk();
    if (ink === was || !art) return false;
    build(art);
    return true;
  }

  function frame(now) {
    if (!prev) prev = now;
    var dt = Math.min(STEP_MAX, (now - prev) / 1000);
    prev = now;
    if (watch(dt)) return;        /* torn down, or rebuilt: that path owns the loop now */
    clock += dt;
    var env = envelope(dt);
    sample(dt);
    step(dt, env);
    emit(dt, env);
    draw();
    raf = requestAnimationFrame(frame);
  }

  /* --- the loop, started and stopped in exactly one place ------------------- */
  function go() {
    if (raf || !ctx || motion.matches || document.hidden || !onScreen) return;
    prev = 0;
    raf = requestAnimationFrame(frame);
  }

  function halt() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    prev = 0;
  }

  /* --- setup ---------------------------------------------------------------- */
  function load(src) {
    return new Promise(function (done, fail) {
      var im = new Image();
      im.onload = function () { done(im); };
      im.onerror = fail;
      im.src = src;
    });
  }

  /* The canvas overhangs its anchor, mostly downwind, so wisps have somewhere to go.
     floorX and ceilX are where the viewport cuts across it: a wisp blown off the page
     dissolves at that line instead of being clipped by it. */
  function fit() {
    dpr = window.devicePixelRatio || 1;
    var box = img.getBoundingClientRect();
    markW = box.width || 105;
    markH = box.height || 25;
    k = markH / REFERENCE;
    var down = Math.round(PAD_DOWNWIND * k), up = Math.round(PAD_UPWIND * k);
    padA = DOWNWIND < 0 ? down : up;
    padB = DOWNWIND < 0 ? up : down;
    padY = Math.round(PAD_Y * k);
    totalW = Math.round(markW) + padA + padB;
    totalH = Math.round(markH) + padY * 2;
    canvas.style.width = totalW + "px";
    canvas.style.height = totalH + "px";
    canvas.style.left = -padA + "px";
    canvas.style.top = -padY + "px";
    canvas.width = Math.round(totalW * dpr);
    canvas.height = Math.round(totalH * dpr);
    fw = totalW;
    fh = totalH;
    var left = box.left - padA;
    var room = document.documentElement.clientWidth;
    floorX = Math.max(0, -left);
    ceilX = Math.min(totalW, room - left);
  }

  function build(art) {
    halt();
    readInk();
    fit();
    var cover = rasterise(art);
    var soft = buildFlow(cover);
    buildSeeds(cover, soft);
    allocate();
    clock = 0;
    emitAcc = 0;
    hover = 0;
    gustAt = 1.6;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    go();
  }

  function teardown() {
    halt();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    ctx = null;
    flowX = null;
    flowY = null;
    seedAt = null;
    seedCdf = null;
  }

  function start() {
    if (motion.matches || canvas) return;
    load(img.currentSrc || img.src)
      .then(function (im) {
        art = im;
        if (motion.matches) return;
        canvas = document.createElement("canvas");
        canvas.className = "sand";
        canvas.setAttribute("aria-hidden", "true");
        ctx = canvas.getContext("2d");
        link.appendChild(canvas);
        build(art);
      })
      .catch(function () { teardown(); });
  }

  /* --- being a good citizen -------------------------------------------------- */
  /* An ambient effect that runs while nobody is looking is a bug. It stops when the tab
     is hidden and when the masthead has scrolled away, and it keeps its own clock, so
     it resumes where it left off rather than jumping. */
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) go(); else halt();
    }, { rootMargin: "80px" }).observe(link);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) halt(); else go();
  });

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    if (!canvas) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (canvas && art) build(art); }, 200);
  });

  link.addEventListener("mouseenter", function () { hovered = true; });
  link.addEventListener("mouseleave", function () { hovered = false; });
  link.addEventListener("focus", function () { hovered = true; });
  link.addEventListener("blur", function () { hovered = false; });

  /* A scheme flip changes the ink and the paper under it, so the air is rebuilt and
     re-seeded on the new colour. The art itself is not re-fetched: the two SVGs are the
     same shapes in different ink and only their alpha is ever read. */
  function onScheme() {
    if (canvas && art) build(art);
  }

  function onMotion() {
    if (motion.matches) teardown();
    else start();
  }

  if (dark.addEventListener) {
    dark.addEventListener("change", onScheme);
    motion.addEventListener("change", onMotion);
  }

  if (img.complete) start();
  else img.addEventListener("load", start);
})();
