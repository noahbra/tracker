// Browser-level tests for what the pure-logic tests cannot show: that the
// medical gates actually render and cannot be tapped past, that ticking the
// rehab card writes the load, and that Export produces every backup file.
//
// Run:
//   python3 -m http.server 8777 &
//   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new \
//      --remote-debugging-port=9333 --user-data-dir=/tmp/tracker-cdp about:blank &
//   node tests/rehab.browser.mjs
//
// The clock is pinned inside the v6 block, or none of it can run before day 1.
const base = 'http://127.0.0.1:9333';
const APP = 'http://localhost:8777/index.html';
const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setBypassServiceWorker', { bypass: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const Real = Date; const fixed = new Real('2026-09-21T18:30:00');
  const D = function (...a) { return a.length ? new Real(...a) : new Real(fixed); };
  D.now = () => fixed.getTime(); D.parse = Real.parse; D.UTC = Real.UTC; D.prototype = Real.prototype;
  window.Date = D; })();` });
const ok = [];
const check = (n, c, d = '') => ok.push({ n, c: !!c, d });
const click = async (sel) => { const hit = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(e) e.click(); return !!e;})()`); await new Promise((r) => setTimeout(r, 500)); return hit; };

await send('Page.navigate', { url: APP });
await new Promise((r) => setTimeout(r, 2500));
await ev(`localStorage.clear(); location.reload();`);
await new Promise((r) => setTimeout(r, 2500));

// The rehab card: tick it, and the load logs with it.
check('rehab card is on Today', await ev(`!!document.getElementById('sec-rehab')`));
check('clinician flag is showing', await ev(`!!document.querySelector('#sec-rehab .medical-notice')`));
check('flag has no dismiss, only a clearing', await ev(`document.querySelectorAll('#sec-rehab .medical-notice button').length === 1`));
await click('[data-act="rehab-toggle"]');
const rehab = await ev(`JSON.stringify(Object.values(JSON.parse(localStorage.getItem('tracker.days')||'{}'))[0]?.rehab||null)`);
check('ticking logs the raises and the load', rehab && JSON.parse(rehab).heelRaisesDone === true, rehab);
check('gauge now has a filled rehab segment', await ev(`document.querySelectorAll('.gauge .seg').length === 7`));

// The morning reading, and what a worse one does.
await click('[data-act="achilles"][data-val="worse"]');
const ach = await ev(`JSON.stringify(Object.values(JSON.parse(localStorage.getItem('tracker.days')||'{}'))[0]?.checkin||null)`);
check('the morning reading is stored', ach && JSON.parse(ach).achilles === 'worse', ach);
check('a worse morning shows the pull-back order', await ev(`document.querySelectorAll('#sec-rehab .pull-order li').length >= 3`));
check('and the hike is named first', await ev(`/hike/i.test(document.querySelector('#sec-rehab .pull-order li')?.textContent||'')`));
check('at bodyweight the rehab is not cut further', await ev(`/already at bodyweight/i.test(document.getElementById('sec-rehab').textContent)`));

// With a load on record, the pull-back names the number it comes down to.
await ev(`(() => {
  const days = JSON.parse(localStorage.getItem('tracker.days')||'{}');
  const t = Object.keys(days)[0];
  const y = new Date(t); y.setDate(y.getDate() - 1);
  const p = n => String(n).padStart(2,'0');
  const iso = y.getFullYear()+'-'+p(y.getMonth()+1)+'-'+p(y.getDate());
  days[iso] = { date: iso, schemaVersion: 2, planVersion: 6, meals: {}, modifiers: {}, rehab: { heelRaisesDone: true, loadUsed: 20 } };
  localStorage.setItem('tracker.days', JSON.stringify(days));
  location.reload();
})()`);
await new Promise((r) => setTimeout(r, 2500));
check('a loaded rehab comes down a step after a worse morning', await ev(`/15 lb, down from 20 lb/.test(document.getElementById('sec-rehab').textContent)`));

// Clearing the flag is a record, not a dismissal.
await click('#sec-rehab .notice-action');
check('cleared flag is recorded with its date', await ev(`!!JSON.parse(localStorage.getItem('tracker.meta')||'{}').achillesClinicianCleared`));
check('and the notice comes down', await ev(`!document.querySelector('#sec-rehab .medical-notice')`));

// Dark urine still stops everything.
await click('[data-act="symptom"][data-val="Dark urine"]');
check('dark urine raises the medical notice', await ev(`/Contact your doctor today/.test(document.getElementById('sec-checkin').textContent)`));
check('and it carries no dismiss control', await ev(`document.querySelectorAll('#sec-checkin .medical-notice button').length === 0`));

// Export: the whole set of files, and the record that it happened.
const exported = await ev(`(async () => {
  const names = [];
  const realCreate = document.createElement.bind(document);
  document.createElement = (t) => { const e = realCreate(t); if (t === 'a') { Object.defineProperty(e, 'click', { value: () => names.push(e.download) }); } return e; };
  navigator.canShare = () => false;
  document.querySelector('[data-sheet="settings"]').click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('[data-act="export"]').click();
  await new Promise(r => setTimeout(r, 600));
  document.createElement = realCreate;
  return names.join(',');
})()`);
check('export writes every backup file', /days-.*workouts-.*measurements-.*clinician-.*plan-/.test(exported), exported);
check('and records that it happened', await ev(`!!JSON.parse(localStorage.getItem('tracker.meta')||'{}').lastExport`));

for (const r of ok) console.log(`${r.c ? 'PASS' : 'FAIL'}: ${r.n}${r.d ? ' — ' + r.d : ''}`);
const failed = ok.filter((r) => !r.c).length;
console.log(`\n${ok.length - failed} passed, ${failed} failed`);
ws.close();
process.exit(failed ? 1 : 0);
