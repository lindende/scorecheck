/* ScoreChecker Live — camera, voting over frames, scoring and overlay. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { evaluate, evaluateIanseo, resolveArrows, numVal } = self.Scoring;

  const ROWH = 40, PAD = 20;
  const MODES = { '3': '3 pijlen', '6': '6 pijlen', '25': '25M1P' };
  const VOTE_N = 7, VOTE_MIN = 3;
  const CONF = { arrow: 0.5, num: 0.4 };
  const MAX_SIDE = 1280;

  const S = {
    mode: 18, frozen: false, source: null, ready: false, busy: false,
    geo: [], frameW: 0, frameH: 0,
    hist: new Map(), vals: new Map(), over: new Map(), conf: new Map(), cands: new Map(), dist: new Map(),
    lastSeen: 0, lastResult: null, frameId: 0, pendingCanon: null
  };
  // kind of match: 18 = 18M indoor (ends of 3, no X written), 5070 = 50/70M outdoor (ends of 3 or 6, X written), 25 = 25M1P
  try {
    const m = localStorage.getItem('matchType'), old = localStorage.getItem('arrowsPerEnd');
    if (m === '5070' || m === '25' || m === '18') S.mode = +m; else if (old === '6') S.mode = 5070; else if (old === '25') S.mode = 25;
  } catch (e) {}

  const video = $('video'), still = $('still'), overlay = $('overlay');
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });


  /* ---------------------------------------------------------------- language */
  const I18N = {
    nl: {
      segAria: 'Soort wedstrijd', m25Title: '25 meter 1 pijl: 5 series van 5 pijlen', m25Auto: '25M1P automatisch herkend',
      m18Title: '18M: 18 meter indoor, series van 3 pijlen, X wordt niet geschreven', m5070Title: '50/70M: outdoor, series van 3 of 6 pijlen, X wordt geschreven',
      m5070Auto: 'Ianseo-briefje herkend: 50/70M', sum: 'Som', tenX: '10+X', x: 'X', perN: 'series van {n}', filledTen: 'Niet goed te lezen; de pijlen staan van hoog naar laag, dus dit is {v}',
      torch: 'Lamp', photo: 'Foto', training: 'Trainingsdata', freeze: 'Vastzetten', resume: 'Doorgaan', camera: 'Camera',
      targetAria: 'Doelpak met drie pijlen in de 10, de 9 en de 8',
      intro: 'Richt de camera op het scorebriefje. De app telt de pijlen na en controleert de series en het totaal. Kies bovenin 18M (indoor, series van 3), 50/70M (outdoor, series van 3 of 6, ook Ianseo-briefjes) of 25M1P. Een Ianseo- of 25M1P-briefje wordt vanzelf herkend.',
      exampleAria: 'Voorbeeld: regel 3, pijlen 10, 9 en 8, serie 27 klopt',
      loading: 'Herkenning laden…', ready: 'Klaar. De herkenning werkt op je telefoon zelf, er gaat niets naar internet.',
      loadFail: 'Herkenning kon niet laden: {e}', startCamera: 'Camera starten', choosePhoto: 'Foto kiezen', version: 'Versie 23 · 6 november 2026',
      needHttps: 'De camera werkt alleen als de app via https geopend is.',
      noCamAccess: 'Geen toegang tot de camera. Sta camera-toegang toe voor deze site in de browserinstellingen.',
      camFail: 'De camera kon niet starten ({e}).',
      noTablePhoto: 'Geen scoretabel gevonden op deze foto. Fotografeer het briefje recht van boven, met de hele tabel in beeld.',
      reading: 'Lezen…', errors1: '1 fout', errorsN: '{n} fouten', check: 'Controleer', fill: '{n} invullen', ok: 'Klopt',
      sheet: 'Briefje', noTable: 'Geen tabel gevonden', searching: 'Zoeken naar scorebriefje…',
      holdFlat: 'Houd het briefje plat en recht in beeld, met de hele scoretabel zichtbaar.',
      total: 'Totaal', of: 'van', tens: "10'en", colRow18: 'Pl.', colRow25: 'Pr.', arrows: 'Pijlen', end: 'Serie',
      tapRow: 'Tik op een regel om een verkeerd gelezen cijfer te verbeteren.',
      panHint: 'Versleep de foto om te verschuiven, knijp om te zoomen, dubbeltik om passend te maken.',
      grabUp: 'Sleep omhoog voor de details', grabDown: 'Sleep omlaag om het briefje te zien',
      badPhoto: 'Deze foto kan niet geopend worden. Probeer een JPG of PNG.',
      dlgTotal: 'totaal', dlgRow: 'regel', dlgEnd: 'serie', arrowN: 'Pijl {n}',
      dlgHelp: 'Pas aan wat verkeerd gelezen is. Laat een vak leeg als er niets staat.', cancel: 'Annuleren', save: 'Opslaan',
      saved: 'Opgeslagen. Stuur het bestand mee bij het verbeteren van de herkenning.',
      langSwitch: 'Switch to English', langOther: 'English'
    },
    en: {
      segAria: 'Kind of match', m25Title: '25 metres one spot: 5 ends of 5 arrows', m25Auto: '25M1P detected automatically',
      m18Title: '18M: 18 metres indoor, ends of 3 arrows, X is not written', m5070Title: '50/70M: outdoor, ends of 3 or 6 arrows, X is written',
      m5070Auto: 'Ianseo card detected: 50/70M', sum: 'Sum', tenX: '10+X', x: 'X', perN: 'ends of {n}', filledTen: 'Hard to read; arrows go from high to low, so this is {v}',
      torch: 'Torch', photo: 'Photo', training: 'Training data', freeze: 'Freeze', resume: 'Resume', camera: 'Camera',
      targetAria: 'Target face with three arrows in the 10, the 9 and the 8',
      intro: 'Point the camera at the score sheet. The app adds up the arrows and checks the ends and the total. Choose 18M (indoor, ends of 3), 50/70M (outdoor, ends of 3 or 6, also Ianseo cards) or 25M1P at the top. An Ianseo or 25M1P card is recognised automatically.',
      exampleAria: 'Example: row 3, arrows 10, 9 and 8, end total 27 is correct',
      loading: 'Loading recognition…', ready: 'Ready. Recognition runs on your phone itself; nothing is sent to the internet.',
      loadFail: 'Recognition could not load: {e}', startCamera: 'Start camera', choosePhoto: 'Choose photo', version: 'Version 23 · 6 November 2026',
      needHttps: 'The camera only works when the app is opened over https.',
      noCamAccess: 'No access to the camera. Allow camera access for this site in your browser settings.',
      camFail: 'The camera could not start ({e}).',
      noTablePhoto: 'No score table found in this photo. Photograph the sheet straight from above, with the whole table in view.',
      reading: 'Reading…', errors1: '1 error', errorsN: '{n} errors', check: 'Check', fill: '{n} to fill in', ok: 'Correct',
      sheet: 'Sheet', noTable: 'No table found', searching: 'Looking for a score sheet…',
      holdFlat: 'Hold the sheet flat and straight in view, with the whole score table visible.',
      total: 'Total', of: 'of', tens: '10s', colRow18: 'Row', colRow25: '#', arrows: 'Arrows', end: 'End',
      tapRow: 'Tap a row to correct a misread digit.',
      panHint: 'Drag the photo to move it, pinch to zoom, double-tap to fit.',
      grabUp: 'Drag up for details', grabDown: 'Drag down to see the sheet',
      badPhoto: 'This photo cannot be opened. Try a JPG or PNG.',
      dlgTotal: 'total', dlgRow: 'row', dlgEnd: 'end', arrowN: 'Arrow {n}',
      dlgHelp: 'Correct what was misread. Leave a box empty if nothing is written.', cancel: 'Cancel', save: 'Save',
      saved: 'Saved. Send the file along to help improve the recognition.',
      langSwitch: 'Schakel naar Nederlands', langOther: 'Nederlands'
    }
  };
  const FLAGS = {
    nl: '<svg viewBox="0 0 9 6" aria-hidden="true"><rect width="9" height="2" fill="#AE1C28"/><rect y="2" width="9" height="2" fill="#fff"/><rect y="4" width="9" height="2" fill="#21468B"/></svg>',
    en: '<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="ukS"><path d="M0,0v30h60V0z"/></clipPath><clipPath id="ukT"><path d="M30,15h30v15zv15H0zH0V0zV0h30z"/></clipPath><g clip-path="url(#ukS)"><path d="M0,0v30h60V0z" fill="#012169"/><path d="M0,0L60,30M60,0L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0L60,30M60,0L0,30" clip-path="url(#ukT)" stroke="#C8102E" stroke-width="4"/><path d="M30,0v30M0,15h60" stroke="#fff" stroke-width="10"/><path d="M30,0v30M0,15h60" stroke="#C8102E" stroke-width="6"/></g></svg>'
  };
  let LANG = 'nl';
  try { const l = localStorage.getItem('lang'); LANG = l === 'en' || l === 'nl' ? l : ((navigator.language || 'nl').toLowerCase().startsWith('nl') ? 'nl' : 'en'); } catch (e) {}
  const t = (key, vars) => { let str = (I18N[LANG] && I18N[LANG][key]) ?? I18N.nl[key] ?? key; if (vars) for (const k in vars) str = str.replace('{' + k + '}', vars[k]); return str; };
  let loadState = { key: 'loading' };
  function showLoad(key, vars, err) { loadState = { key, vars, err }; const el = $('loadmsg'); if (err) el.innerHTML = '<span class="err">' + esc(t(key, vars)) + '</span>'; else el.textContent = t(key, vars); }
  function applyLang() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    const other = LANG === 'nl' ? 'en' : 'nl';
    $('lang').innerHTML = FLAGS[other] + '<span>' + t('langOther') + '</span>';
    $('lang').setAttribute('aria-label', t('langSwitch')); $('lang').title = t('langSwitch');
    showLoad(loadState.key, loadState.vars, loadState.err);
    $('grabLabel').textContent = t(typeof sheet !== 'undefined' && sheet.state !== 'peek' ? 'grabDown' : 'grabUp');
    $('freeze').textContent = S.frozen ? t(S.source === 'camera' ? 'resume' : 'camera') : t('freeze');
    render();
  }
  $('lang').onclick = () => { LANG = LANG === 'nl' ? 'en' : 'nl'; try { localStorage.setItem('lang', LANG); } catch (e) {} applyLang(); };

  /* ---------------------------------------------------------------- worker */
  const worker = new Worker('worker.js');
  let fake = 0; const progTimer = setInterval(() => { fake = Math.min(92, fake + (100 - fake) * 0.06); $('prog').style.width = fake + '%'; }, 200);
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'ready') {
      S.ready = true; clearInterval(progTimer); $('prog').style.width = '100%';
      showLoad('ready');
      $('go').disabled = false; $('gophoto').disabled = false;
    } else if (m.type === 'error') {
      showLoad('loadFail', { e: m.message }, true);
    } else if (m.type === 'result') onResult(m);
  };

  /* ---------------------------------------------------------------- camera */
  let stream = null, track = null, wakeLock = null;
  async function startCamera() {
    if (!window.isSecureContext) { showLoad('needHttps', null, true); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      if (e.name === 'NotAllowedError') showLoad('noCamAccess', null, true); else showLoad('camFail', { e: e.name || String(e) }, true);
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
    const layouts = S.mode === 25 ? ['25m1p'] : ['18m3', '25m1p', 'ianseo'];
    worker.postMessage({ type: 'frame', id: S.frameId, buffer: img.data.buffer, width: img.width, height: img.height, canon, layouts, noX: S.mode === 18 }, [img.data.buffer]);
  }
  function loop() {
    if (S.frozen || S.source !== 'camera') return;
    if (!S.busy) { const img = grab(); if (img) send(img, false); else requestAnimationFrame(loop); }
  }

  /* ---------------------------------------------------------------- voting */
  function resetAll() { S.hist.clear(); S.vals.clear(); S.over.clear(); S.conf.clear(); S.cands.clear(); S.dist.clear(); S.geo = []; }
  // how likely each arrow value is for a mark, added up over the frames (index: 0 = M … 10, 11 = X)
  function keepDist(key, dist, instant) {
    if (!dist) return;
    const m = !instant && S.dist.get(key) || new Float32Array(12);
    for (let r = 0; r < 12; r++) m[r] += dist[r];
    S.dist.set(key, m);
  }
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
  /* The number cells of a row (or of the total row, ri = 't') as [field, label]. On an Ianseo card the
     end total and running total are only on the second row of each pair. */
  function numFields(g, ri) {
    if (ri === 't') return [['t', 'total']].concat(g.spans.ttx ? [['ttx', 'tenX']] : [], g.spans.txx ? [['txx', 'x']] : []);
    const second = !g.pairs || +ri % 2 === 1;
    const f = [['sub', g.pairs ? 'sum' : 'end']];
    if (g.spans.end && second) f.push(['end', 'end']);
    if (g.spans.cum && second) f.push(['cum', 'total']);
    if (g.spans.tx) f.push(['tx', 'tenX']);
    if (g.spans.xx) f.push(['xx', 'x']);
    return f;
  }
  const keyOf = (si, ri, f) => ri === 't' ? `${si}:${f}` : `${si}:${ri}:${f}`;

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
      S.geo = res.sheets.map(sh => ({ quad: sh.quad, Tinv: sh.Tinv, W: sh.W, H: sh.H, nrows: sh.nrows, hasTotal: sh.hasTotal, layout: sh.layout, cols: sh.cols, spans: sh.spans, step: sh.step, pairs: !!sh.pairs }));
      res.sheets.forEach((sh, si) => {
        sh.rows.forEach((r, ri) => {
          r.arrows.forEach((a, k) => { vote(`${si}:${ri}:a${k}`, cellVal(a, 'arrow'), instant, a.conf); keepDist(`${si}:${ri}:a${k}`, a.dist, instant); });
          for (const [f] of numFields(S.geo[si], ri)) {
            const c = r[f]; if (!c) continue;
            vote(keyOf(si, ri, f), cellVal(c, 'num'), instant, c.conf); keepCands(keyOf(si, ri, f), c.cands);
          }
        });
        if (sh.hasTotal) for (const [f] of numFields(S.geo[si], 't')) {
          const c = f === 't' ? sh.total : sh.totals && sh.totals[f]; if (!c) continue;
          vote(keyOf(si, 't', f), cellVal(c, 'num'), instant); keepCands(keyOf(si, 't', f), c.cands);
        }
      });
      S.lastResult = res;
    } else if (instant) {
      S.geo = []; S.frameW = res.width; S.frameH = res.height;
    }
    render();
    if (instant) { freezeView(true); if (!res.sheets.length) showHint(t('noTablePhoto')); }
    else requestAnimationFrame(loop);
  }

  /* --------------------------------------------------------------- model */
  const get = key => S.over.has(key) ? S.over.get(key) : S.vals.get(key);
  function sheetModel(si) {
    const g = S.geo[si]; const rows = []; const stable = [];
    const na = g.spans.arrows.length, isIan = g.layout === 'ianseo', is25 = g.layout === '25m1p';
    const val = k => { const v = get(k); return v === undefined ? null : v; };
    for (let ri = 0; ri < g.nrows; ri++) {
      const keys = g.spans.arrows.map((_, k) => 'a' + k).concat(numFields(g, ri).map(([f]) => f));
      stable.push(keys.every(k => get(`${si}:${ri}:${k}`) !== undefined));
      const label = isIan ? (ri % 2 === 0 ? String(ri / 2 + 1) : '') : String((ri + 1) * g.step);
      const row = { label, arrows: g.spans.arrows.map((_, k) => val(`${si}:${ri}:a${k}`)), sub: val(`${si}:${ri}:sub`), cum: g.spans.cum ? val(`${si}:${ri}:cum`) : null, filled: [] };
      // arrows go from high to low: an unreadable arrow lies between its neighbours (9 ? 9 is 9, 10 ? 9 is 10
      // or 9, ? 10 is 10, or 10/X where X is written); a value typed in by hand is left alone
      if (!is25) {
        const dists = row.arrows.map((_, k) => S.over.has(`${si}:${ri}:a${k}`) ? null : S.dist.get(`${si}:${ri}:a${k}`));
        const r = resolveArrows(row.arrows, isIan || S.mode !== 18, dists, row.sub);
        row.arrows = r.arrows; row.filled = r.filled;
      }
      if (isIan) { row.end = val(`${si}:${ri}:end`); row.tx = val(`${si}:${ri}:tx`); row.xx = val(`${si}:${ri}:xx`); }
      rows.push(row);
    }
    const tkeys = g.hasTotal ? numFields(g, 't').map(([f]) => keyOf(si, 't', f)) : [];
    const sheet = { rows, total: g.hasTotal ? { value: val(`${si}:t`) } : null };
    if (isIan) sheet.totals = { ttx: val(`${si}:ttx`), txx: val(`${si}:txx`) };
    // 50/70M on a club card: ends of 3 or 6, told apart by where the sums are written
    const per = is25 ? 5 : isIan ? 6 : S.mode === 5070 ? endSize(rows) : 3;
    const ev = isIan ? evaluateIanseo(sheet) : evaluate(sheet, is25 ? 3 : per, { noCum: !g.spans.cum });
    if (isIan) ianCrossCheck(si, sheet, ev);
    else if (!is25 && per === 3) crossCheck(si, sheet, ev);
    verifyCells(si, ev);
    const allStable = stable.every(Boolean) && tkeys.every(k => get(k) !== undefined);
    return { sheet, ev, stable, allStable, is25, isIan, per };
  }

  /* Ends of 6 on a club card (two rows of 3): the end total and running total are written on the second
     row only, or an end total is above 30. Otherwise ends of 3. */
  function endSize(rows) {
    const used = rows.map((r, i) => r.arrows.some(a => a !== null) ? i : -1).filter(i => i >= 0);
    if (used.length < 2) return 3;
    if (used.some(i => { const v = numVal(rows[i].sub); return v !== null && v > 30; })) return 6;
    const first = used.filter((_, k) => k % 2 === 0), second = used.filter((_, k) => k % 2 === 1);
    const filled = list => list.filter(i => numVal(rows[i].sub) !== null || numVal(rows[i].cum) !== null).length;
    return second.length && filled(second) >= 0.6 * second.length && filled(first) <= 0.3 * first.length ? 6 : 3;
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

  /* Ianseo: per end of 6 the card has two sums, the end total and the running total. When those written
     numbers agree with each other (sum + sum = end, previous total + end = total) but not with the arrows
     as read, an arrow was most likely misread: "controleer" (amber) instead of "fout" (red). A running
     total that is right given the previous written total only inherits an earlier difference: amber too. */
  function ianCrossCheck(si, sheet, ev) {
    const num = v => (v !== null && /^\d+$/.test(v)) ? +v : null;
    const rows = sheet.rows;
    const manual = (i, k) => S.over.has(`${si}:${i}:${k}`);
    const arrowsSure = i => rows[i].arrows.every((_, k) => manual(i, 'a' + k));
    let prev = 0, lastCum = null;
    for (let a = 0; a + 1 < rows.length; a += 2) {
      const b = a + 1, ra = ev.res[a], rb = ev.res[b];
      if (ra.role === 'unused') continue;
      const wa = num(rows[a].sub), wb = num(rows[b].sub), we = num(rows[b].end), wc = num(rows[b].cum);
      const chain = wa !== null && wb !== null && we !== null && wa + wb === we && (wc === null || prev === null || prev + we === wc);
      const soft = (r, i, f) => { if (r[f] && r[f].st === 'bad' && !manual(i, f)) r[f].st = 'warn'; };
      if (chain && !(arrowsSure(a) && arrowsSure(b))) { soft(ra, a, 'sub'); soft(rb, b, 'sub'); soft(rb, b, 'end'); soft(rb, b, 'cum'); }
      const exp = rb.end && !Number.isNaN(rb.end.exp) ? rb.end.exp : null;
      if (rb.cum && rb.cum.st === 'bad' && prev !== null && exp !== null && prev + exp === wc) soft(rb, b, 'cum');
      prev = wc; lastCum = rb.cum;
    }
    // the total only repeats the last running total
    if (ev.total && ev.total.st === 'bad' && !S.over.has(`${si}:t`) && lastCum && lastCum.st === 'warn' && num(sheet.total.value) === prev) ev.total.st = 'warn';
  }

  /* The app checks rather than reads: if the correct value is also a plausible reading of the
     handwriting (at least 20% as likely as the best reading), the cell counts as correct. A real
     mistake is only flagged when the handwriting clearly says something else. Corrected cells are trusted. */
  const VERIFY_REL = 0.2;
  const CELLS = ['sub', 'end', 'cum', 'tx', 'xx'];
  function verifyCells(si, ev) {
    const check = (key, c) => {
      if (!c || (c.st !== 'bad' && c.st !== 'warn') || Number.isNaN(c.exp) || S.over.has(key)) return;
      const m = S.cands.get(key);
      if (m && (m.get(String(c.exp)) || 0) >= VERIFY_REL) { c.st = 'ok'; c.w = c.exp; }
    };
    ev.res.forEach((r, ri) => { for (const f of CELLS) check(`${si}:${ri}:${f}`, r[f]); });
    check(`${si}:t`, ev.total); check(`${si}:ttx`, ev.ttx); check(`${si}:txx`, ev.txx);
  }

  /* ---------------------------------------------------------------- overlay */
  function frameToScreen() {
    if (S.frozen && S.view) return S.view;
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
        if (stable[ri]) for (const f of ['sub', 'end', 'tx', 'xx']) if (g.spans[f]) marker(c, cellQuad(g, f, ri, f2s), r[f]);
        if (upTo && g.spans.cum) marker(c, cellQuad(g, 'cum', ri, f2s), r.cum);
      }
      if (g.hasTotal && upTo) for (const [f, sp, k] of [['total', 'total', 't'], ['ttx', 'ttx', 'ttx'], ['txx', 'txx', 'txx']])
        if (g.spans[sp] && ev[f] && get(`${si}:${k}`) !== undefined) marker(c, cellQuad(g, sp, g.nrows, f2s), ev[f]);
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
    // a 25m1p sheet is recognised by itself; show that in the switch without changing the chosen mode
    const auto25 = S.mode !== 25 && S.geo.length > 0 && S.geo.every(g => g.layout === '25m1p');
    // an Ianseo card is an outdoor (50/70M) card: show '50/70M auto'
    const autoIan = S.mode === 18 && S.geo.length > 0 && S.geo.every(g => g.layout === 'ianseo');
    const shown = auto25 ? 25 : autoIan ? 5070 : S.mode;
    $('m18').setAttribute('aria-pressed', shown === 18); $('m5070').setAttribute('aria-pressed', shown === 5070); $('m25').setAttribute('aria-pressed', shown === 25);
    $('m25').classList.toggle('auto', auto25);
    $('m25').title = auto25 ? t('m25Auto') : t('m25Title');
    $('m5070').classList.toggle('auto', autoIan);
    $('m5070').title = autoIan ? t('m5070Auto') : t('m5070Title');
    $('m18').title = t('m18Title');
    drawOverlay();
    const chips = S.geo.map((g, si) => {
      const { ev, allStable, is25, isIan, per } = sheetModel(si);
      const all = ev.res.flatMap(r => CELLS.map(f => r[f])).concat([ev.total, ev.ttx, ev.txx]).filter(Boolean);
      const n = st => all.filter(x => x.st === st).length;
      let cls, txt;
      if (!allStable && !S.frozen) { cls = 'wait'; txt = t('reading'); }
      else if (n('bad')) { cls = 'bad'; txt = n('bad') === 1 ? t('errors1') : t('errorsN', { n: n('bad') }); }
      else if (n('warn') || ev.unreadable) { cls = 'warn'; txt = t('check'); }
      else if (n('miss')) { cls = 'miss'; txt = t('fill', { n: n('miss') }); }
      else { cls = 'ok'; txt = t('ok'); }
      return `<div class="chip" data-si="${si}" role="button" tabindex="0"><div><div class="l">${t('sheet')} ${si + 1}${tagOf(is25, isIan, per)}</div><div class="s ${cls}">${txt}</div></div><div class="n">${Number.isNaN(ev.cum) ? '?' : ev.cum}</div></div>`;
    });
    $('chips').innerHTML = chips.join('') || `<div class="chip"><div class="s wait">${S.source === 'photo' ? t('noTable') : t('searching')}</div></div>`;
    if (S.frozen) renderDetail();
    const lost = S.source === 'camera' && !S.frozen && performance.now() - S.lastSeen > 1500;
    if (lost) showHint(t('holdFlat')); else if (S.source === 'camera') hideHint();
  }

  // label next to 'Briefje n': the kind of card, and for 50/70M on a club card the end size found
  const tagOf = (is25, isIan, per) => is25 ? ' · 25M1P' : isIan ? ' · Ianseo' : S.mode === 5070 ? ` · ${t('perN', { n: per })}` : '';
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
      const { sheet, ev, is25, isIan, per } = sheetModel(si);
      // columns after the arrows: [header, field]
      const cols = isIan ? [['sum', 'sub'], ['end', 'end'], ['total', 'cum'], ['tenX', 'tx'], ['x', 'xx']]
        : [['end', 'sub']].concat(is25 ? [] : [['total', 'cum']]);
      const rows = sheet.rows.map((r, ri) => {
        const rr = ev.res[ri];
        if (rr.role === 'unused' && !CELLS.some(f => rr[f]) && r.arrows.every(a => a === null)) return '';
        const ar = r.arrows.map((a, k) => r.filled.includes(k)
          ? `<span class="a f" title="${esc(t('filledTen', { v: a }))}">${esc(a)}</span>`
          : `<span class="a${a === '?' ? ' q' : ''}">${a === null ? '·' : esc(a)}</span>`).join('');
        const cls = isIan && ri % 2 === 0 && ri > 0 ? ' class="ps"' : '';
        return `<tr${cls} data-si="${si}" data-ri="${ri}"><td class="pl">${r.label}</td><td class="ar">${ar}</td>${cols.map(([, f]) => `<td>${cellHtml(rr[f])}</td>`).join('')}</tr>`;
      }).join('');
      let tot = '';
      if (ev.total) {
        const tcell = { sub: null, end: null, cum: ev.total, tx: ev.ttx, xx: ev.txx };
        const tc = is25 ? [['', 'cum']] : cols; // 25m1p: total sits under the end column
        tot = `<tr class="ps" data-si="${si}" data-ri="t"><td class="pl"></td><td>${t('total')}</td>${tc.map(([, f]) => `<td>${cellHtml(tcell[f])}</td>`).join('')}</tr>`;
      }
      const tag = tagOf(is25, isIan, per);
      return `<div class="card" id="card${si}"><h2><span>${t('sheet')} ${si + 1}${tag}</span><span>${Number.isNaN(ev.cum) ? '?' : ev.cum} ${t('of')} ${ev.arrows * 10}</span></h2>
        <div class="counts"><span>Hits <b>${ev.hits}</b></span><span>${t('tens')} <b>${ev.tens}</b></span><span>X <b>${ev.xs}${ev.xsMaybe ? '–' + (ev.xs + ev.xsMaybe) : ''}</b></span></div>
        <div class="tw"><table${isIan ? ' class="ian"' : ''}><thead><tr><th>${t(is25 || isIan ? 'colRow25' : 'colRow18')}</th><th>${t('arrows')}</th>${cols.map(([h]) => `<th>${t(h)}</th>`).join('')}</tr></thead><tbody>${rows}${tot}</tbody></table></div></div>`;
    }).join('');
    $('detail').innerHTML = html + '<p style="color:var(--muted);font-size:13px;margin:0">' + esc(t('tapRow')) + '</p>';
  }

  // tapping a summary opens the panel at that sheet's table
  function showCard(si) {
    if (!S.frozen) return;
    if (sheet.state === 'peek') setSheet('half');
    const det = $('detail'), card = $('card' + si);
    if (card) setTimeout(() => det.scrollTo({ top: card.offsetTop - det.offsetTop, behavior: 'smooth' }), 60);
  }
  $('chips').addEventListener('click', e => { const c = e.target.closest('.chip[data-si]'); if (c) showCard(+c.dataset.si); });
  $('chips').addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const c = e.target.closest('.chip[data-si]'); if (c) { e.preventDefault(); showCard(+c.dataset.si); } });

  /* ---------------------------------------------------------------- freeze */
  function freezeView(on) {
    S.frozen = on;
    if (on) {
      frozen.width = proc.width; frozen.height = proc.height;
      frozen.getContext('2d').drawImage(proc, 0, 0);
      still.hidden = false; video.hidden = true;
      S.view = null; S.userView = false;
    } else {
      still.hidden = true; video.hidden = false; S.view = null;
    }
    $('freeze').textContent = on ? t(S.source === 'camera' ? 'resume' : 'camera') : t('freeze');
    $('detail').hidden = !on; $('grab').hidden = !on; $('save').hidden = !on || !S.geo.length;
    if (on) setSheet('peek', false); // start small, so the score sheet and its overlay stay visible
    if (on) requestAnimationFrame(() => { fitView(); redrawFrozen(); maybeHintPan(); });
    render();
    if (!on) loop();
  }
  $('freeze').onclick = () => {
    if (S.frozen && S.source !== 'camera') { if (stream) { S.source = 'camera'; resetAll(); freezeView(false); } else startCamera(); return; }
    freezeView(!S.frozen);
  };

  /* ------------------------------------------------- frozen view: fit, pan, zoom */
  const frozen = document.createElement('canvas');
  // the part of the screen that is not covered by the top bar and the panel
  function visibleArea() {
    const top = document.querySelector('.top').getBoundingClientRect().bottom + 4;
    const bottom = $('bar').getBoundingClientRect().top - 8;
    return { x: 8, y: top, w: overlay.clientWidth - 16, h: Math.max(80, bottom - top) };
  }
  function fitView() {
    if (!S.frozen || !frozen.width) return;
    const fw = frozen.width, fh = frozen.height, A = visibleArea();
    let x0 = 0, y0 = 0, x1 = fw, y1 = fh;
    if (S.geo.length) {
      const pts = S.geo.flatMap(g => g.quad);
      x0 = Math.min(...pts.map(p => p.x)); x1 = Math.max(...pts.map(p => p.x));
      y0 = Math.min(...pts.map(p => p.y)); y1 = Math.max(...pts.map(p => p.y));
      const mx = (x1 - x0) * 0.06, my = (y1 - y0) * 0.06; // room for handwriting past the border
      x0 = Math.max(0, x0 - mx); x1 = Math.min(fw, x1 + mx * 2); y0 = Math.max(0, y0 - my); y1 = Math.min(fh, y1 + my * 2);
    }
    const sc = Math.min(A.w / (x1 - x0), A.h / (y1 - y0));
    S.view = { s: sc, ox: A.x + (A.w - (x1 - x0) * sc) / 2 - x0 * sc, oy: A.y + (A.h - (y1 - y0) * sc) / 2 - y0 * sc };
  }
  function drawStill() {
    if (!S.frozen || !S.view) return;
    const dpr = window.devicePixelRatio || 1, cw = still.clientWidth, ch = still.clientHeight;
    if (still.width !== Math.round(cw * dpr) || still.height !== Math.round(ch * dpr)) { still.width = Math.round(cw * dpr); still.height = Math.round(ch * dpr); }
    const c = still.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, cw, ch);
    c.imageSmoothingQuality = 'high';
    c.drawImage(frozen, S.view.ox, S.view.oy, frozen.width * S.view.s, frozen.height * S.view.s);
  }
  function redrawFrozen() { drawStill(); drawOverlay(); }
  function maybeHintPan() {
    try { if (localStorage.getItem('panHint')) return; localStorage.setItem('panHint', '1'); } catch (e) {}
    toast(t('panHint'));
  }
  const ptrs = new Map(); let panMoved = false, lastTap = 0;
  overlay.addEventListener('pointerdown', e => {
    if (!S.frozen || !S.view) return;
    overlay.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (ptrs.size === 1) panMoved = false;
  });
  overlay.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p || !S.view) return;
    const pts = [...ptrs.values()];
    if (ptrs.size === 1) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) panMoved = true;
      if (panMoved) { S.view.ox += e.clientX - p.x; S.view.oy += e.clientY - p.y; S.userView = true; }
    } else if (ptrs.size === 2) {
      const other = pts.find(q => q !== p);
      const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const f = d0 > 0 ? Math.min(1.25, Math.max(0.8, d1 / d0)) : 1;
      const mx = (e.clientX + other.x) / 2, my = (e.clientY + other.y) / 2;
      const ns = Math.min(12, Math.max(0.05, S.view.s * f)), k = ns / S.view.s;
      S.view.ox = mx - (mx - S.view.ox) * k; S.view.oy = my - (my - S.view.oy) * k; S.view.s = ns;
      panMoved = true; S.userView = true;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (panMoved) redrawFrozen();
  });
  const endPtr = e => { ptrs.delete(e.pointerId); };
  overlay.addEventListener('pointerup', endPtr);
  overlay.addEventListener('pointercancel', endPtr);
  overlay.addEventListener('wheel', e => {
    if (!S.frozen || !S.view) return;
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    S.view.ox = e.clientX - (e.clientX - S.view.ox) * k; S.view.oy = e.clientY - (e.clientY - S.view.oy) * k; S.view.s *= k;
    S.userView = true; redrawFrozen();
  }, { passive: false });
  overlay.addEventListener('dblclick', () => { if (S.frozen) { S.userView = false; fitView(); redrawFrozen(); } });

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
    if (S.frozen && !S.userView) setTimeout(() => { fitView(); redrawFrozen(); }, animate ? 240 : 0);
    $('grabLabel').textContent = t(state === 'peek' ? 'grabUp' : 'grabDown');
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
  window.addEventListener('resize', () => { if (S.frozen) { setSheet(sheet.state, false); if (!S.userView) fitView(); redrawFrozen(); } });

  /* ---------------------------------------------------------------- photo */
  async function usePhoto(file) {
    if (!file || !S.ready) return;
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { showHint(t('badPhoto')); return; }
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
    if (m === S.mode) return;
    S.mode = m;
    try { localStorage.setItem('matchType', String(m)); } catch (e) {}
    // the sheets are read differently per kind of match (X or not, which layouts): read again
    if (S.source === 'camera') resetAll();
    else if (S.source === 'photo' && S.ready && proc.width) { send(pctx.getImageData(0, 0, proc.width, proc.height), false); return; }
    render();
  }
  $('m18').onclick = () => setMode(18); $('m5070').onclick = () => setMode(5070); $('m25').onclick = () => setMode(25);
  window.addEventListener('resize', () => render());

  /* ---------------------------------------------------------------- editing */
  let editing = null;
  $('detail').onclick = e => { const tr = e.target.closest('tr[data-si]'); if (tr) openEditor(+tr.dataset.si, tr.dataset.ri); };
  overlay.onclick = e => {
    if (panMoved) { panMoved = false; return; }
    if (!S.frozen || !S.geo.length) return;
    const f2s = frameToScreen(); const px = e.clientX, py = e.clientY;
    for (let si = 0; si < S.geo.length; si++) {
      const g = S.geo[si];
      for (let ri = 0; ri <= g.nrows; ri++) {
        if (ri === g.nrows && !g.hasTotal) break;
        const q = cellQuad(g, 'row', ri, f2s);
        const extras = ri === g.nrows ? ['total', 'ttx', 'txx'].filter(f => g.spans[f]) : [g.spans.cum ? 'cum' : 'sub'];
        if (inside(q, px, py) || extras.some(f => inside(cellQuad(g, f, ri, f2s), px, py))) { openEditor(si, ri === g.nrows ? 't' : String(ri)); return; }
      }
    }
  };
  function inside(q, x, y) { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { if (((q[i].y > y) !== (q[j].y > y)) && x < (q[j].x - q[i].x) * (y - q[i].y) / (q[j].y - q[i].y) + q[i].x) c = !c; } return c; }

  function openEditor(si, ri) {
    const g = S.geo[si];
    const show = v => v === null || v === undefined ? '' : v;
    const fields = numFields(g, ri);
    editing = { si, ri, fields };
    if (ri === 't') {
      $('dlgTitle').textContent = `${t('sheet')} ${si + 1} · ${t('dlgTotal')}`;
      $('dlgArrows').innerHTML = ''; $('dlgArrows').hidden = true;
    } else {
      const na = g.spans.arrows.length, r = +ri;
      const what = g.pairs ? `${t('dlgEnd')} ${(r >> 1) + 1} (${r % 2 + 1}/2)` : `${t(g.layout === '25m1p' ? 'dlgEnd' : 'dlgRow')} ${(r + 1) * g.step}`;
      $('dlgTitle').textContent = `${t('sheet')} ${si + 1} · ${what}`;
      $('dlgArrows').hidden = false;
      $('dlgArrows').style.gridTemplateColumns = `repeat(${na}, 1fr)`;
      $('dlgArrows').innerHTML = Array.from({ length: na }, (_, k) =>  `<label>${t('arrowN', { n: k + 1 })}<input id="dlgA${k}" maxlength="2" value="${esc(show(get(`${si}:${ri}:a${k}`)))}"></label>`).join('');
    }
    $('dlgNums').style.gridTemplateColumns = fields.length > 2 ? 'repeat(3, 1fr)' : '1fr 1fr';
    $('dlgNums').innerHTML = fields.map(([f, lab]) => `<label><span>${esc(t(lab))}</span><input id="dlgN_${f}" inputmode="numeric" value="${esc(show(get(keyOf(si, ri, f))))}"></label>`).join('');
    $('dlg').showModal();
  }
  const clean = v => { const s = v.trim().toUpperCase(); return s === '' ? null : s; };
  $('dlgCancel').onclick = () => $('dlg').close();
  $('dlgForm').onsubmit = e => {
    e.preventDefault();
    const { si, ri, fields } = editing;
    if (ri !== 't') S.geo[si].spans.arrows.forEach((_, k) => S.over.set(`${si}:${ri}:a${k}`, clean($(`dlgA${k}`).value)));
    for (const [f] of fields) S.over.set(keyOf(si, ri, f), clean($('dlgN_' + f).value));
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
      return { image: c.toDataURL('image/png'), layout: sh.layout, rowHeight: ROWH, pad: PAD, gridWidth: sh.W, columns: sh.cols, rowsInImage: sh.nrows + (sh.hasTotal ? 1 : 0), hasTotal: sh.hasTotal, rows: model ? model.rows : [], total: model && model.total ? model.total.value : null, totals: model && model.totals ? model.totals : null };
    });
    const blob = new Blob([JSON.stringify({ app: 'scorebriefje-live', version: 1, created: new Date().toISOString(), sheets })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'scorebriefje-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(t('saved'));
  }

  /* ---------------------------------------------------------------- misc */
  function showHint(t) { $('hint').textContent = t; $('hint').hidden = false; }
  function hideHint() { $('hint').hidden = true; }
  function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  applyLang();
})();
