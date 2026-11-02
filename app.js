/* ScoreChecker Live — camera, voting over frames, scoring and overlay. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { evaluate } = self.Scoring;

  const ROWH = 40, PAD = 20;
  const MODES = { '3': '3 pijlen', '6': '6 pijlen', '25': '25M1P' };
  const VOTE_N = 7, VOTE_MIN = 3;
  const CONF = { arrow: 0.5, num: 0.4 };
  const MAX_SIDE = 1280;

  const S = {
    mode: 3, frozen: false, source: null, ready: false, busy: false,
    geo: [], frameW: 0, frameH: 0,
    hist: new Map(), vals: new Map(), over: new Map(), conf: new Map(), cands: new Map(),
    lastSeen: 0, lastResult: null, frameId: 0, pendingCanon: null
  };
  try { const m = localStorage.getItem('arrowsPerEnd'); if (m === '6') S.mode = 6; else if (m === '25') S.mode = 25; } catch (e) {}

  const video = $('video'), still = $('still'), overlay = $('overlay');
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });

  /* ---------------------------------------------------------------- worker */
  const worker = new Worker('worker.js');
  let fake = 0; const progTimer = setInterval(() => { fake = Math.min(92, fake + (100 - fake) * 0.06); $('prog').style.width = fake + '%'; }, 200);
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'ready') {
      S.ready = true; clearInterval(progTimer); $('prog').style.width = '100%';
      $('loadmsg').textContent = 'Klaar. De herkenning werkt op je telefoon zelf, er gaat niets naar internet.';
      $('go').disabled = false; $('gophoto').disabled = false;
    } else if (m.type === 'error') {
      $('loadmsg').innerHTML = '<span class="err">Herkenning kon niet laden: ' + esc(m.message) + '</span>';
    } else if (m.type === 'result') onResult(m);
  };

  /* ---------------------------------------------------------------- camera */
  let stream = null, track = null, wakeLock = null;
  async function startCamera() {
    if (!window.isSecureContext) { $('loadmsg').innerHTML = '<span class="err">De camera werkt alleen als de app via https geopend is.</span>'; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      $('loadmsg').innerHTML = '<span class="err">' + (e.name === 'NotAllowedError' ? 'Geen toegang tot de camera. Sta camera-toegang toe voor deze site in de browserinstellingen.' : 'De camera kon niet starten (' + esc(e.name || e) + ').') + '</span>';
      return;
    }
    track = stream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('torch').hidden = !caps.torch;
    video.srcObject = stream;
    await video.play().catch(() => {});
    S.source = 'camera'; S.frozen = false;
    $('start').hidden = true; still.hidden = true; video.hidden = false;
    lockScreen();
    resetAll();
    render();
    loop();
  }
  async function lockScreen() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.source === 'camera') lockScreen(); });

  $('torch').onclick = async () => {
    const on = $('torch').getAttribute('aria-pressed') !== 'true';
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); $('torch').setAttribute('aria-pressed', on); } catch (e) {}
  };

  function grab() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    proc.width = Math.round(vw * s); proc.height = Math.round(vh * s);
    pctx.drawImage(video, 0, 0, proc.width, proc.height);
    return pctx.getImageData(0, 0, proc.width, proc.height);
  }
  function send(img, canon) {
    S.busy = true; S.frameId++;
    const layouts = S.mode === 25 ? ['25m1p'] : ['18m3', '25m1p'];
    worker.postMessage({ type: 'frame', id: S.frameId, buffer: img.data.buffer, width: img.width, height: img.height, canon, layouts }, [img.data.buffer]);
  }
  function loop() {
    if (S.frozen || S.source !== 'camera') return;
    if (!S.busy) { const img = grab(); if (img) send(img, false); else requestAnimationFrame(loop); }
  }

  /* ---------------------------------------------------------------- voting */
  function resetAll() { S.hist.clear(); S.vals.clear(); S.over.clear(); S.conf.clear(); S.cands.clear(); S.geo = []; }
  // alternative readings of a number over the last frames: reading -> best relative confidence
  function keepCands(key, cands) {
    if (!cands) return;
    const m = S.cands.get(key) || new Map();
    for (const [str, rel] of cands) m.set(str, Math.max(m.get(str) || 0, rel));
    S.cands.set(key, m);
  }
  function vote(key, v, instant, conf) {
    if (conf !== undefined) S.conf.set(key, conf);
    if (instant) { S.hist.set(key, [v]); S.vals.set(key, v); return; }
    const h = S.hist.get(key) || []; h.push(v); if (h.length > VOTE_N) h.shift(); S.hist.set(key, h);
    const count = new Map(); for (const x of h) count.set(x, (count.get(x) || 0) + 1);
    let best, bc = 0; for (const [x, c] of count) if (c > bc) { bc = c; best = x; }
    if (bc >= VOTE_MIN && bc >= h.length / 2) S.vals.set(key, best);
  }
  const cellVal = (r, kind) => r.v === null ? null : (r.conf < CONF[kind] ? '?' : r.v);

  function center(q) { return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 }; }

  function onResult(m) {
    S.busy = false;
    const res = m.result;
    if (S.pendingCanon && m.id === S.pendingCanon.id) { const cb = S.pendingCanon.cb; S.pendingCanon = null; cb(res); return; }
    if (S.frozen && S.source === 'camera') return;
    const instant = S.source === 'photo';
    if (res.sheets.length) {
      S.lastSeen = performance.now();
      // a different card in view -> start over
      const moved = S.geo.length && (res.sheets.length !== S.geo.length || res.sheets.some((sh, i) => {
        const a = center(sh.quad), b = center(S.geo[i].quad);
        return Math.hypot(a.x - b.x, a.y - b.y) > 0.25 * res.width;
      }));
      const sameCard = S.geo.length && res.sheets.length === S.geo.length && res.sheets.every((sh, i) => sh.nrows === S.geo[i].nrows && sh.layout === S.geo[i].layout);
      if (instant || (moved && !sameCard)) resetAll();
      S.frameW = res.width; S.frameH = res.height;
      S.geo = res.sheets.map(sh => ({ quad: sh.quad, Tinv: sh.Tinv, W: sh.W, H: sh.H, nrows: sh.nrows, hasTotal: sh.hasTotal, layout: sh.layout, cols: sh.cols, spans: sh.spans, step: sh.step }));
      res.sheets.forEach((sh, si) => {
        sh.rows.forEach((r, ri) => {
          r.arrows.forEach((a, k) => vote(`${si}:${ri}:a${k}`, cellVal(a, 'arrow'), instant, a.conf));
          vote(`${si}:${ri}:sub`, cellVal(r.sub, 'num'), instant, r.sub.conf); keepCands(`${si}:${ri}:sub`, r.sub.cands);
          if (sh.spans.cum) { vote(`${si}:${ri}:cum`, cellVal(r.cum, 'num'), instant, r.cum.conf); keepCands(`${si}:${ri}:cum`, r.cum.cands); }
        });
        if (sh.hasTotal && sh.total) { vote(`${si}:t`, cellVal(sh.total, 'num'), instant); keepCands(`${si}:t`, sh.total.cands); }
      });
      S.lastResult = res;
    } else if (instant) {
      S.geo = []; S.frameW = res.width; S.frameH = res.height;
    }
    render();
    if (instant) { freezeView(true); if (!res.sheets.length) showHint('Geen scoretabel gevonden op deze foto. Fotografeer het briefje recht van boven, met de hele tabel in beeld.'); }
    else requestAnimationFrame(loop);
  }

  /* --------------------------------------------------------------- model */
  const get = key => S.over.has(key) ? S.over.get(key) : S.vals.get(key);
  function sheetModel(si) {
    const g = S.geo[si]; const rows = []; const stable = [];
    const na = g.spans.arrows.length, hasCum = !!g.spans.cum;
    const keys = g.spans.arrows.map((_, k) => 'a' + k).concat(['sub'], hasCum ? ['cum'] : []);
    for (let ri = 0; ri < g.nrows; ri++) {
      const f = keys.map(k => get(`${si}:${ri}:${k}`));
      stable.push(f.every(v => v !== undefined));
      rows.push({ label: String((ri + 1) * g.step), arrows: f.slice(0, na).map(v => v === undefined ? null : v), sub: f[na] ?? null, cum: hasCum ? (f[na + 1] ?? null) : null });
    }
    const tv = get(`${si}:t`);
    const sheet = { rows, total: g.hasTotal ? { value: tv ?? null } : null };
    const is25 = g.layout === '25m1p';
    const ev = evaluate(sheet, is25 ? 3 : S.mode, { noCum: !hasCum });
    if (!is25 && S.mode === 3) crossCheck(si, sheet, ev);
    verifyCells(si, ev);
    const allStable = stable.every(Boolean) && (!g.hasTotal || tv !== undefined);
    return { sheet, ev, stable, allStable, is25 };
  }

  /* A reading error and a scoring error look the same in one cell. The neighbouring cells tell them
     apart: if the running totals agree with the arrows, the serie cell was misread, not miswritten.
     Such cells become "controleer" (amber) instead of "fout" (red). Corrected cells are trusted. */
  function crossCheck(si, sheet, ev) {
    const num = v => (v !== null && /^\d+$/.test(v)) ? +v : null;
    const rows = sheet.rows;
    const ends = ev.res.map((r, i) => r.role === 'end' ? i : -1).filter(i => i >= 0);
    ends.forEach((i, k) => {
      const r = ev.res[i];
      const prev = k > 0 ? num(rows[ends[k - 1]].cum) : 0;
      const cum = num(rows[i].cum);
      const manual = key => S.over.has(`${si}:${i}:${key}`);
      if (r.sub && r.sub.st === 'bad' && !manual('sub')) {
        const d = prev !== null && cum !== null ? cum - prev : null;
        const arrowConf = Math.min(...[0, 1, 2].map(a => manual('a' + a) ? 1 : (S.conf.get(`${si}:${i}:a${a}`) ?? 1)));
        if (d === r.sub.exp || (d === r.sub.w && arrowConf < 0.85)) r.sub.st = 'warn';
      }
      if (r.cum && r.cum.st === 'bad' && !manual('cum') && k + 1 < ends.length) {
        const j = ends[k + 1], nc = num(rows[j].cum), ns = num(rows[j].sub);
        if (nc !== null && ns !== null && nc - ns === r.cum.exp) r.cum.st = 'warn';
      }
    });
  }

  /* The app checks rather than reads: if the correct value is also a plausible reading of the
     handwriting (at least 20% as likely as the best reading), the cell counts as correct. A real
     mistake is only flagged when the handwriting clearly says something else. Corrected cells are trusted. */
  const VERIFY_REL = 0.2;
  function verifyCells(si, ev) {
    const check = (key, c) => {
      if (!c || (c.st !== 'bad' && c.st !== 'warn') || Number.isNaN(c.exp) || S.over.has(key)) return;
      const m = S.cands.get(key);
      if (m && (m.get(String(c.exp)) || 0) >= VERIFY_REL) { c.st = 'ok'; c.w = c.exp; }
    };
    ev.res.forEach((r, ri) => { check(`${si}:${ri}:sub`, r.sub); check(`${si}:${ri}:cum`, r.cum); });
    check(`${si}:t`, ev.total);
  }

  /* ---------------------------------------------------------------- overlay */
  function frameToScreen() {
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    const s = Math.max(cw / S.frameW, ch / S.frameH);
    return { s, ox: (cw - S.frameW * s) / 2, oy: (ch - S.frameH * s) / 2 };
  }
  function canToScreen(g, x, y, f2s) {
    const m = g.Tinv, w = m[6] * x + m[7] * y + m[8];
    const fx = (m[0] * x + m[1] * y + m[2]) / w, fy = (m[3] * x + m[4] * y + m[5]) / w;
    return { x: fx * f2s.s + f2s.ox, y: fy * f2s.s + f2s.oy };
  }
  function cellQuad(g, field, r, f2s) {
    const span = field[0] === 'a' ? g.spans.arrows[+field.slice(1)] : g.spans[field];
    const x0 = PAD + g.cols[span[0]] * g.W, x1 = PAD + g.cols[span[1]] * g.W, y0 = PAD + r * ROWH, y1 = y0 + ROWH;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => canToScreen(g, x, y, f2s));
  }
  const COLORS = { ok: '#2ecc71', bad: '#ff5252', miss: '#6f8dff', warn: '#ffb020' };

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    const c = overlay.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
    if (!S.geo.length || !S.frameW) return;
    const f2s = frameToScreen();
    S.geo.forEach((g, si) => {
      const { ev, stable } = sheetModel(si);
      const outline = [[PAD, PAD], [PAD + g.W, PAD], [PAD + g.W, PAD + g.H], [PAD, PAD + g.H]].map(([x, y]) => canToScreen(g, x, y, f2s));
      poly(c, outline); c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.5; c.setLineDash([6, 5]); c.stroke(); c.setLineDash([]);
      let upTo = true;
      for (let ri = 0; ri < g.nrows; ri++) {
        upTo = upTo && stable[ri];
        const r = ev.res[ri];
        if (stable[ri]) marker(c, cellQuad(g, 'sub', ri, f2s), r.sub);
        if (upTo && g.spans.cum) marker(c, cellQuad(g, 'cum', ri, f2s), r.cum);
      }
      if (g.hasTotal && upTo && ev.total && get(`${si}:t`) !== undefined) marker(c, cellQuad(g, 'total', g.nrows, f2s), ev.total);
    });
  }
  function poly(c, q) { c.beginPath(); c.moveTo(q[0].x, q[0].y); for (let i = 1; i < q.length; i++) c.lineTo(q[i].x, q[i].y); c.closePath(); }
  function marker(c, q, res) {
    if (!res || res.st === 'none') return;
    const col = COLORS[res.st];
    const h = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    poly(c, q);
    c.lineWidth = Math.max(2, h * 0.07);
    if (res.st === 'ok') { c.strokeStyle = col; c.stroke(); return; }
    // the correct value is written inside the cell, over the handwriting
    c.fillStyle = 'rgba(255,255,255,.9)'; c.fill();
    if (res.st === 'miss') c.setLineDash([h * 0.15, h * 0.1]);
    c.strokeStyle = col; c.stroke(); c.setLineDash([]);
    const txt = Number.isNaN(res.exp) ? '?' : String(res.exp);
    const w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    let fs = Math.max(11, h * 0.66);
    c.font = `700 ${fs}px ui-monospace, Menlo, monospace`;
    const tw = c.measureText(txt).width; if (tw > w * 0.9) { fs *= w * 0.9 / tw; c.font = `700 ${fs}px ui-monospace, Menlo, monospace`; }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = { miss: '#1e3fc0', bad: '#c62828', warn: '#9a6000' }[res.st];
    c.fillText(txt, cx, cy + 1);
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  /* ---------------------------------------------------------------- panel */
  function render() {
    $('m3').setAttribute('aria-pressed', S.mode === 3); $('m6').setAttribute('aria-pressed', S.mode === 6); $('m25').setAttribute('aria-pressed', S.mode === 25);
    drawOverlay();
    const chips = S.geo.map((g, si) => {
      const { ev, allStable, is25 } = sheetModel(si);
      const all = ev.res.flatMap(r => [r.sub, r.cum]).concat([ev.total]).filter(Boolean);
      const n = st => all.filter(x => x.st === st).length;
      let cls, txt;
      if (!allStable && !S.frozen) { cls = 'wait'; txt = 'Lezen…'; }
      else if (n('bad')) { cls = 'bad'; txt = n('bad') + (n('bad') === 1 ? ' fout' : ' fouten'); }
      else if (n('warn') || ev.unreadable) { cls = 'warn'; txt = 'Controleer'; }
      else if (n('miss')) { cls = 'miss'; txt = n('miss') + ' invullen'; }
      else { cls = 'ok'; txt = 'Klopt'; }
      return `<div class="chip"><div><div class="l">Briefje ${si + 1}${is25 ? ' · 25M1P' : ''}</div><div class="s ${cls}">${txt}</div></div><div class="n">${Number.isNaN(ev.cum) ? '?' : ev.cum}</div></div>`;
    });
    $('chips').innerHTML = chips.join('') || `<div class="chip"><div class="s wait">${S.source === 'photo' ? 'Geen tabel gevonden' : 'Zoeken naar scorebriefje…'}</div></div>`;
    if (S.frozen) renderDetail();
    const lost = S.source === 'camera' && !S.frozen && performance.now() - S.lastSeen > 1500;
    if (lost) showHint('Houd het briefje plat en recht in beeld, met de hele scoretabel zichtbaar.'); else if (S.source === 'camera') hideHint();
  }

  function cellHtml(c) {
    if (!c || c.st === 'none') return '';
    const exp = Number.isNaN(c.exp) ? '?' : c.exp;
    if (c.st === 'ok') return `<span class="c-ok">${c.w} ✓</span>`;
    if (c.st === 'miss') return `<span class="c-miss"><span class="e">${exp}</span></span>`;
    if (c.st === 'bad') return `<span class="c-bad"><span class="w">${c.w}</span><span class="e">${exp}</span></span>`;
    const wtxt = c.w === null || Number.isNaN(c.w) ? '?' : c.w;
    return `<span class="c-warn">${wtxt}${Number.isNaN(c.exp) ? ' ?' : ` <small>(${exp}?)</small>`}</span>`;
  }
  function renderDetail() {
    const html = S.geo.map((g, si) => {
      const { sheet, ev, is25 } = sheetModel(si);
      const rows = sheet.rows.map((r, ri) => {
        const rr = ev.res[ri];
        if (rr.role === 'unused' && !rr.sub && !rr.cum && r.arrows.every(a => a === null)) return '';
        const ar = r.arrows.map(a => `<span class="a${a === '?' ? ' q' : ''}">${a === null ? '·' : esc(a)}</span>`).join('');
        return `<tr data-si="${si}" data-ri="${ri}"><td class="pl">${r.label}</td><td>${ar}</td><td>${cellHtml(rr.sub)}</td>${is25 ? '' : `<td>${cellHtml(rr.cum)}</td>`}</tr>`;
      }).join('');
      const tot = ev.total ? `<tr data-si="${si}" data-ri="t"><td class="pl"></td><td>Totaal</td>${is25 ? '' : '<td></td>'}<td>${cellHtml(ev.total)}</td></tr>` : '';
      return `<div class="card"><h2><span>Briefje ${si + 1}${is25 ? ' · 25M1P' : ''}</span><span>${Number.isNaN(ev.cum) ? '?' : ev.cum} van ${ev.arrows * 10}</span></h2>
        <div class="counts"><span>Hits <b>${ev.hits}</b></span><span>10'en <b>${ev.tens}</b></span><span>X <b>${ev.xs}</b></span></div>
        <table><thead><tr><th>${is25 ? 'Pr.' : 'Pl.'}</th><th>Pijlen</th><th>Serie</th>${is25 ? '' : '<th>Totaal</th>'}</tr></thead><tbody>${rows}${tot}</tbody></table></div>`;
    }).join('');
    $('detail').innerHTML = html + '<p style="color:var(--muted);font-size:13px;margin:0">Tik op een regel om een verkeerd gelezen cijfer te verbeteren.</p>';
  }

  /* ---------------------------------------------------------------- freeze */
  function freezeView(on) {
    S.frozen = on;
    if (on) {
      still.width = proc.width; still.height = proc.height;
      still.getContext('2d').drawImage(proc, 0, 0);
      still.hidden = false; video.hidden = true;
    } else {
      still.hidden = true; video.hidden = false;
    }
    $('freeze').textContent = on ? (S.source === 'camera' ? 'Doorgaan' : 'Camera') : 'Vastzetten';
    $('detail').hidden = !on; $('grab').hidden = !on; $('save').hidden = !on || !S.geo.length;
    if (on) setSheet('peek', false); // start small, so the score sheet and its overlay stay visible
    render();
    if (!on) loop();
  }
  $('freeze').onclick = () => {
    if (S.frozen && S.source !== 'camera') { if (stream) { S.source = 'camera'; resetAll(); freezeView(false); } else startCamera(); return; }
    freezeView(!S.frozen);
  };

  /* ------------------------------------------------------- pull-up panel */
  // three resting heights for the table: hidden (peek), half and full; drag the handle or tap it to cycle
  const sheet = { state: 'peek', drag: null, suppressClick: false };
  function sheetHeights() {
    const bar = $('bar'), det = $('detail');
    const chrome = bar.offsetHeight - det.offsetHeight;
    const full = Math.max(140, window.innerHeight * 0.9 - chrome - 64);
    return { peek: 0, half: Math.min(full, window.innerHeight * 0.38), full };
  }
  function setSheet(state, animate = true) {
    sheet.state = state;
    const det = $('detail');
    det.style.transition = animate ? '' : 'none';
    det.style.height = sheetHeights()[state] + 'px';
    if (!animate) requestAnimationFrame(() => { det.style.transition = ''; });
    $('grab').setAttribute('aria-expanded', String(state !== 'peek'));
    $('grabLabel').textContent = state === 'peek' ? 'Sleep omhoog voor de details' : 'Sleep omlaag om het briefje te zien';
  }
  const grabEl = $('grab');
  grabEl.addEventListener('pointerdown', e => {
    sheet.drag = { y: e.clientY, h: $('detail').offsetHeight, moved: false };
    grabEl.setPointerCapture(e.pointerId);
    $('detail').style.transition = 'none';
  });
  grabEl.addEventListener('pointermove', e => {
    if (!sheet.drag) return;
    const dy = sheet.drag.y - e.clientY;
    if (Math.abs(dy) > 6) sheet.drag.moved = true;
    const H = sheetHeights();
    $('detail').style.height = Math.max(0, Math.min(H.full, sheet.drag.h + dy)) + 'px';
  });
  const endDrag = () => {
    if (!sheet.drag) return;
    const moved = sheet.drag.moved; sheet.drag = null;
    $('detail').style.transition = '';
    if (!moved) return; // a tap: handled by click
    sheet.suppressClick = true;
    const H = sheetHeights(), cur = $('detail').offsetHeight;
    setSheet(['peek', 'half', 'full'].reduce((a, b) => Math.abs(H[b] - cur) < Math.abs(H[a] - cur) ? b : a));
  };
  grabEl.addEventListener('pointerup', endDrag);
  grabEl.addEventListener('pointercancel', endDrag);
  grabEl.addEventListener('click', () => {
    if (sheet.suppressClick) { sheet.suppressClick = false; return; }
    setSheet(sheet.state === 'peek' ? 'half' : sheet.state === 'half' ? 'full' : 'peek');
  });
  window.addEventListener('resize', () => { if (S.frozen) setSheet(sheet.state, false); });

  /* ---------------------------------------------------------------- photo */
  async function usePhoto(file) {
    if (!file || !S.ready) return;
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { showHint('Deze foto kan niet geopend worden. Probeer een JPG of PNG.'); return; }
    const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    proc.width = Math.round(bmp.width * s); proc.height = Math.round(bmp.height * s);
    pctx.drawImage(bmp, 0, 0, proc.width, proc.height);
    S.source = 'photo'; S.frozen = true;
    $('start').hidden = true;
    if (S.busy) await new Promise(r => setTimeout(r, 400));
    send(pctx.getImageData(0, 0, proc.width, proc.height), false);
  }
  $('photo').onclick = $('gophoto').onclick = () => $('file').click();
  $('file').onchange = e => { usePhoto(e.target.files[0]); e.target.value = ''; };
  $('go').onclick = startCamera;

  /* ---------------------------------------------------------------- mode */
  function setMode(m) {
    const was25 = S.mode === 25; S.mode = m;
    try { localStorage.setItem('arrowsPerEnd', String(m)); } catch (e) {}
    if (was25 !== (m === 25) && S.source === 'camera') resetAll(); // other kind of sheet: start over
    render();
  }
  $('m3').onclick = () => setMode(3); $('m6').onclick = () => setMode(6); $('m25').onclick = () => setMode(25);
  window.addEventListener('resize', () => render());

  /* ---------------------------------------------------------------- editing */
  let editing = null;
  $('detail').onclick = e => { const tr = e.target.closest('tr[data-si]'); if (tr) openEditor(+tr.dataset.si, tr.dataset.ri); };
  overlay.onclick = e => {
    if (!S.frozen || !S.geo.length) return;
    const f2s = frameToScreen(); const px = e.clientX, py = e.clientY;
    for (let si = 0; si < S.geo.length; si++) {
      const g = S.geo[si];
      for (let ri = 0; ri <= g.nrows; ri++) {
        if (ri === g.nrows && !g.hasTotal) break;
        const q = cellQuad(g, 'row', ri, f2s);
        const extra = ri === g.nrows ? cellQuad(g, 'total', ri, f2s) : cellQuad(g, g.spans.cum ? 'cum' : 'sub', ri, f2s);
        if (inside(q, px, py) || inside(extra, px, py)) { openEditor(si, ri === g.nrows ? 't' : String(ri)); return; }
      }
    }
  };
  function inside(q, x, y) { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { if (((q[i].y > y) !== (q[j].y > y)) && x < (q[j].x - q[i].x) * (y - q[i].y) / (q[j].y - q[i].y) + q[i].x) c = !c; } return c; }

  function openEditor(si, ri) {
    editing = { si, ri };
    const show = v => v === null || v === undefined ? '' : v;
    if (ri === 't') {
      $('dlgTitle').textContent = `Briefje ${si + 1} · totaal`;
      $('dlgArrows').innerHTML = ''; $('dlgArrows').hidden = true; $('dlgSub').parentElement.hidden = true; $('dlgCum').parentElement.hidden = false;
      $('dlgCum').value = show(get(`${si}:t`));
    } else {
      $('dlgTitle').textContent = `Briefje ${si + 1} · regel ${(+ri + 1) * 3}`;
      $('dlgArrows').hidden = false; $('dlgSub').parentElement.hidden = false;
      const g = S.geo[si], na = g.spans.arrows.length;
      $('dlgTitle').textContent = `Briefje ${si + 1} · ${g.layout === '25m1p' ? 'serie' : 'regel'} ${(+ri + 1) * g.step}`;
      $('dlgArrows').style.gridTemplateColumns = `repeat(${na}, 1fr)`;
      $('dlgArrows').innerHTML = Array.from({ length: na }, (_, k) => `<label>Pijl ${k + 1}<input id="dlgA${k}" maxlength="2" value="${esc(show(get(`${si}:${ri}:a${k}`)))}"></label>`).join('');
      $('dlgSub').value = show(get(`${si}:${ri}:sub`)); $('dlgCum').value = show(get(`${si}:${ri}:cum`));
      $('dlgCum').parentElement.hidden = !g.spans.cum;
    }
    $('dlg').showModal();
  }
  const clean = v => { const s = v.trim().toUpperCase(); return s === '' ? null : s; };
  $('dlgCancel').onclick = () => $('dlg').close();
  $('dlgForm').onsubmit = e => {
    e.preventDefault();
    const { si, ri } = editing;
    if (ri === 't') S.over.set(`${si}:t`, clean($('dlgCum').value));
    else {
      const g = S.geo[si];
      g.spans.arrows.forEach((_, k) => S.over.set(`${si}:${ri}:a${k}`, clean($(`dlgA${k}`).value)));
      S.over.set(`${si}:${ri}:sub`, clean($('dlgSub').value));
      if (g.spans.cum) S.over.set(`${si}:${ri}:cum`, clean($('dlgCum').value));
    }
    $('dlg').close(); render();
  };

  /* ------------------------------------------------------------ training data */
  $('save').onclick = () => {
    if (!S.geo.length) return;
    $('save').disabled = true;
    const img = pctx.getImageData(0, 0, proc.width, proc.height);
    const id = S.frameId + 1;
    S.pendingCanon = { id, cb: res => { $('save').disabled = false; exportTraining(res); } };
    send(img, true);
  };
  function exportTraining(res) {
    const sheets = res.sheets.map((sh, si) => {
      const c = document.createElement('canvas'); c.width = sh.cw; c.height = sh.ch;
      const cx = c.getContext('2d'), id = cx.createImageData(sh.cw, sh.ch);
      for (let i = 0; i < sh.canon.length; i++) { const v = sh.canon[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      cx.putImageData(id, 0, 0);
      const model = si < S.geo.length ? sheetModel(si).sheet : null;
      return { image: c.toDataURL('image/png'), layout: sh.layout, rowHeight: ROWH, pad: PAD, gridWidth: sh.W, columns: sh.cols, rowsInImage: sh.nrows + (sh.hasTotal ? 1 : 0), hasTotal: sh.hasTotal, rows: model ? model.rows : [], total: model && model.total ? model.total.value : null };
    });
    const blob = new Blob([JSON.stringify({ app: 'scorebriefje-live', version: 1, created: new Date().toISOString(), sheets })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'scorebriefje-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Opgeslagen. Stuur het bestand mee bij het verbeteren van de herkenning.');
  }

  /* ---------------------------------------------------------------- misc */
  function showHint(t) { $('hint').textContent = t; $('hint').hidden = false; }
  function hideHint() { $('hint').hidden = true; }
  function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
