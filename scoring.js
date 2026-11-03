/* Scoring rules for a Dutch archery score sheet.
 * sheet = { rows: [{label, arrows:[...], sub, cum}], total: {value} }
 * Arrow values: '1'..'10', 'M' (miss, 0), 'X' (inner ten, 10), '?' unreadable, null empty.
 * mode 3: every row is an end. mode 6: two consecutive used rows form one end (2 x 3 arrows);
 * the 6-arrow sum and running total are expected on the second row.
 * Cell status: ok | bad | miss (empty, show value) | warn (unreadable) | none.
 */
(function (root) {
  'use strict';
  function arrowVal(a) {
    if (a === null || a === undefined) return null;
    const s = String(a).trim().toUpperCase();
    if (s === '') return null;
    if (s === 'M' || s === '0') return 0;
    if (s === 'X') return 10;
    if (/^(10|[1-9])$/.test(s)) return +s;
    return NaN;
  }
  function numVal(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === '') return null;
    return /^\d{1,4}$/.test(s) ? +s : NaN;
  }
  function compare(written, expected) {
    const w = numVal(written);
    if (Number.isNaN(expected)) return { st: w === null ? 'none' : 'warn', exp: NaN, w };
    if (w === null) return { st: 'miss', exp: expected, w };
    if (Number.isNaN(w)) return { st: 'warn', exp: expected, w };
    return { st: w === expected ? 'ok' : 'bad', exp: expected, w };
  }
  const bad = arr => arr.some(a => Number.isNaN(arrowVal(a)));
  const sum = arr => arr.reduce((t, a) => { const v = arrowVal(a); return v === null || Number.isNaN(v) ? t : t + v; }, 0);
  const used = r => (r.arrows || []).some(a => arrowVal(a) !== null);
  // an unreadable arrow: continue the running total with the written serie, so one doubtful box
  // does not make every later total unknown
  const carry = (exp, written) => { const w = numVal(written); return Number.isNaN(exp) && w !== null && !Number.isNaN(w) ? w : exp; };

  function evaluate(sheet, mode, opts) {
    const rows = sheet.rows;
    const res = rows.map(() => ({ sub: null, cum: null, role: 'unused' }));
    const usedIdx = rows.map((r, i) => used(r) ? i : -1).filter(i => i >= 0);
    const perRow = mode === 3 || usedIdx.some(i => rows[i].arrows.length > 3);
    const groups = [];
    if (perRow) usedIdx.forEach(i => groups.push([i]));
    else for (let k = 0; k < usedIdx.length; k += 2) groups.push(usedIdx.slice(k, k + 2));

    let cum = 0, hits = 0, tens = 0, xs = 0, arrows = 0, unreadable = false, prevW = 0;
    // An unreadable arrow: continue the running total with what the sheet says this end is worth. The
    // written running totals (this one minus the previous one) are preferred over the written end, which
    // may itself be misread, as long as the value fits the arrows that were read. 'self' means it came
    // from the running total of this row, which then cannot be checked.
    const infer = (g, exp, end) => {
      if (!Number.isNaN(exp)) return { v: exp };
      let lo = 0, hi = 0;
      for (const i of g) for (const a of rows[i].arrows) { const v = arrowVal(a); if (v === null) continue; if (Number.isNaN(v)) hi += 10; else { lo += v; hi += v; } }
      const fits = x => x !== null && !Number.isNaN(x) && x >= lo && x <= hi;
      const wc = numVal(rows[end].cum), ws = numVal(rows[end].sub);
      const d = wc !== null && !Number.isNaN(wc) && prevW !== null ? wc - prevW : null;
      if (fits(d)) return { v: d, self: true };
      if (fits(ws)) return { v: ws };
      return { v: NaN };
    };
    const nextPrev = end => { const w = numVal(rows[end].cum); prevW = w === null || Number.isNaN(w) ? null : w; };
    for (const g of groups) {
      for (const i of g) for (const a of rows[i].arrows) {
        const v = arrowVal(a); if (v === null) continue;
        arrows++;
        if (Number.isNaN(v)) { unreadable = true; continue; }
        if (v > 0) hits++; if (v === 10) tens++;
        if (String(a).trim().toUpperCase() === 'X') xs++;
      }
      const exp = g.some(i => bad(rows[i].arrows)) ? NaN : g.reduce((t, i) => t + sum(rows[i].arrows), 0);
      if (g.length === 2) {
        const [a, b] = g;
        const aSum = bad(rows[a].arrows) ? NaN : sum(rows[a].arrows);
        res[a].role = 'pairStart';
        if (numVal(rows[a].sub) !== null) res[a].sub = compare(rows[a].sub, aSum);
        if (numVal(rows[a].cum) !== null) res[a].cum = compare(rows[a].cum, cum + aSum);
        const inf = infer(g, exp, b);
        cum += inf.v;
        res[b].role = 'end';
        res[b].sub = compare(rows[b].sub, exp);
        res[b].cum = compare(rows[b].cum, cum);
        if (inf.self && res[b].cum.st === 'ok') res[b].cum.st = 'warn';
        nextPrev(b);
      } else {
        const i = g[0];
        const inf = infer(g, exp, i);
        cum += inf.v;
        res[i].role = perRow ? 'end' : 'half';
        res[i].sub = compare(rows[i].sub, exp);
        res[i].cum = compare(rows[i].cum, cum);
        if (inf.self && res[i].cum.st === 'ok') res[i].cum.st = 'warn';
        nextPrev(i);
      }
    }
    const last = usedIdx.length ? usedIdx[usedIdx.length - 1] : -1;
    rows.forEach((r, i) => {
      if (res[i].role !== 'unused') return;
      if (i > last && last >= 0 && numVal(r.cum) !== null) { res[i].role = 'carry'; res[i].cum = compare(r.cum, cum); }
      if (numVal(r.sub) !== null) res[i].sub = { st: 'warn', exp: NaN, w: numVal(r.sub) };
    });
    if (opts && opts.noCum) res.forEach(r => { r.cum = null; }); // 25m1p: no running total column
    const total = last >= 0 && sheet.total ? compare(sheet.total.value, cum) : null;
    return { res, cum, total, hits, tens, xs, arrows, unreadable, ends: groups.length };
  }

  /* Ianseo outdoor card: two rows of 3 arrows form one end of 6.
     Every row: Sum (3 arrows), 10+X (number of tens incl. X), X (number of X).
     Second row of a pair: end total (6 arrows) and running total.
     Total row: total score, total 10+X and total X.
     A blank 10+X or X cell is fine when the count is 0. */
  function countCmp(written, n) {
    const w = numVal(written);
    if (Number.isNaN(n)) return w === null ? null : { st: 'warn', exp: NaN, w };
    if (w === null) return n === 0 ? null : { st: 'miss', exp: n, w };
    if (Number.isNaN(w)) return { st: 'warn', exp: n, w };
    return { st: w === n ? 'ok' : 'bad', exp: n, w };
  }
  function evaluateIanseo(sheet) {
    const rows = sheet.rows;
    // a row always has 3 arrows (a miss is written as M): an empty box next to filled ones was not read
    const gap = arr => arr.some(a => arrowVal(a) === null) && arr.some(a => arrowVal(a) !== null);
    const badI = arr => bad(arr) || gap(arr);
    // no arrows read but a sum written: the arrows were not read either
    const unread = r => badI(r.arrows) || (!used(r) && numVal(r.sub) !== null);
    const res = rows.map(() => ({ sub: null, end: null, cum: null, tx: null, xx: null, role: 'unused' }));
    let cum = 0, hits = 0, tens = 0, xs = 0, arrows = 0, unreadable = false, ends = 0, any = false;
    let tTen = 0, tX = 0;
    for (let p = 0; p < rows.length; p += 2) {
      const pair = [p, p + 1].filter(i => i < rows.length);
      if (!pair.some(i => used(rows[i]))) {
        // nothing shot here: only flag numbers that are written anyway
        pair.forEach(i => { for (const f of ['sub', 'end', 'cum', 'tx', 'xx']) { const w = numVal(rows[i][f]); if (w !== null && w !== 0) res[i][f] = { st: 'warn', exp: NaN, w }; } });
        continue;
      }
      any = true; ends++;
      for (const i of pair) {
        const r = rows[i];
        res[i].role = i === p ? 'pairStart' : 'end';
        let ten = 0, x = 0, broken = gap(r.arrows) || (!used(r) && numVal(r.sub) !== null);
        if (broken) unreadable = true;
        for (const a of r.arrows) {
          const v = arrowVal(a); if (v === null) continue;
          arrows++;
          if (Number.isNaN(v)) { unreadable = true; broken = true; continue; }
          if (v > 0) hits++;
          if (v === 10) { tens++; ten++; }
          if (String(a).trim().toUpperCase() === 'X') { xs++; x++; }
        }
        if (used(r) || numVal(r.sub) !== null) res[i].sub = compare(r.sub, unread(r) ? NaN : sum(r.arrows));
        if (used(r)) {
          res[i].tx = countCmp(r.tx, broken ? NaN : ten);
          res[i].xx = countCmp(r.xx, broken ? NaN : x);
        }
        // an unreadable arrow: continue with what is written (blank = 0), like the running total
        const w = v => { const n = numVal(v); return n === null ? 0 : n; };
        tTen += broken ? w(r.tx) : ten;
        tX += broken ? w(r.xx) : x;
      }
      const exp = pair.some(i => unread(rows[i])) ? NaN : pair.reduce((t, i) => t + sum(rows[i].arrows), 0);
      const second = pair[pair.length - 1];
      cum += carry(exp, rows[second].end);
      // the second half of the end not shot yet: nothing to check there
      const open = !used(rows[second]) && numVal(rows[second].sub) === null && numVal(rows[second].end) === null && numVal(rows[second].cum) === null;
      if (second !== p && !open) {
        res[second].end = compare(rows[second].end, exp);
        res[second].cum = compare(rows[second].cum, cum);
      }
    }
    const tot = sheet.totals || {};
    const total = any && sheet.total ? compare(sheet.total.value, cum) : null;
    const ttx = any && sheet.total ? countCmp(tot.ttx, tTen) : null;
    const txx = any && sheet.total ? countCmp(tot.txx, tX) : null;
    return { res, cum, total, ttx, txx, hits, tens, xs, arrows, unreadable, ends };
  }

  root.Scoring = { evaluate, evaluateIanseo, arrowVal, numVal };
})(typeof self !== 'undefined' ? self : globalThis);
