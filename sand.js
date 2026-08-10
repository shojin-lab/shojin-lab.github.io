/* Digital sand: two loose pieces of the wordmark blow away in the wind, and the rest of
   it stands in that wind and shapes it.

   The mark never moves and never erodes. It is the plain <img>, painted above the canvas,
   so it is exactly as crisp as it is with this script switched off.

   Shedding: only two pieces of the mark give up sand, the macron over the o and the hook
   of the j, both found by flood filling the mask rather than written down. Grains are
   born across the entire width of each piece, weighted toward its downwind end, and are
   hidden by the piece they came off until the air has carried them clear.

   Standing: a signed distance field of the whole rasterised mark gives every point in the
   air an outward normal for the nearest stroke and a sense of how close it is. The flow is
   base wind, minus whatever part of it would drive into a letter, plus a shove out of any
   letter the air is inside, plus curl noise for eddies, all of it slackened in the lee
   each letter casts downwind. So the sand off the macron has to get past the h and the s.

   Grains are drawn as whole cells of the same two pixel grid the Game of Life background
   uses, never antialiased and never moving by less than a cell, and they glitch: some
   tear downwind of where they are, some smear into a run of cells, some drop out for an
   instant. A grain's trail is the cells it stood in a few sample times ago.

   The canvas is cleared outright every frame, so nothing of the page behind it is ever
   tinted. With no JS, or with reduced motion, the <img> is all there is. */
(function () {
  "use strict";

  /* --- tunables ------------------------------------------------------------- */
  /* Every length and speed here is quoted for a mark REFERENCE px tall and scales with
     it, and the two counts scale with its area, so the same weather blows over a 25px
     masthead and a 64px hero. Times and opacities do not scale: a second is a second. */
  var REFERENCE = 25;        /* the mark height these numbers are quoted at, CSS px */
  var DOWNWIND = -1;         /* which way the wind blows: -1 is right to left, 1 is left to right */
  var EMIT_RATE = 88;        /* grains born per second in the resting wind */
  var WIND = 48;             /* speed of the air over open ground, CSS px/s */
  var GUST_PERIOD = 5.5;     /* mean seconds from the end of one gust to the start of the next */
  var GUST_LENGTH = 2.2;     /* how long a gust takes to arrive and die away, s */
  var GUST_AMPLITUDE = 0.85; /* extra wind and emission at the peak of a gust, as a share of the rest */
  var TURBULENCE = 13;       /* speed of the eddies in the noise field, CSS px/s */
  var NOISE_SCALE = 0.05;    /* size of those eddies, 1 / CSS px */
  var NOISE_DRIFT = 0.85;    /* how fast the eddy field blows downwind, fields per second */
  var LOFT = 0.18;           /* vertical share of the eddies: sand runs straight far more than it climbs */
  var INFLUENCE = 7;         /* CSS px a letterform's presence reaches out into the air */
  var OBSTACLE_PUSH = 70;    /* how hard a letterform shoves out air that is inside it, CSS px/s */
  var OBSTACLE_SLIP = 2.5;   /* how completely a letter refuses air driving into it: 1 = perfect slip */
  var WAKE_SHELTER = 0.70;   /* share of the wind a letter takes out of its own lee */
  var WAKE_LENGTH = 15;      /* CSS px the lee of a letter reaches downwind */
  var GRAIN = 3;             /* CSS px across one grain, and the cell size of the grid it moves on */
  var TRAIL_FADE = 0.34;     /* seconds of path a grain leaves behind it */
  var TRAIL_POINTS = 5;      /* cells that trail is made of, oldest fainter than newest */
  var GLITCH_RATE = 9;       /* how often a grain draws a new hand of glitch, times a second */
  var GLITCH_CHANCE = 0.13;  /* share of grains misbehaving at any instant */
  var GLITCH_TEAR = 7;       /* CSS px a torn grain jumps downwind of where it really is */
  var GLITCH_SMEAR = 5;      /* cells a smeared grain drags out into a horizontal run */
  var GLITCH_DROP = 0.09;    /* share of grains that blink out entirely for an instant */
  var LIFETIME = 2.0;        /* seconds a grain lives, before its own scatter */
  var LIFE_SPREAD = 0.45;    /* grain to grain variation in that lifetime */
  var PARTICLE_ALPHA = 0.52; /* opacity of one grain at its strongest */
  var DARK_TRIM = 0.72;      /* grains are trimmed in the dark scheme: pale ink on dark paper blooms */
  var POPULATION_CAP = 520;  /* hard ceiling on live grains at REFERENCE, whatever a gust asks for */
  var EDGE_BIAS = 0.25;      /* how much less the upwind end of a piece sheds than its downwind end */
  var SPRAY = 1.3;           /* cells of vertical scatter a grain leaves its piece with, so the
                                sand leaves as a few rows of cells and not as one solid rule */
  var RESPONSE = 14;         /* how fast a grain takes up the speed of the air around it, per second */
  var HOVER_GAIN = 1.1;      /* extra wind and emission while the mark is hovered or focused */
  var HOVER_RESPONSE = 2.6;  /* how fast that swell rises and falls, per second */
  var ALPHA_STEPS = 4;       /* opacity steps a grain's ink is quantised to, which is part of the look */
  var PAD_UPWIND = 16;       /* canvas overscan on the windward side of the mark, CSS px */
  var PAD_DOWNWIND = 132;    /* canvas overscan on the leeward side, CSS px: how far the sand carries */
  var PAD_Y = 22;            /* canvas overscan above and below, CSS px */
  var EDGE_FADE = 26;        /* CSS px over which a grain leaving the canvas or the page dissolves */
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
  var floorX = 0, ceilX = 0; /* canvas x where the page begins and ends, so grains leave rather than clip */
  var ink = "#1a1a1a";
  var raf = 0, prev = 0, clock = 0, emitAcc = 0;
  var hover = 0, hovered = false, onScreen = true, watchAcc = 0;
  var gustAt = 1.6;          /* clock time the next gust starts, s */

  /* the steady flow, one sample per CSS px of canvas, in CSS px/s */
  var fw = 0, fh = 0, flowX = null, flowY = null;
  /* where grains are born: cell indices into the same grid, with a cumulative weight */
  var seedAt = null, seedCdf = null, seedTotal = 0;

  /* live grains, as parallel arrays so a frame allocates nothing */
  var px, py, vx, vy, age, life, amp, tag, live = 0;
  /* the trail: a ring of TRAIL_POINTS - 1 past positions per grain, sampled on a clock so
     it is the same length in seconds whatever the refresh rate is */
  var hx, hy, tail = 0, head = 0, sampleAcc = 0, sampleEvery = 0;
  /* one list of grid cells per opacity step, filled and filled out once a frame */
  var bucket = [];

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
  }

  /* --- which parts of the mark shed ---------------------------------------- */
  /* Not the whole wordmark: two loose pieces of it. Both are found from the mask rather
     than written down, so they survive the mark being re-cut or re-sized.

     Every ink cell is flood filled into a component, which for this wordmark gives nine:
     s, h, the o ring, its macron, the i stem and its dot, the j body and its dot, and n.

     The macron is the one component that is much wider than it is tall and sits in the
     upper half. Nothing else in the mark is a bar.

     The hook is the tail of the j, and the j is the only glyph with a descender, so the
     component that reaches deepest is the j and the baseline is where every other
     component stops. The hook is what that component has below that line. */
  function pieces(cover) {
    var n = fw * fh, label = new Int32Array(n), stack = new Int32Array(n), boxes = [];
    var i, x, y, c = 0;
    for (i = 0; i < n; i++) label[i] = cover[i] >= 0.5 ? -1 : -2;
    for (y = 0; y < fh; y++) {
      for (x = 0; x < fw; x++) {
        if (label[y * fw + x] !== -1) continue;
        var top = 0, box = { x0: x, x1: x, y0: y, y1: y, cells: 0 };
        stack[top++] = y * fw + x;
        label[y * fw + x] = c;
        while (top > 0) {
          var p = stack[--top], pxx = p % fw, pyy = (p / fw) | 0;
          box.cells++;
          if (pxx < box.x0) box.x0 = pxx;
          if (pxx > box.x1) box.x1 = pxx;
          if (pyy < box.y0) box.y0 = pyy;
          if (pyy > box.y1) box.y1 = pyy;
          for (var dy = -1; dy <= 1; dy++) {          /* eight ways, so a diagonal of
                                                         antialiased ink stays one piece */
            for (var dx = -1; dx <= 1; dx++) {
              var qx = pxx + dx, qy = pyy + dy;
              if (qx < 0 || qy < 0 || qx >= fw || qy >= fh) continue;
              var q = qy * fw + qx;
              if (label[q] !== -1) continue;
              label[q] = c;
              stack[top++] = q;
            }
          }
        }
        boxes.push(box);
        c++;
      }
    }
    return { label: label, boxes: boxes };
  }

  function shedders(cover) {
    var found = pieces(cover), boxes = found.boxes, label = found.label;
    var out = [], i, b;
    if (!boxes.length) return out;

    var mid = 0, bar = -1, best = 0;
    for (i = 0; i < boxes.length; i++) mid += (boxes[i].y0 + boxes[i].y1) / 2;
    mid /= boxes.length;
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      var wide = (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1);
      if ((b.y0 + b.y1) / 2 < mid && wide > best && wide >= 2) { best = wide; bar = i; }
    }
    if (bar >= 0) out.push({ piece: bar, y0: boxes[bar].y0, box: boxes[bar] });

    var deep = 0;
    for (i = 1; i < boxes.length; i++) if (boxes[i].y1 > boxes[deep].y1) deep = i;
    var baseline = 0;
    for (i = 0; i < boxes.length; i++) if (i !== deep && boxes[i].y1 > baseline) baseline = boxes[i].y1;
    if (boxes[deep].y1 > baseline + 1) {
      out.push({ piece: deep, y0: baseline, box: boxes[deep] });
    }
    return out.length ? { list: out, label: label } : null;
  }

  /* Seeds are the cells of those two pieces, every column of them, so the sand leaves as
     a curtain the full width of the piece rather than a thread off one corner, weighted
     toward the downwind end of each. Seeding inside the ink means a grain is hidden by
     the piece it came off until the air has carried it clear. */
  function buildSeeds(cover) {
    var shed = shedders(cover);
    var at = [], cdf = [], total = 0, x, y, i;
    if (shed) {
      for (var s = 0; s < shed.list.length; s++) {
        var part = shed.list[s], box = part.box;
        var span = Math.max(1, box.x1 - box.x0);
        for (y = Math.max(0, part.y0); y <= box.y1; y++) {
          for (x = box.x0; x <= box.x1; x++) {
            i = y * fw + x;
            if (shed.label[i] !== part.piece) continue;
            var t = DOWNWIND < 0 ? (x - box.x0) / span : (box.x1 - x) / span;
            total += cover[i] * (1 - EDGE_BIAS * t);
            at.push(i);
            cdf.push(total);
          }
        }
      }
    }
    if (!at.length) {                       /* an unfamiliar mark sheds from all of itself */
      for (i = 0; i < fw * fh; i++) {
        if (cover[i] < 0.5) continue;
        total += cover[i];
        at.push(i);
        cdf.push(total);
      }
    }
    seedAt = new Int32Array(at);
    seedCdf = new Float32Array(cdf);
    seedTotal = total;
  }

  /* --- grains --------------------------------------------------------------- */
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
    tag = new Int32Array(cap);
    live = 0;
    bucket = [];
    for (var b = 0; b < ALPHA_STEPS; b++) bucket.push([]);
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
    py[i] = Math.floor(cell / fw) + Math.random() +
            (Math.random() - 0.5) * SPRAY * GRAIN * k;
    for (var t = 0; t < tail; t++) {      /* a new grain has no trail yet, only a position */
      hx[i * tail + t] = px[i];
      hy[i * tail + t] = py[i];
    }
    vx[i] = 0;
    vy[i] = 0;
    age[i] = 0;
    life[i] = LIFETIME * (1 + (Math.random() - 0.5) * 2 * LIFE_SPREAD);
    amp[i] = 0.55 + 0.45 * Math.random();
    tag[i] = (Math.random() * 2147483647) | 0;    /* its own name, so its glitches are its own */
  }

  function kill(i) {
    var last = --live;
    if (i === last) return;
    px[i] = px[last]; py[i] = py[last];
    vx[i] = vx[last]; vy[i] = vy[last];
    age[i] = age[last]; life[i] = life[last]; amp[i] = amp[last]; tag[i] = tag[last];
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
    /* a frame that ran long is owed its own grains and no more, so a stall cannot cash
       itself out as a cloud of sand the moment the tab comes back */
    if (emitAcc > born + 8) emitAcc = born + 8;
    while (emitAcc >= 1) { emitAcc -= 1; birth(); }
  }

  /* Every grain's recent path, on a clock rather than per frame, so a trail is TRAIL_FADE
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

  /* Fleur de sel: a flake is one to four cells stuck together, and mostly it is one. A
     grain draws the same one all its life, by the low bits of its own name, so the sand
     is irregular crystal rather than uniform shot. Sixteen of them, weighted to singles. */
  var FLAKE = [
    [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
    [0, 0, 1, 0], [0, 0, -1, 0], [0, 0, 0, 1], [0, 0, 0, -1],
    [0, 0, 1, 1], [0, 0, -1, 1],
    [0, 0, 1, 0, 0, 1], [0, 0, -1, 0, 0, -1], [0, 0, 1, 0, 1, -1],
    [0, 0, 1, 0, 0, 1, 1, 1]
  ];

  /* The 4 x 4 ordered dither, the one every 8 bit machine used, as thresholds in [0,1). */
  var BAYER = [
    0 / 16, 8 / 16, 2 / 16, 10 / 16,
    12 / 16, 4 / 16, 14 / 16, 6 / 16,
    3 / 16, 11 / 16, 1 / 16, 9 / 16,
    15 / 16, 7 / 16, 13 / 16, 5 / 16
  ];

  /* One cell, thresholded against the dither at the cell it lands in. Everything drawn
     goes through here, so nothing anywhere is antialiased or off the grid. */
  function plot(cx, cy, w, cell) {
    var step = (w * ALPHA_STEPS + BAYER[(cx & 3) | ((cy & 3) << 2)]) | 0;
    if (step <= 0) return;                      /* on the empty side of the dither */
    if (step > ALPHA_STEPS) step = ALPHA_STEPS;
    bucket[step - 1].push(Math.round(cx * cell * dpr), Math.round(cy * cell * dpr));
  }

  /* --- drawing -------------------------------------------------------------- */
  /* Grains are not drawn where they are. They are drawn in the cell they are in, on a
     GRAIN px grid. Nothing is antialiased and nothing moves by less than a whole cell, so
     a grain crossing the page reads as a run of lit cells rather than as a line: the sand
     is made of pixels, not of ink. A grain's trail is the cells it stood in a few sample
     times ago.

     Nothing fades smoothly either. A grain's ink is thresholded against the 4 x 4 ordered
     dither at the cell it is in, so as the sand runs out downwind it does not go evenly
     grey, it breaks into fewer and fewer lit cells in a regular pattern and then stops.
     That dither is the fade: dropping to four opacity steps and letting the pattern carry
     the rest is what makes it read as pixels dissolving rather than ink thinning.

     On top of that it glitches. Every grain draws a fresh hand GLITCH_RATE times a second
     from a hash of its own name and the clock, so a glitch holds for a few frames instead
     of buzzing: some tear downwind of where they are, some smear into a horizontal run of
     cells, some drop out entirely for an instant.

     The canvas is cleared outright every frame. The obvious alternative, a persistent
     buffer faded a little each frame, cannot actually reach zero: the fade is a multiply
     on eight bit alpha, so anything at or under 0.5 / fade rounds back to itself and a
     permanent haze in the shape of the plume settles over the page. */
  function draw() {
    var b, i, t, r;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (b = 0; b < ALPHA_STEPS; b++) bucket[b].length = 0;
    var fade = EDGE_FADE * k;
    var cell = GRAIN * k;
    var size = Math.max(1, Math.round(cell * dpr));
    var hand = (clock * GLITCH_RATE) | 0;
    var tear = Math.round(GLITCH_TEAR * k / cell);

    for (i = 0; i < live; i++) {
      var u = age[i] / life[i];
      /* linear in age, and age is very nearly distance downwind, so this is the fade to
         the left; the dither below turns it into cells going out rather than going pale */
      var a = amp[i] * Math.min(1, u * 9) * (1 - u);
      if (px[i] < floorX + fade) a *= Math.max(0, (px[i] - floorX) / fade);
      else if (px[i] > ceilX - fade) a *= Math.max(0, (ceilX - px[i]) / fade);
      if (a <= 0) continue;

      var luck = hash(tag[i], hand);            /* this grain's hand, held for 1 / GLITCH_RATE s */
      if (luck < GLITCH_DROP * 2 - 1) continue; /* dropped: gone for an instant */
      var torn = 0, smear = 1;
      if (luck > 1 - GLITCH_CHANCE * 2) {
        var how = hash(tag[i] ^ 0x5bf03635, hand);
        torn = Math.round(DOWNWIND * (0.4 + 0.6 * Math.abs(how)) * tear);
        if (how > 0) smear = 1 + ((Math.abs(how) * GLITCH_SMEAR) | 0);
      }

      var base = i * tail, shape = FLAKE[tag[i] & 15];
      for (t = 0; t <= tail; t++) {
        var w = a * (1 - t / TRAIL_POINTS);
        if (w <= 0) break;
        var gx, gy;
        if (t === 0) { gx = px[i]; gy = py[i]; }
        else {
          var s = (head - t + 1 + tail * 2) % tail;
          gx = hx[base + s];
          gy = hy[base + s];
        }
        var col = Math.round(gx / cell) + torn;
        var row = Math.round(gy / cell);
        if (t === 0) {
          /* the flake itself, and then whatever the glitch is dragging out behind it */
          for (r = 0; r < shape.length; r += 2) plot(col + shape[r], row + shape[r + 1], w, cell);
          for (r = 1; r < smear; r++) plot(col + DOWNWIND * r, row, w, cell);
        } else {
          plot(col, row, w, cell);              /* what the flake shed on the way here */
        }
      }
    }

    var peak = PARTICLE_ALPHA * (dark.matches ? DARK_TRIM : 1);
    ctx.fillStyle = ink;
    for (b = 0; b < ALPHA_STEPS; b++) {
      var cells = bucket[b];
      if (!cells.length) continue;
      ctx.globalAlpha = peak * (b + 1) / ALPHA_STEPS;
      for (i = 0; i < cells.length; i += 2) ctx.fillRect(cells[i], cells[i + 1], size, size);
    }
    ctx.globalAlpha = 1;
  }

  /* The change event on a MediaQueryList is not something to bet the colours on: a list
     made early in a script can go on reporting the right answer in `matches` and never
     fire at all, which leaves grains drawn in the old scheme's ink on the new scheme's
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

  /* The canvas overhangs its anchor, mostly downwind, so the sand has somewhere to go.
     floorX and ceilX are where the viewport cuts across it: a grain blown off the page
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
    buildFlow(cover);
    buildSeeds(cover);
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
