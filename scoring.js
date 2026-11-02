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

  function evaluate(sheet, mode) {
    const rows = sheet.rows;
    const res = rows.map(() => ({ sub: null, cum: null, role: 'unused' }));
    const usedIdx = rows.map((r, i) => used(r) ? i : -1).filter(i => i >= 0);
    const perRow = mode === 3 || usedIdx.some(i => rows[i].arrows.length > 3);
    const groups = [];
    if (perRow) usedIdx.forEach(i => groups.push([i]));
    else for (let k = 0; k < usedIdx.length; k += 2) groups.push(usedIdx.slice(k, k + 2));

    let cum = 0, hits = 0, tens = 0, xs = 0, arrows = 0, unreadable = false;
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
        cum += exp;
        res[b].role = 'end';
        res[b].sub = compare(rows[b].sub, exp);
        res[b].cum = compare(rows[b].cum, cum);
      } else {
        const i = g[0];
        cum += exp;
        res[i].role = perRow ? 'end' : 'half';
        res[i].sub = compare(rows[i].sub, exp);
        res[i].cum = compare(rows[i].cum, cum);
      }
    }
    const last = usedIdx.length ? usedIdx[usedIdx.length - 1] : -1;
    rows.forEach((r, i) => {
      if (res[i].role !== 'unused') return;
      if (i > last && last >= 0 && numVal(r.cum) !== null) { res[i].role = 'carry'; res[i].cum = compare(r.cum, cum); }
      if (numVal(r.sub) !== null) res[i].sub = { st: 'warn', exp: NaN, w: numVal(r.sub) };
    });
    const total = last >= 0 && sheet.total ? compare(sheet.total.value, cum) : null;
    return { res, cum, total, hits, tens, xs, arrows, unreadable, ends: groups.length };
  }

  root.Scoring = { evaluate, arrowVal, numVal };
})(typeof self !== 'undefined' ? self : globalThis);
