// Browser-level tests for the Sunday measurement: that resting heart rate and
// grip are no longer collected anywhere, that blood pressure still saves, and
// that measurements already on the record from before they were dropped still
// render with their names. Removing a measurement ends the tracking; it does
// not delete what was recorded.
//
// Run:
//   python3 -m http.server 8777 &
//   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new \
//      --remote-debugging-port=9333 --user-data-dir=/tmp/tracker-cdp about:blank &
//   node tests/measurements.browser.mjs
//
// The clock is pinned to a Sunday, which is the only day the prompt appears.
const base='http://127.0.0.1:9333';
const list=await(await fetch(`${base}/json/list`)).json();
const page=list.find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
await new Promise(r=>(ws.onopen=r));
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
  if(r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description||'err');
  return r.result?.result?.value;};
await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
await send('Network.setBypassServiceWorker',{bypass:true});
await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
  const Real=Date;const fixed=new Real('2026-09-20T19:00:00');
  const D=function(...a){return a.length?new Real(...a):new Real(fixed);};
  D.now=()=>fixed.getTime();D.parse=Real.parse;D.UTC=Real.UTC;D.prototype=Real.prototype;window.Date=D;})();`});
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await send('Page.navigate',{url:'http://localhost:8777/index.html'});
await new Promise(r=>setTimeout(r,2600));
await ev(`localStorage.clear(); location.reload();`);
await new Promise(r=>setTimeout(r,2600));
const ok=[];const check=(n,c,d='')=>ok.push({n,c:!!c,d});
check('Sunday prompt appears', await ev(`/Sunday measurement/.test(document.body.textContent)`));
check('and offers only blood pressure', await ev(`!/Resting|Grip/i.test(document.getElementById('view-today').textContent)`));
await ev(`document.querySelector('[data-sheet="measurements"]').click()`);
await new Promise(r=>setTimeout(r,500));
check('sheet has no RHR field', await ev(`!document.getElementById('sh-rhr')`));
check('sheet has no grip field', await ev(`!document.getElementById('sh-grip')`));
check('sheet keeps systolic and diastolic', await ev(`!!document.getElementById('sh-sys') && !!document.getElementById('sh-dia')`));
await ev(`document.getElementById('sh-sys').value='124';document.getElementById('sh-dia').value='79';
  document.querySelector('.sheet .btn.primary').click();`);
await new Promise(r=>setTimeout(r,600));
const m=await ev(`localStorage.getItem('tracker.measurements')`);
check('blood pressure saves', /"kind":"bloodPressure"/.test(m)&&/124/.test(m)&&/79/.test(m), m);
check('nothing else was written', !/restingHr|grip/.test(m), m);
check('the prompt clears once measured', await ev(`!/Sunday measurement/.test(document.getElementById('view-today').textContent)`));
// A record that already holds the removed kinds still renders with a name.
await ev(`localStorage.setItem('tracker.measurements', JSON.stringify([
  {id:'old-r', takenAt:'2026-09-01T08:00:00', kind:'restingHr', value:63, schemaVersion:1},
  {id:'old-g', takenAt:'2026-09-01T08:00:00', kind:'grip', value:140, schemaVersion:1}]));
  location.reload();`);
await new Promise(r=>setTimeout(r,2600));
await ev(`document.getElementById('tab-ref').click()`);
await new Promise(r=>setTimeout(r,600));
const ref=await ev(`document.getElementById('view-ref').textContent`);
check('historical resting HR still renders with its name', /Resting HR, bpm/.test(ref));
check('historical grip still renders with its name', /Grip, lb/.test(ref));
for(const r of ok) console.log(`${r.c?'PASS':'FAIL'}: ${r.n}${r.d?' — '+r.d:''}`);
const failed=ok.filter(r=>!r.c).length;
console.log(`\n${ok.length-failed} passed, ${failed} failed`);
ws.close();process.exit(failed?1:0);
