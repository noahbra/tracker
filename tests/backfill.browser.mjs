// Browser-level test for the backfill flow: proves a day logged while viewing a
// past date is written to THAT date, which no pure-logic test can show.
//
// Run:
//   python3 -m http.server 8777 &
//   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless \
//      --remote-debugging-port=9333 --user-data-dir=/tmp/tracker-cdp about:blank &
//   node tests/backfill.browser.mjs
//
// Optional env: TRACKER_URL, CDP_URL. Requires Chrome; logic.test.mjs does not.
// Drive the real app in a real browser: backfill a past day and prove the
// write landed on that date, not today.
const base = process.env.CDP_URL || 'http://127.0.0.1:9333';
const APP = process.env.TRACKER_URL || 'http://localhost:8777/index.html';
const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP });
await new Promise((r) => setTimeout(r, 2500));

const ok = [];
const check = (name, cond, detail = '') => ok.push({ name, pass: !!cond, detail });

// Start clean, on today.
await evalJs(`localStorage.clear(); location.reload();`);
await new Promise((r) => setTimeout(r, 2500));

const today = await evalJs(`document.querySelector('.date-nav h1').textContent`);
check('opens on today', !!today, today);
const nextDisabled = await evalJs(`document.querySelector('[data-act="day-next"]').disabled`);
check('cannot step into the future', nextDisabled === true);

// Step back one day.
await evalJs(`document.querySelector('[data-act="day-prev"]').click()`);
await new Promise((r) => setTimeout(r, 400));
const prevDay = await evalJs(`document.querySelector('.date-nav h1').textContent`);
check('steps back to a past day', prevDay !== today, `${today} -> ${prevDay}`);
const flag = await evalJs(`!!document.querySelector('.backfill-flag')`);
check('shows the backfilling flag', flag);

// Log a weight while viewing the past day.
await evalJs(`document.querySelector('[data-sheet="weight"]').click()`);
await new Promise((r) => setTimeout(r, 300));
await evalJs(`document.getElementById('sh-weight').value = '212.5';
  document.querySelector('.sheet .btn.primary').click();`);
await new Promise((r) => setTimeout(r, 400));

const days = await evalJs(`JSON.stringify(JSON.parse(localStorage.getItem('tracker.days')||'{}'))`);
const parsed = JSON.parse(days);
const dates = Object.keys(parsed).filter((d) => parsed[d].weight != null);
const todayIso = await evalJs(`(()=>{const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());})()`);
check('weight written to exactly one date', dates.length === 1, dates.join(','));
check('written to the VIEWED past day, not today', dates[0] && dates[0] !== todayIso, `wrote ${dates[0]}, today is ${todayIso}`);
check('weight value stored', parsed[dates[0]]?.weight === 212.5, String(parsed[dates[0]]?.weight));

// Back to today, then confirm today is still empty.
await evalJs(`document.querySelector('[data-act="day-today"]').click()`);
await new Promise((r) => setTimeout(r, 400));
const backToday = await evalJs(`document.querySelector('.date-nav h1').textContent`);
check('returns to today', backToday === today, backToday);
check('today untouched by the backfill', !parsed[todayIso] || parsed[todayIso].weight == null);

// A logged workout must stay reachable even on a day the calendar does not
// offer a lift (phase override, or a substitution that stopped applying once
// another day was filled in). Branching the training card only on what is
// offered stranded the record on disk with no way to open it.
await evalJs(`
  const t = (()=>{const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());})();
  localStorage.clear();
  localStorage.setItem('tracker.days', JSON.stringify({[t]:{
    date:t, schemaVersion:1, planVersion:4, meals:{}, modifiers:{},
    workout:{ sessionId:'liftA', sets:{'trapbar:0':{weight:185,reps:5}}, minutes:50, completedAt: t+'T12:00:00' }
  }}));
  location.reload();
`);
await new Promise((r) => setTimeout(r, 2500));
const offersLift = await evalJs(`(document.getElementById('sec-training')||{}).textContent?.includes('Lift')`);
const wayIn = await evalJs(`!!document.querySelector('[data-act="open-logger"]')`);
check('logged workout is reachable on a non-lift day', wayIn === true);
check('and the card names the session', offersLift === true);
// Guarded: when this regresses there is no button, and the test must report a
// failure rather than throwing before it prints any results.
await evalJs(`(()=>{const b=document.querySelector('[data-act="open-logger"]'); if(b) b.click(); return !!b;})()`);
await new Promise((r) => setTimeout(r, 600));
const reopened = await evalJs(`!!document.querySelector('.logger')`);
const keptSet = await evalJs(`document.querySelectorAll('.logger .set-row.compact').length`);
check('it opens the logger', reopened === true);
check('with the logged set intact', keptSet >= 1, `${keptSet} compact rows`);

for (const r of ok) console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const failed = ok.filter((r) => !r.pass).length;
console.log(`\n${ok.length - failed} passed, ${failed} failed`);
ws.close();
process.exit(failed ? 1 : 0);
