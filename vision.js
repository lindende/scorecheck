/* ScoreVision: finds archery score grids in a camera frame and reads the handwritten cells.
 * Works in a browser worker and in Node. Needs an initialised OpenCV.js object (cv) and the
 * model weights (weights.json, produced by train/gen_and_train.py).
 *
 * Coordinates: "frame" = pixels of the RGBA frame passed in. Each sheet carries T (3x3, row major):
 * canonical = T * frame, and Tinv for the way back. In canonical space a score row is ROWH px tall,
 * the grid starts at (P, P) and is W x H px.
 */
(function (root) {
  'use strict';

  // Column lines as fractions of the grid width: Plaats | 3 arrows | serie | totaal | Hits | 10 | x
  const TPL = [0, 0.095, 0.192, 0.289, 0.385, 0.545, 0.708, 0.818, 0.909, 1.0];
  /* Score sheet layouts. cols = vertical lines as fractions of the grid width; spans index into cols.
     18m3: Plaats | 3 arrows | serie | totaal | Hits | 10 | x   (rows 3, 6, 9 ...)
     25m1p: Pr. | 5 arrows | serie                              (rows 5, 10, 15 ...; total = sum of series) */
  const LAYOUTS = {
    '18m3': { id: '18m3', cols: TPL, arrows: [[1, 2], [2, 3], [3, 4]], sub: [4, 5], cum: [5, 6], total: [5, 6], spillRight: 6, step: 3, subDigits: 2 },
    '25m1p': { id: '25m1p', cols: [0, 0.119, 0.269, 0.416, 0.565, 0.714, 0.862, 1.0], arrows: [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], sub: [6, 7], cum: null, total: [5, 7], spillRight: 7, step: 5, subDigits: 2 }
  };
  const ROWH = 40;
  const PAD = 20;
  const CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'M', 'X', '10'];

  /* ------------------------------------------------------------------ CNN */
  function makeModel(w) {
    const f32 = k => Float32Array.from(w[k]);
    const P = { c1w: f32('c1w'), c1b: f32('c1b'), c2w: f32('c2w'), c2b: f32('c2b'), d1w: f32('d1w'), d1b: f32('d1b'), d2w: f32('d2w'), d2b: f32('d2b') };
    const a1 = new Float32Array(26 * 26 * 8), p1 = new Float32Array(13 * 13 * 8);
    const a2 = new Float32Array(11 * 11 * 16), p2 = new Float32Array(5 * 5 * 16);
    const h = new Float32Array(64), o = new Float32Array(13);
    function conv(inp, H, W, C, Wt, b, F, out) {
      const Ho = H - 2, Wo = W - 2;
      for (let y = 0; y < Ho; y++) for (let x = 0; x < Wo; x++) {
        const ob = (y * Wo + x) * F;
        for (let f = 0; f < F; f++) out[ob + f] = b[f];
        for (let c = 0; c < C; c++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          const v = inp[((y + i) * W + (x + j)) * C + c];
          if (v === 0) continue;
          const wb = (c * 9 + i * 3 + j) * F;
          for (let f = 0; f < F; f++) out[ob + f] += v * Wt[wb + f];
        }
        for (let f = 0; f < F; f++) if (out[ob + f] < 0) out[ob + f] = 0;
      }
    }
    function pool(inp, H, W, C, out) {
      const H2 = H >> 1, W2 = W >> 1;
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) for (let c = 0; c < C; c++) {
        const a = inp[((2 * y) * W + 2 * x) * C + c], b = inp[((2 * y) * W + 2 * x + 1) * C + c];
        const d = inp[((2 * y + 1) * W + 2 * x) * C + c], e = inp[((2 * y + 1) * W + 2 * x + 1) * C + c];
        out[(y * W2 + x) * C + c] = Math.max(a, b, d, e);
      }
    }
    return function predict(img28) {
      conv(img28, 28, 28, 1, P.c1w, P.c1b, 8, a1); pool(a1, 26, 26, 8, p1);
      conv(p1, 13, 13, 8, P.c2w, P.c2b, 16, a2); pool(a2, 11, 11, 16, p2);
      for (let k = 0; k < 64; k++) { let s = P.d1b[k]; for (let i = 0; i < 400; i++) s += p2[i] * P.d1w[i * 64 + k]; h[k] = s > 0 ? s : 0; }
      let mx = -1e9;
      for (let k = 0; k < 13; k++) { let s = P.d2b[k]; for (let i = 0; i < 64; i++) s += h[i] * P.d2w[i * 13 + k]; o[k] = s; if (s > mx) mx = s; }
      let sum = 0; const pr = new Float32Array(13);
      for (let k = 0; k < 13; k++) { pr[k] = Math.exp(o[k] - mx); sum += pr[k]; }
      for (let k = 0; k < 13; k++) pr[k] /= sum;
      return pr;
    };
  }

  // Exact area-average resampling, identical to area_resize() in the training script.
  function areaWeights(nOut, nIn) {
    const s = nIn / nOut, W = [];
    for (let o = 0; o < nOut; o++) {
      const a = o * s, b = (o + 1) * s, row = []; let tot = 0;
      for (let i = Math.floor(a); i < Math.min(Math.ceil(b), nIn); i++) {
        const ov = Math.min(b, i + 1) - Math.max(a, i);
        if (ov > 0) { row.push([i, ov]); tot += ov; }
      }
      W.push(row.map(([i, v]) => [i, v / (tot || 1)]));
    }
    return W;
  }
  /** mask: Uint8Array (0/1) of size w*h, already cropped to its bbox. Returns Float32Array(784). */
  function norm28(mask, w, h) {
    const s = 20 / Math.max(w, h);
    const nh = Math.max(1, Math.round(h * s)), nw = Math.max(1, Math.round(w * s));
    const Wy = areaWeights(nh, h), Wx = areaWeights(nw, w);
    const tmp = new Float32Array(nh * w);
    for (let o = 0; o < nh; o++) for (const [i, v] of Wy[o]) for (let x = 0; x < w; x++) tmp[o * w + x] += v * mask[i * w + x];
    const out = new Float32Array(784), oy = (28 - nh) >> 1, ox = (28 - nw) >> 1;
    for (let y = 0; y < nh; y++) for (let o = 0; o < nw; o++) {
      let acc = 0; for (const [i, v] of Wx[o]) acc += v * tmp[y * w + i];
      out[(oy + y) * 28 + ox + o] = acc;
    }
    return out;
  }

  /* ------------------------------------------------------------- geometry */
  const odd = n => { n = Math.round(n); return n % 2 ? n : n + 1; };

  function peaks(arr, thr, mind) {
    const out = []; let i = 0; const n = arr.length;
    while (i < n) {
      if (arr[i] > thr) {
        let j = i; let sw = 0, s = 0, mx = 0;
        while (j < n && arr[j] > thr) { sw += j * arr[j]; s += arr[j]; if (arr[j] > mx) mx = arr[j]; j++; }
        const c = sw / s;
        if (out.length && c - out[out.length - 1][0] < mind) { if (mx > out[out.length - 1][1]) out[out.length - 1] = [c, mx]; }
        else out.push([c, mx]);
        i = j;
      } else i++;
    }
    return out.map(p => p[0]);
  }

  function colSums(mat, x0 = 0, x1 = mat.cols, y0 = 0, y1 = mat.rows) {
    const out = new Float32Array(mat.cols), d = mat.data, W = mat.cols;
    for (let y = y0; y < y1; y++) { const r = y * W; for (let x = x0; x < x1; x++) if (d[r + x]) out[x]++; }
    return out;
  }
  function rowSums(mat, x0, x1) {
    const out = new Float32Array(mat.rows), d = mat.data, W = mat.cols;
    for (let y = 0; y < mat.rows; y++) { const r = y * W; let s = 0; for (let x = x0; x < x1; x++) if (d[r + x]) s++; out[y] = s; }
    return out;
  }

  function orderQuad(pts) {
    const s = pts.map(p => p.x + p.y), d = pts.map(p => p.x - p.y);
    const idx = f => pts[f];
    const iMin = a => a.indexOf(Math.min(...a)), iMax = a => a.indexOf(Math.max(...a));
    return [idx(iMin(s)), idx(iMax(d)), idx(iMax(s)), idx(iMin(d))];
  }

  function lineMasks(cv, gray) {
    const w = gray.cols, h = gray.rows;
    const bw = new cv.Mat(), hl = new cv.Mat(), vl = new cv.Mat();
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, odd(Math.max(15, Math.min(w, h) / 25)), 12);
    let k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(10, Math.floor(w / 35)), 1));
    cv.morphologyEx(bw, hl, cv.MORPH_OPEN, k); k.delete();
    k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(10, Math.floor(h / 50))));
    cv.morphologyEx(bw, vl, cv.MORPH_OPEN, k); k.delete();
    return { bw, hl, vl };
  }

  function analyseWarp(hl, vl, layoutIds) {
    const H = vl.rows, W = vl.cols;
    const xs = peaks(colSums(vl), H * 0.3, W * 0.012);
    if (xs.length < 6) return null;
    let best = null;
    for (const id of layoutIds) {
      const lay = LAYOUTS[id];
      for (let i = 0; i < xs.length; i++) for (let j = xs.length - 1; j > i; j--) {
        const L = xs[i], R = xs[j], gw = R - L;
        if (gw < W * 0.35) break;
        let hits = 0; const fit = [];
        for (const t of lay.cols) {
          const x = L + t * gw; let bp = x, bd = 1e9;
          for (const p of xs) { const d = Math.abs(p - x); if (d < bd) { bd = d; bp = p; } }
          if (bd < gw * 0.025) { hits++; fit.push(bp); } else fit.push(x);
        }
        // every line of the template should be there; a missing line costs more than an extra one
        const score = hits / lay.cols.length;
        if (hits >= lay.cols.length - 2 && (!best || score > best.score + 1e-6)) best = { score, hits, L, R, fit, lay };
      }
    }
    if (!best) return null;
    const { L, R, fit, lay } = best, gw = R - L;
    const x0 = Math.round(L + 0.1 * gw), x1 = Math.round(L + 0.7 * gw);
    const ys = peaks(rowSums(hl, x0, x1), (x1 - x0) * 0.5, H * 0.008);
    if (ys.length < 4) return null;
    const dx = [Math.round(fit[2]), Math.round(fit[3])], vd = vl.data;
    const colCover = (x, a, b) => {
      const ya = Math.round(a + (b - a) * 0.2), yb = Math.round(b - (b - a) * 0.2);
      if (yb <= ya) return 0;
      let c = 0;
      for (let y = ya; y < yb; y++) {
        let any = 0; for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) if (vd[y * W + xx]) { any = 1; break; }
        c += any;
      }
      return c / (yb - ya);
    };
    const coverage = (a, b) => Math.min(...dx.map(x => colCover(x, a, b)));
    // all four lines around the arrow boxes; a header or Totaal row has none of them
    const allDx = [1, 2, 3, 4].map(i => Math.round(fit[i]));
    const partial = (a, b) => allDx.filter(x => colCover(x, a, b) > 0.5).length >= 2;
    const hasDividers = (a, b) => coverage(a, b) > 0.6;
    let run = null, bestRun = null;
    for (let k = 0; k < ys.length - 1; k++) {
      if (hasDividers(ys[k], ys[k + 1])) run = run ? [run[0], k] : [k, k]; else run = null;
      if (run && (!bestRun || run[1] - run[0] > bestRun[1] - bestRun[0])) bestRun = run;
    }
    if (!bestRun || bestRun[1] - bestRun[0] < 2) return null;
    {
      // handwriting over a divider can hide it; extend the run over rows of the same height with partial dividers
      const hs = []; for (let k = bestRun[0]; k <= bestRun[1]; k++) hs.push(ys[k + 1] - ys[k]); hs.sort((p, q) => p - q);
      const rh0 = hs[hs.length >> 1];
      const sameHeight = k => { const hgt = ys[k + 1] - ys[k]; return hgt > 0.8 * rh0 && hgt < 1.25 * rh0; };
      while (bestRun[0] > 0 && sameHeight(bestRun[0] - 1) && partial(ys[bestRun[0] - 1], ys[bestRun[0]])) bestRun[0]--;
      while (bestRun[1] + 1 < ys.length - 1 && sameHeight(bestRun[1] + 1) && partial(ys[bestRun[1] + 1], ys[bestRun[1] + 2])) bestRun[1]++;
    }
    const [a, b] = bestRun;
    let rows = ys.slice(a, b + 2);
    // the 25m1p header row ("Pr.") has the same boxes as a score row; a sheet has 5 ends
    if (lay.id === '25m1p' && rows.length - 1 > 5) rows = rows.slice(rows.length - 6);
    const gaps = rows.slice(1).map((y, i) => y - rows[i]).sort((p, q) => p - q);
    const rh = gaps[gaps.length >> 1];
    // a score grid is about 8-9 row heights wide; anything else (e.g. two cards seen as one) is rejected
    if ((R - L) / rh < 5 || (R - L) / rh > 14) return null;
    let total = null;
    if (b + 2 < ys.length) { const g = ys[b + 2] - ys[b + 1]; if (g > 0.6 * rh && g < 1.5 * rh) total = ys[b + 2]; }
    return { L, R, rows, total, rh, layout: lay.id };
  }

  function matFrom3x3(cv, a) { return cv.matFromArray(3, 3, cv.CV_64F, a); }
  function mul3(A, B) { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function apply3(m, x, y) { const w = m[6] * x + m[7] * y + m[8]; return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w }; }

  /** Find score grids. gray: full-res CV_8UC1. Returns [{quad:[tl,tr,br,bl], nrows, hasTotal}] sorted left to right. */
  function detect(cv, gray, layoutIds = Object.keys(LAYOUTS)) {
    // Small score sheets in a big photo need more pixels; try a fast size first, then a larger one.
    const maxSide = Math.max(gray.cols, gray.rows);
    let best = [], bestRows = -1;
    for (const target of [900, 1500]) {
      const scale = Math.min(1, target / maxSide);
      const found = detectAt(cv, gray, scale, layoutIds);
      const rows = found.reduce((t, f) => t + f.nrows, 0);
      if (rows > bestRows) { best = found; bestRows = rows; }
      if ((found.length && found.every(f => f.nrows >= 4)) || scale === 1) break;
    }
    return best;
  }

  function detectAt(cv, gray, scale, layoutIds) {
    const small = new cv.Mat();
    if (scale < 0.75) {
      // keep thin printed lines: darkest pixel wins before shrinking
      const k = Math.max(2, Math.round(1 / scale));
      const er = new cv.Mat(), kern = cv.Mat.ones(k, k, cv.CV_8U);
      cv.erode(gray, er, kern);
      cv.resize(er, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
      er.delete(); kern.delete();
    } else {
      cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
    }
    const { bw, hl, vl } = lineMasks(cv, small);
    const lines = new cv.Mat(); cv.bitwise_or(hl, vl, lines);
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(lines, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const A = small.rows * small.cols, cand = [];
    for (let i = 0; i < contours.size(); i++) { const c = contours.get(i); const a = cv.contourArea(c); if (a >= 0.012 * A) cand.push({ i, a }); c.delete(); }
    cand.sort((p, q) => q.a - p.a);
    const out = [];
    for (const { i } of cand.slice(0, 6)) {
      const c = contours.get(i);
      const rect = cv.minAreaRect(c); c.delete();
      const pts = orderQuad(cv.RotatedRect.points(rect));
      const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const w = Math.round(Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2])));
      const h = Math.round(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
      if (w < 40 || h < 40) continue;
      const src = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flatMap(p => [p.x, p.y]));
      const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
      const M = cv.getPerspectiveTransform(src, dst);
      const whl = new cv.Mat(), wvl = new cv.Mat();
      cv.warpPerspective(hl, whl, M, new cv.Size(w, h), cv.INTER_NEAREST);
      cv.warpPerspective(vl, wvl, M, new cv.Size(w, h), cv.INTER_NEAREST);
      // thicken a little, so slightly tilted thin lines still add up in the projections
      const t = Math.max(3, Math.round(Math.max(w, h) * 0.005)) | 1;
      let kk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, t)); cv.dilate(whl, whl, kk); kk.delete();
      kk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(t, 1)); cv.dilate(wvl, wvl, kk); kk.delete();
      const res = analyseWarp(whl, wvl, layoutIds);
      const m = Array.from(M.data64F);
      [src, dst, M, whl, wvl].forEach(x => x.delete());
      if (!res) continue;
      const bot = res.total || res.rows[res.rows.length - 1];
      const Minv = inv3(m);
      const quad = [[res.L, res.rows[0]], [res.R, res.rows[0]], [res.R, bot], [res.L, bot]]
        .map(([x, y]) => { const p = apply3(Minv, x, y); return { x: p.x / scale, y: p.y / scale }; });
      out.push({ quad, nrows: res.rows.length - 1, hasTotal: res.total !== null, layout: res.layout });
    }
    [small, bw, hl, vl, lines, hier].forEach(x => x.delete()); contours.delete();
    // the same grid can be found via two contours: keep the one with the most rows
    const cen = q => ({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2, w: Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) });
    out.sort((p, q) => q.nrows - p.nrows);
    const kept = [];
    for (const o of out) {
      const c = cen(o.quad);
      if (!kept.some(k => { const d = cen(k.quad); return Math.abs(c.x - d.x) < 0.5 * d.w; })) kept.push(o);
    }
    kept.sort((p, q) => (p.quad[0].x + p.quad[3].x) - (q.quad[0].x + q.quad[3].x));
    return kept;
  }

  /* ----------------------------------------------------------- reading */
  function canonical(cv, gray, sh) {
    const q = sh.quad, n = sh.nrows + (sh.hasTotal ? 1 : 0);
    const d = (p, r) => Math.hypot(p.x - r.x, p.y - r.y);
    const gw = (d(q[0], q[1]) + d(q[3], q[2])) / 2, gh = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
    const H = n * ROWH, W = Math.round(ROWH * gw / (gh / n));
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap(p => [p.x, p.y]));
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [PAD, PAD, PAD + W, PAD, PAD + W, PAD + H, PAD, PAD + H]);
    const M = cv.getPerspectiveTransform(src, dst);
    const can = new cv.Mat();
    // extra room right and below: the last column and the total are often written past the border
    cv.warpPerspective(gray, can, M, new cv.Size(W + 2 * PAD + ROWH, H + 2 * PAD + ROWH / 2), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
    const T = Array.from(M.data64F);
    [src, dst, M].forEach(x => x.delete());
    return { can, T, W, H, n };
  }

  // Line thickness = median run length across line pixels.
  function medianRun(lineData, W, H, horizontal) {
    const runs = [];
    if (horizontal) { // vertical runs of horizontal-line pixels
      for (let x = 0; x < W; x += 3) { let r = 0; for (let y = 0; y <= H; y++) { if (y < H && lineData[y * W + x]) r++; else { if (r) runs.push(r); r = 0; } } }
    } else {
      for (let y = 0; y < H; y += 3) { let r = 0; for (let x = 0; x <= W; x++) { if (x < W && lineData[y * W + x]) r++; else { if (r) runs.push(r); r = 0; } } }
    }
    if (!runs.length) return 3;
    runs.sort((a, b) => a - b); return runs[runs.length >> 1];
  }

  /* Ink = dark pixels minus printed grid lines. A line pixel is only removed where the dark run across
     the line is no wider than the line itself, so pen strokes that cross or touch a line stay intact. */
  function inkMasks(cv, can) {
    const bw = new cv.Mat(), hl = new cv.Mat(), vl = new cv.Mat();
    cv.adaptiveThreshold(can, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 14);
    let k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ROWH, 1)); cv.morphologyEx(bw, hl, cv.MORPH_OPEN, k); k.delete();
    k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, ROWH)); cv.morphologyEx(bw, vl, cv.MORPH_OPEN, k); k.delete();
    const W = bw.cols, H = bw.rows, b = bw.data, h = hl.data, v = vl.data;
    const tH = medianRun(h, W, H, true) + 2, tV = medianRun(v, W, H, false) + 2;
    const ink = new Uint8Array(W * H), grid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { ink[i] = b[i] ? 1 : 0; grid[i] = (h[i] || v[i]) ? 1 : 0; }
    // vertical lines: horizontal dark runs
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!b[y * W + x]) { x++; continue; }
        let e = x; let line = false;
        while (e < W && b[y * W + e]) { if (v[y * W + e]) line = true; e++; }
        if (line && e - x <= tV) for (let i = x; i < e; i++) ink[y * W + i] = 0;
        x = e;
      }
    }
    // horizontal lines: cut fully, so stacked rows separate; tails are re-attached in attachTails()
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (h[i] || (y > 0 && h[i - W]) || (y < H - 1 && h[i + W])) ink[i] = 0;
    }
    // a long line segment that survived (e.g. where two lines meet) is not ink
    const inkMat = cv.matFromArray(H, W, cv.CV_8UC1, ink);
    [bw, hl, vl].forEach(x => x.delete());
    return { ink: inkMat, gridData: grid, W, H };
  }

  function components(cv, ink) {
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(ink, labels, stats, cents, 8, cv.CV_32S);
    const comps = [];
    const S = stats.data32S, C = cents.data64F;
    for (let i = 1; i < n; i++) {
      const x = S[i * 5], y = S[i * 5 + 1], w = S[i * 5 + 2], h = S[i * 5 + 3], area = S[i * 5 + 4];
      if (area < 12 || (h < ROWH * 0.18 && w < ROWH * 0.18)) continue;
      if (area > 0.75 * w * h && w * h > 30) continue; // solid block: line remnant, not handwriting
      if (h > ROWH * 2.2 || w > ROWH * 3) continue; // card edge, table, signature
      comps.push({ id: i, x, y, w, h, area, cx: C[i * 2], cy: C[i * 2 + 1] });
    }
    // also keep small fragments; they may be tails cut off by a row line
    const small = [];
    for (let i = 1; i < n; i++) {
      const w = S[i * 5 + 2], h = S[i * 5 + 3], area = S[i * 5 + 4];
      if (area >= 4 && !(area >= 12 && !(h < ROWH * 0.18 && w < ROWH * 0.18))) small.push({ id: i, x: S[i * 5], y: S[i * 5 + 1], w, h, area });
    }
    const lab = Int32Array.from(labels.data32S), cols = labels.cols;
    [labels, stats, cents].forEach(m => m.delete());
    for (const c of comps) c.parts = [{ id: c.id }];
    traceTails(lab, cols, comps, n);
    attachTails(comps, small.filter(sm => hasLabel(lab, cols, sm)));
    return { comps, lab, cols };
  }

  function hasLabel(lab, cols, c) {
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (lab[y * cols + x] === c.id) return true;
    return false;
  }

  /* A long tail (a 9, a 7) runs over the row line into the cell below and often touches the digit
     written there. Follow the thin stroke downward from where it left the glyph above, hand those
     pixels to that glyph, and stop where the stroke meets something wider. */
  function traceTails(lab, cols, comps, firstFree) {
    const H = lab.length / cols, MAXW = 7;
    const areaOf = new Map(comps.map(c => [c.id, c.area]));
    let nextId = firstFree + 1;
    const dirty = new Set();
    for (const a of comps) {
      const bottom = a.y + a.h - 1;
      const k = Math.round((bottom + 1 - PAD) / ROWH), ly = PAD + k * ROWH;
      if (k < 1 || Math.abs(bottom + 1 - ly) > 5) continue;
      // where does the glyph leave through its bottom edge?
      const mark = [];
      for (let x = a.x; x < a.x + a.w; x++) if (lab[bottom * cols + x] === a.id || (bottom > 0 && lab[(bottom - 1) * cols + x] === a.id)) mark.push(x);
      const runs = [];
      for (const x of mark) { const r = runs[runs.length - 1]; if (r && x - r[1] <= 1) r[1] = x; else runs.push([x, x]); }
      for (const [x0, x1] of runs) {
        if (x1 - x0 > MAXW) continue;
        let cx0 = Math.max(0, x0 - 2), cx1 = Math.min(cols - 1, x1 + 2), y = bottom + 1, found = 0;
        for (; y <= bottom + 9 && y < H && !found; y++) for (let x = cx0; x <= cx1; x++) { const L = lab[y * cols + x]; if (L > 0 && L !== a.id) { found = L; break; } }
        if (!found) continue;
        y--;
        const tailId = nextId++, touched = [];
        let len = 0;
        for (; y < H && len < ROWH * 1.2; y++) {
          let s = -1;
          for (let x = Math.max(0, cx0 - 1); x <= Math.min(cols - 1, cx1 + 1); x++) if (lab[y * cols + x] === found) { s = x; break; }
          if (s < 0) break;
          let rs = s, re = s;
          while (rs > 0 && lab[y * cols + rs - 1] === found) rs--;
          while (re < cols - 1 && lab[y * cols + re + 1] === found) re++;
          if (re - rs + 1 > MAXW) break; // the tail meets the next digit
          for (let x = rs; x <= re; x++) { lab[y * cols + x] = tailId; touched.push(y * cols + x); }
          cx0 = rs - 2; cx1 = re + 2; len++;
        }
        // never swallow most of a real digit (a thin 7 below can look like a tail)
        const eatsDigit = areaOf.has(found) && touched.length > 0.45 * areaOf.get(found) && areaOf.get(found) > ROWH * 2.5;
        if (len >= 3 && !eatsDigit) { a.parts.push({ id: tailId }); a.h = Math.max(a.h, y - a.y); dirty.add(found); }
        else for (const i of touched) lab[i] = found;
      }
    }
    // the glyphs that lost pixels get new bounds
    for (let i = comps.length - 1; i >= 0; i--) {
      const c = comps[i];
      if (!dirty.has(c.id)) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0;
      for (let y = c.y; y < Math.min(H, c.y + c.h); y++) for (let x = c.x; x < c.x + c.w; x++) if (lab[y * cols + x] === c.id) {
        area++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (area < 12) { if (c.parts.length === 1) comps.splice(i, 1); else { c.parts = c.parts.filter(p => p.id !== c.id); } continue; }
      Object.assign(c, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area, cx: sx / area, cy: sy / area });
    }
  }

  /* A pen stroke that crosses a row line is cut in two. A fragment that starts right under the cut and
     is too small to be a digit of its own is glued back onto the fragment right above it. */
  function attachTails(comps, small) {
    const all = comps.concat(small.map(s => Object.assign(s, { tiny: true })));
    const nearLine = y => { const k = Math.round((y - PAD) / ROWH); return Math.abs(y - (PAD + k * ROWH)) <= 7; };
    for (const b of all) {
      // a cut-off tail is short, thin and starts right at a row line
      if (b.h >= ROWH * 0.55 || b.w > ROWH * 0.32 || !nearLine(b.y)) continue;
      let best = null, bd = 1e9;
      for (const a of comps) {
        if (a === b || a.dead) continue;
        const gap = b.y - (a.y + a.h);
        if (gap < -2 || gap > 9) continue;
        const ov = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (ov < -2) continue;
        if (gap < bd) { bd = gap; best = a; }
      }
      if (!best) continue;
      best.parts.push(...(b.parts || [{ id: b.id }]));
      const x2 = Math.max(best.x + best.w, b.x + b.w), y2 = Math.max(best.y + best.h, b.y + b.h);
      best.x = Math.min(best.x, b.x); best.y = Math.min(best.y, b.y); best.w = x2 - best.x; best.h = y2 - best.y;
      if (!b.tiny) b.dead = true;
    }
    for (let i = comps.length - 1; i >= 0; i--) if (comps[i].dead) comps.splice(i, 1);
  }

  // Merge fragments that sit above each other (a stroke cut by a removed grid line).
  function mergeStacked(list) {
    const g = list.map(c => ({ parts: c.parts.slice(), top: c.y, topH: c.h0 || c.h, x: c.x, y: c.y, x2: c.x + c.w, y2: c.y + c.h }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < g.length && !changed; i++) for (let j = i + 1; j < g.length && !changed; j++) {
        const a = g[i], b = g[j];
        const ov = Math.min(a.x2, b.x2) - Math.max(a.x, b.x);
        const minw = Math.min(a.x2 - a.x, b.x2 - b.x);
        const vgap = Math.max(a.y, b.y) - Math.min(a.y2, b.y2);
        if (ov > 0.4 * minw && vgap < ROWH * 0.25) {
          a.parts.push(...b.parts); a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y); a.x2 = Math.max(a.x2, b.x2); a.y2 = Math.max(a.y2, b.y2);
          g.splice(j, 1); changed = true;
        }
      }
    }
    return g;
  }

  function glyphMask(gl, lab, cols, gridData, restore) {
    const w = gl.x2 - gl.x, h = gl.y2 - gl.y, m = new Uint8Array(w * h);
    const ids = new Set(gl.parts.map(p => p.id));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ids.has(lab[(gl.y + y) * cols + gl.x + x])) m[y * w + x] = 1;
    if (restore && gl.parts.length > 1) {
      // bridge gaps left by a removed row line: only where ink sits right above and right below the gap
      let y = 0;
      while (y < h) {
        let rowHas = 0; for (let x = 0; x < w; x++) rowHas |= m[y * w + x];
        if (rowHas) { y++; continue; }
        let e = y; while (e < h) { let r = 0; for (let x = 0; x < w; x++) r |= m[e * w + x]; if (r) break; e++; }
        if (y > 0 && e < h && e - y <= 6) {
          for (let x = 0; x < w; x++) {
            let up = 0, dn = 0;
            for (let d = -1; d <= 1; d++) { const xx = x + d; if (xx < 0 || xx >= w) continue; up |= m[(y - 1) * w + xx]; dn |= m[e * w + xx]; }
            if (up && dn) for (let yy = y; yy < e; yy++) m[yy * w + x] = 1;
          }
        }
        y = e;
      }
    }
    return { m, w, h };
  }

  function cropMask(m, w, h, x0, x1) {
    let top = h, bot = -1;
    const nw = x1 - x0, out = new Uint8Array(nw * h);
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) if (m[y * w + x]) { out[y * nw + x - x0] = 1; if (y < top) top = y; if (y > bot) bot = y; }
    if (bot < 0) return null;
    return { m: out.subarray(top * nw, (bot + 1) * nw), w: nw, h: bot - top + 1 };
  }

  function classify(predict, gm) {
    // tighten bbox (restoration may have left empty columns)
    let x0 = gm.w, x1 = -1;
    for (let y = 0; y < gm.h; y++) for (let x = 0; x < gm.w; x++) if (gm.m[y * gm.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (x1 < 0) return null;
    const c = cropMask(gm.m, gm.w, gm.h, x0, x1 + 1);
    return predict(norm28(c.m, c.w, c.h));
  }

  const argmax = (p, allowed) => { let bi = -1, bv = -1; for (const k of allowed) if (p[k] > bv) { bv = p[k]; bi = k; } return [bi, bv]; };
  const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // in totals a wide blob is split instead of read as '10'

  function readArrow(predict, glyphs) {
    if (!glyphs.length) return { v: null, conf: 1 };
    const probs = glyphs.map(g => classify(predict, g.mask)).filter(Boolean);
    if (probs.length === 1) {
      const [k, p] = argmax(probs[0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0]);
      const v = k === 0 || k === 10 ? 'M' : k === 11 ? 'X' : k === 12 ? '10' : String(k);
      return { v, conf: p };
    }
    if (probs.length === 2) {
      const p = probs[0][1] * probs[1][0];
      return { v: '10', conf: Math.sqrt(p) };
    }
    return { v: '?', conf: 0 };
  }

  function splitGlyph(gm) {
    const { m, w, h } = gm, prof = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) prof[x] += m[y * w + x];
    let bx = -1, bv = 1e9;
    for (let x = Math.floor(w * 0.25); x <= Math.ceil(w * 0.75); x++) { const v = prof[x] + Math.abs(x - w / 2) / w; if (v < bv) { bv = v; bx = x; } }
    if (bx <= 0 || bx >= w - 1) return null;
    const a = cropMask(m, w, h, 0, bx), b = cropMask(m, w, h, bx, w);
    return a && b ? [a, b] : null;
  }

  function digitsOf(p) {
    let [k, pv] = argmax(p, DIGITS); let tot = 0; for (const d of DIGITS) tot += p[d];
    return { s: k === 12 ? '10' : String(k), conf: pv / tot, k };
  }

  /* Ways to read one blob: as 1 digit, or split at the thinnest column into 2 (or 3) digits.
     Each option carries a confidence that includes a width prior: wide blobs are probably several digits. */
  // top-k readings of one digit (only digits; '10' class excluded in totals)
  function digitAlts(p, k) {
    let tot = 0; for (const d of DIGITS) tot += p[d];
    return DIGITS.map(d => ({ s: String(d), conf: p[d] / tot })).sort((a, b) => b.conf - a.conf).slice(0, k);
  }

  function blobOptions(predict, gm) {
    const p = classify(predict, gm); if (!p) return [];
    // width relative to a normal digit height (tails and loops below the row make blobs taller, not wider)
    const ar = gm.w / Math.min(gm.h, ROWH * 0.75), pSplit = 1 / (1 + Math.exp(-(ar - 1.0) * 6));
    const opts = digitAlts(p, 3).map(d => ({ s: d.s, conf: d.conf * (1 - pSplit), n: 1 }));
    if (ar > 0.6) {
      const parts = splitGlyph(gm);
      if (parts) {
        const a = classify(predict, parts[0]), b = classify(predict, parts[1]);
        if (a && b) {
          const A = digitAlts(a, 2), B = digitAlts(b, 2);
          for (const x of A) for (const y of B) opts.push({ s: x.s + y.s, conf: x.conf * y.conf * pSplit, n: 2 });
          if (ar > 1.2) { // three touching digits: split the wider half once more
            const wi = parts[0].w >= parts[1].w ? 0 : 1, sub = splitGlyph(parts[wi]);
            if (sub) {
              const x = sub.map(q => classify(predict, q)), o = (wi ? A : B)[0];
              if (x[0] && x[1]) { const d0 = digitAlts(x[0], 1)[0], d1 = digitAlts(x[1], 1)[0];
                opts.push({ s: wi === 0 ? d0.s + d1.s + o.s : o.s + d0.s + d1.s, conf: d0.conf * d1.conf * o.conf * pSplit, n: 3 }); }
            }
          }
        }
      }
    }
    return opts;
  }

  /** Read a written number from its blobs, with at most maxDigits digits in total.
      Also returns cands: other plausible readings with their confidence relative to the best one,
      so the app can tell "probably misread" from "clearly a different number". */
  function readNumber(predict, glyphs, maxDigits = 3, minDigits = 1) {
    if (!glyphs.length) return { v: null, conf: 1 };
    const all = glyphs.map(g => blobOptions(predict, g.mask)).filter(o => o.length);
    if (!all.length) return { v: null, conf: 1 };
    if (all.length > maxDigits) return { v: '?', conf: 0 };
    const seen = new Map();
    const walk = (i, s, conf, n) => {
      if (n > maxDigits) return;
      if (i === all.length) { const c = conf * (n < minDigits ? 0.15 : 1); if (!seen.has(s) || seen.get(s) < c) seen.set(s, c); return; }
      for (const o of all[i]) walk(i + 1, s + o.s, conf * o.conf, n + o.n);
    };
    walk(0, '', 1, 0);
    if (!seen.size) return { v: '?', conf: 0 };
    const ranked = [...seen].sort((a, b) => b[1] - a[1]);
    const [bs, bc] = ranked[0];
    const cands = ranked.slice(0, 10).map(([str, c]) => [str, +(c / bc).toFixed(3)]);
    // report the confidence of the digits themselves, without the width prior
    return { v: bs, conf: Math.pow(bc, 0.7), cands };
  }

  /** Cut a canonical sheet image (CV_8UC1, grid at PAD, W wide, n rows of ROWH) into glyphs per cell.
      Returns glyphsOf(row, field) -> [{x, mask:{m,w,h}}] sorted left to right. */
  function cellGlyphs(cv, can, W, n, layoutId = '18m3', totalRow = true) {
    const lay = LAYOUTS[layoutId] || LAYOUTS['18m3'];
    const { ink, gridData } = inkMasks(cv, can);
    const { comps, lab, cols } = components(cv, ink);
    ink.delete();
    const cx = lay.cols.map(t => PAD + t * W);
    const last = lay.spillRight, colW = cx[1] - cx[0];
    const spans = lay.arrows.map((sp, k) => ['a' + k, sp]).concat([['sub', lay.sub]], lay.cum ? [['cum', lay.cum]] : []);
    const rightEdge = (lay.cum || lay.sub)[1];
    const field = c => {
      const x = c.cx;
      // handwriting may spill a bit past the last read column (into Hits, or past the border)
      const maxX = last < cx.length - 1 ? cx[last] + (cx[last + 1] - cx[last]) * 0.35 : cx[rightEdge] + colW * 0.8;
      if (x < cx[1] || x > maxX) return null;
      for (const [f, [a, b]] of spans) if (x < cx[b]) return f;
      return spans[spans.length - 1][0];
    };
    const totalField = c => {
      // the Totaal row also holds printed text: only take handwriting-sized marks right of the label
      if (c.h < ROWH * 0.45 || c.w > ROWH * 2.5) return null; // printed label, or a signature stroke
      return c.cx >= cx[lay.total[0]] && c.cx <= cx[lay.total[1]] + colW * 1.6 ? 'total' : null;
    };
    const bins = {};
    for (const c of comps) {
      // handwriting starts inside its row and tails may hang into the next one
      const r = Math.floor((c.y + 0.45 * Math.min(c.h, ROWH) - PAD) / ROWH);
      if (r < 0 || r >= n) continue;
      const f = r === n - 1 && totalRow ? totalField(c) : field(c); if (!f) continue;
      (bins[r + ':' + f] = bins[r + ':' + f] || []).push(c);
    }
    return (r, f) => mergeStacked(bins[r + ':' + f] || []).map(gl => ({ x: gl.x, mask: glyphMask(gl, lab, cols, gridData, true) })).sort((a, b) => a.x - b.x);
  }

  function readSheet(cv, gray, sh, predict, opts) {
    const { can, T, W, H, n } = canonical(cv, gray, sh);
    const lay = LAYOUTS[sh.layout] || LAYOUTS['18m3'];
    const glyphsOf = cellGlyphs(cv, can, W, n, lay.id, sh.hasTotal);
    const rows = [];
    for (let r = 0; r < sh.nrows; r++) {
      rows.push({
        arrows: lay.arrows.map((_, k) => readArrow(predict, glyphsOf(r, 'a' + k))),
        // a serie or running total below 10 is very unusual: prefer reading two digits
        sub: readNumber(predict, glyphsOf(r, 'sub'), lay.subDigits, 2),
        cum: lay.cum ? readNumber(predict, glyphsOf(r, 'cum'), 3, 2) : { v: null, conf: 1 }
      });
    }
    let total = null;
    if (sh.hasTotal) total = readNumber(predict, glyphsOf(sh.nrows, 'total'), 3, 3);
    const out = { rows, total, T, Tinv: inv3(T), W, H, cols: lay.cols, spans: { arrows: lay.arrows, sub: lay.sub, cum: lay.cum, total: lay.total, row: [0, (lay.cum || lay.sub)[1]] }, step: lay.step };
    if (opts && opts.canon) { out.canon = Uint8Array.from(can.data); out.cw = can.cols; out.ch = can.rows; }
    can.delete();
    return out;
  }

  /** Full pipeline on an RGBA ImageData-like {data,width,height}. */
  function processFrame(cv, imageData, predict, opts) {
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY); src.delete();
    const sheets = detect(cv, gray, (opts && opts.layouts) || Object.keys(LAYOUTS)).slice(0, 3).map(sh => Object.assign(sh, readSheet(cv, gray, sh, predict, opts)));
    gray.delete();
    return { sheets, width: imageData.width, height: imageData.height };
  }

  /** Canonical rectangle of a cell -> 4 frame points. field: 'a0'..'a2','sub','cum','row'; r = row index (nrows = total row). */
  function cellRect(W, field, r) {
    const cx = TPL.map(t => PAD + t * W);
    const span = { a0: [1, 2], a1: [2, 3], a2: [3, 4], sub: [4, 5], cum: [5, 6], row: [0, 6] }[field];
    return { x0: cx[span[0]], x1: cx[span[1]], y0: PAD + r * ROWH, y1: PAD + (r + 1) * ROWH };
  }

  function _debugInk(cv, gray, sh) {
    const { can, W, H } = canonical(cv, gray, sh); const r = inkMasks(cv, can);
    const out = { can: Uint8Array.from(can.data), ink: Uint8Array.from(r.ink.data), W: can.cols, H: can.rows };
    can.delete(); r.ink.delete(); return out;
  }

  root.ScoreVision = { LAYOUTS, _debugInk, cellGlyphs, readArrow, readNumber, makeModel, processFrame, detect, readSheet, cellRect, apply3, inv3, norm28, CLASSES, ROWH, PAD };
})(typeof self !== 'undefined' ? self : globalThis);
