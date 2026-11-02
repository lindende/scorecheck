/* Runs OpenCV.js and the digit model off the main thread. */
self.importScripts('opencv.js', 'vision.js');

let predict = null;
const cvReady = new Promise(resolve => {
  // OpenCV.js exposes a "thenable" module: never await it directly (that loops forever).
  const c = self.cv;
  if (c && c.Mat) resolve({ cv: c });
  else c.onRuntimeInitialized = () => resolve({ cv: self.cv });
});
const modelReady = fetch('weights.json').then(r => {
  if (!r.ok) throw new Error('weights.json ' + r.status);
  return r.json();
}).then(w => { predict = self.ScoreVision.makeModel(w); });

Promise.all([cvReady, modelReady])
  .then(() => self.postMessage({ type: 'ready' }))
  .catch(e => self.postMessage({ type: 'error', message: String(e && e.message || e) }));

self.onmessage = async ev => {
  const m = ev.data;
  if (m.type !== 'frame') return;
  const { cv } = await cvReady; await modelReady;
  const t0 = performance.now();
  try {
    const res = self.ScoreVision.processFrame(cv, { data: new Uint8ClampedArray(m.buffer), width: m.width, height: m.height }, predict, { canon: !!m.canon });
    const transfer = [];
    for (const s of res.sheets) if (s.canon) transfer.push(s.canon.buffer);
    self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, result: res }, transfer);
  } catch (e) {
    self.postMessage({ type: 'result', id: m.id, error: String(e && e.message || e), result: { sheets: [], width: m.width, height: m.height } });
  }
};
