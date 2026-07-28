// UI layer. All business logic lives in logic.js; this file renders state and
// writes user input to localStorage. Autosave on every change (§7.1).

import * as L from './logic.js';

// ---------- store ----------

const DEMO = new URLSearchParams(location.search).has('demo');
const KEYS = { days: 'tracker.days', measurements: 'tracker.measurements', meta: 'tracker.meta' };

// schemaVersion migrations, applied in order at load (§6.3). v1 is current.
const MIGRATIONS = [
  // { to: 2, day(rec) { ... return rec; }, measurement(m) { ... return m; } },
];

function migrate(records, measurements, meta) {
  let v = meta.schemaVersion || L.SCHEMA_VERSION;
  for (const m of MIGRATIONS) {
    if (m.to <= v) continue;
    for (const key of Object.keys(records)) records[key] = m.day ? m.day(records[key]) : records[key];
    for (let i = 0; i < measurements.length; i++) measurements[i] = m.measurement ? m.measurement(measurements[i]) : measurements[i];
    v = m.to;
  }
  meta.schemaVersion = v;
  return { records, measurements, meta };
}

function loadStore() {
  try {
    const records = JSON.parse(localStorage.getItem(KEYS.days) || '{}');
    const measurements = JSON.parse(localStorage.getItem(KEYS.measurements) || '[]');
    const meta = JSON.parse(localStorage.getItem(KEYS.meta) || '{}');
    return migrate(records, measurements, meta);
  } catch (e) {
    console.error('store load failed', e);
    return { records: {}, measurements: [], meta: { schemaVersion: L.SCHEMA_VERSION } };
  }
}

function save() {
  if (DEMO) return;
  localStorage.setItem(KEYS.days, JSON.stringify(state.records));
  localStorage.setItem(KEYS.measurements, JSON.stringify(state.measurements));
  localStorage.setItem(KEYS.meta, JSON.stringify(state.meta));
}

// ---------- state ----------

const state = {
  configDoc: null,
  records: {},
  measurements: [],
  meta: { schemaVersion: L.SCHEMA_VERSION },
  tab: ['week', 'ref'].includes(new URLSearchParams(location.search).get('tab'))
    ? new URLSearchParams(location.search).get('tab')
    : 'today',
  sheet: null,          // { kind, ... }
  logger: null,         // { sessionId }
  editingSet: null,     // 'exId:idx' currently in input mode
  viewDate: null,       // null = today; otherwise the past day being filled in
};

function todayStr() { return L.fmtDate(new Date()); }

// The day every screen and every write is about. Backfilling a missed day is
// the same app pointed at a different date, not a separate mode.
function viewStr() { return state.viewDate || todayStr(); }
function isToday() { return viewStr() === todayStr(); }

function nowHour() { return new Date().getHours(); }
function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${L.fmtDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Time-of-day drives the NEXT bar and completion stamps. On a past day the
// clock is meaningless: treat it as fully elapsed and stamp midday, so a
// backfilled session never claims to have happened at tonight's time.
function viewHour() { return isToday() ? nowHour() : 23; }
function stampIso() { return isToday() ? nowIso() : `${viewStr()}T12:00:00`; }

function activeConfig() { return L.configFor(state.configDoc, viewStr()); }

function getRec(date = viewStr()) {
  if (!state.records[date]) {
    state.records[date] = {
      date,
      schemaVersion: state.meta.schemaVersion,
      planVersion: L.configFor(state.configDoc, date).planVersion,
      meals: {},
      modifiers: {},
    };
  }
  return state.records[date];
}

function mutate(fn) {
  fn();
  save();
  render();
}

// ---------- utilities ----------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtInt(n) { return n == null ? null : Math.round(n).toLocaleString('en-US'); }
function fmtSleep(min) {
  if (min == null) return null;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
function fmtSlope(s) {
  if (s == null) return '—';
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(2)}`;
}
const EMDASH = '—';

// ---------- demo data (?demo — in-memory only, nothing persisted) ----------

function demoData() {
  const records = {};
  const start = '2026-07-13';
  const weights = [221.2, 220.6, 220.9, 220.1, 219.8, 220.3, 219.4, 219.6, 218.9, 219.2, 218.4, 218.7, 218.0, 218.3, 217.6, 217.9, 217.2, 217.4];
  for (let i = 0; i < weights.length; i++) {
    const d = L.addDays(start, i);
    if (d > todayStr()) break;
    const r = {
      date: d, schemaVersion: 1, planVersion: 3,
      weight: weights[i],
      sleepMinutes: 420 + (i * 7) % 60,
      steps: 5200 + (i * 731) % 4500,
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: i % 5 === 3 ? 'skipped' : 'eaten', dinner: 'eaten', dessert: i % 4 === 2 ? 'modified' : 'eaten' },
      modifiers: {},
      checkin: { energy: 1 + (i % 2), hunger: 1, soreness: i % 3 === 0 ? 1 : 2, stress: 1, symptom: i === 9 ? 'Mild soreness' : 'None' },
    };
    const plan = L.dayPlan(state.configDoc, d);
    if (plan.type === 'lift' && !plan.suppressed && i !== weights.length - 1) {
      const sessionId = L.nextLiftId(records);
      const exs = L.configFor(state.configDoc, d).sessions[sessionId].exercises;
      const sets = {};
      const base = { trapbar: 185, bench: 135, csrow: 90, facepull: 40, farmer: 70, squat: 155, ohp: 85, chinup: 0, rdl: 135, suitcase: 60 };
      for (const ex of exs) {
        for (let s = 0; s < ex.sets; s++) sets[`${ex.id}:${s}`] = { weight: base[ex.id] + Math.floor(i / 7) * 5, reps: ex.reps };
      }
      r.workout = { sessionId, sets, minutes: 52 + (i % 3) * 3, completedAt: `${d}T07:40:00` };
    } else if ((plan.type === 'cardio' || plan.type === 'walk') && !plan.suppressed && i % 7 !== 5) {
      r.cardio = { mode: plan.schedule.mode || 'walk', minutes: plan.schedule.minutes || 40, avgHr: plan.schedule.mode === 'zone2' ? 116 : undefined, completedAt: `${d}T18:10:00` };
    }
    records[d] = r;
  }
  // today: partial — weight logged, breakfast eaten, rest open
  const t = todayStr();
  records[t] = {
    date: t, schemaVersion: 1, planVersion: 3,
    weight: 217.4, sleepMinutes: 462, steps: 5832,
    meals: { breakfast: 'eaten' }, modifiers: {},
  };
  const measurements = [
    { id: 'demo-w1', takenAt: '2026-07-13T07:00:00', kind: 'waist', value: 42.0, schemaVersion: 1 },
    { id: 'demo-r1', takenAt: '2026-07-19T08:00:00', kind: 'restingHr', value: 63, schemaVersion: 1 },
  ];
  return { records, measurements };
}

// ---------- trend plot (§7.4) ----------

function trendPlotSvg(records, endDate, { width = 420, height = 120 } = {}) {
  const series = L.trendSeries(records, endDate, 21);
  const withWeight = series.filter((p) => p.weight != null);
  if (withWeight.length < 3) {
    return `<div class="empty-plot-msg">Log 3–4 mornings and the trend line appears here.</div>`;
  }
  const padL = 6, padR = 6, padT = 10, padB = 16;
  const vals = series.flatMap((p) => [p.weight, p.avg]).filter((v) => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  let range = hi - lo;
  if (range < 0.8) { const mid = (hi + lo) / 2; lo = mid - 0.4; hi = mid + 0.4; range = 0.8; }
  lo -= range * 0.25; hi += range * 0.25;
  const x = (i) => padL + (i / (series.length - 1)) * (width - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);

  let out = `<svg class="weight-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="21-day weight trend">`;
  // baseline + per-day ticks, Mondays longer
  const baseY = height - padB + 4;
  out += `<line x1="${padL}" y1="${baseY}" x2="${width - padR}" y2="${baseY}" stroke="#C7CCBF" stroke-width="1"/>`;
  series.forEach((p, i) => {
    const isMon = L.parseDate(p.date).getDay() === 1;
    out += `<line x1="${x(i)}" y1="${baseY}" x2="${x(i)}" y2="${baseY + (isMon ? 8 : 4)}" stroke="#C7CCBF" stroke-width="1"/>`;
  });
  // raw dots
  series.forEach((p, i) => {
    if (p.weight != null) out += `<circle cx="${x(i)}" cy="${y(p.weight)}" r="1.7" fill="#AAB2A2"/>`;
  });
  // rolling average line — the only curve in the app
  const avgPts = series.map((p, i) => (p.avg != null && p.weight != null ? [x(i), y(p.avg)] : null)).filter(Boolean);
  if (avgPts.length >= 2) {
    out += `<polyline points="${avgPts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#2E5D43" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if (avgPts.length) {
    const last = avgPts[avgPts.length - 1];
    out += `<circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="#2E5D43"/>`;
  }
  out += '</svg>';
  return out;
}

// ---------- Today tab ----------

function sessionName(offered) {
  const config = activeConfig();
  if (offered.kind === 'lift') return config.sessions[offered.sessionId].name;
  if (offered.kind === 'walk') return 'Walk';
  return offered.mode === 'intervals' ? 'Intervals' : 'Zone 2';
}

function renderToday() {
  const t = viewStr();
  const rec = state.records[t] || { meals: {}, modifiers: {}, date: t, planVersion: activeConfig().planVersion };
  const config = activeConfig();
  const plan = L.dayPlan(state.configDoc, t);
  const offered = L.offeredSession(state.configDoc, state.records, t);
  const gauge = L.dayGauge(state.configDoc, state.records, t);
  const next = L.nextAction(state.configDoc, state.records, state.measurements, t, viewHour(), exportStale(t));
  const nut = L.dayNutrition(state.configDoc, rec.date ? rec : { ...rec, date: t });
  const avg = L.rollingAverage(state.records, t);
  const slope = L.trendSlope(state.records, t);
  const day = L.programDay(state.configDoc, t);
  const week = L.programWeek(state.configDoc, t);

  const dateHead = L.parseDate(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const toGo = avg != null ? Math.max(0, avg - config.targets.weightGoal) : null;
  const canPrev = L.addDays(t, -1) >= L.programStart(state.configDoc);
  const canNext = t < todayStr();

  let html = '';
  if (DEMO) html += `<div class="demo-banner">Demo data — nothing is saved</div>`;

  // header — Settings is a small header control, not a third tab (§4)
  html += `<header class="header">
    <div class="header-row">
      <div class="date-nav">
        <button class="daystep" data-act="day-prev"${canPrev ? '' : ' disabled'} aria-label="Previous day">‹</button>
        <h1>${esc(dateHead)}</h1>
        <button class="daystep" data-act="day-next"${canNext ? '' : ' disabled'} aria-label="Next day">›</button>
      </div>
      <button class="settings-link" data-act="sheet" data-sheet="settings">Settings</button>
    </div>
    <div class="sub num">Day ${day} · Week ${week} · ${toGo != null ? toGo.toFixed(1) : EMDASH} lb to go</div>
    ${isToday() ? '' : `<button class="backfill-flag" data-act="day-today">Filling in a past day ${EMDASH} back to today</button>`}
    <div class="gauge" role="img" aria-label="${gauge.filter((g) => g.done).length} of 6 logged">
      ${gauge.map((g) => `<div class="seg${g.done ? ' done' : ''}" title="${g.label}"></div>`).join('')}
    </div>
  </header>`;

  // NEXT bar (sticky)
  html += `<button class="nextbar${next.id === 'done' ? ' alldone' : ''}" data-act="next" data-next="${next.id}">
    <span class="label">Next</span>
    <span class="action">${esc(next.id === 'done' ? `${EMDASH} Nothing. Day's logged.` : next.label)}</span>
  </button>`;

  // focus card
  const stepsLeft = plan.stepTarget - (rec.steps || 0);
  const focusLines = [];
  if (offered.kind !== 'rest' && !plan.suppressed) {
    let nm = sessionName(offered);
    if (offered.kind === 'cardio' || offered.kind === 'walk') nm += ` ${offered.minutes} min`;
    focusLines.push(`${EMDASH} ${esc(nm)}${offered.pushedFrom ? ` <span class="num">(pushed from ${offered.pushedFrom})</span>` : ''}`);
  }
  focusLines.push(`${EMDASH} Eat <span class="num">${fmtInt(plan.calorieTarget)}</span> cal · <span class="num">${plan.proteinFloor}</span> g protein`);
  if (rec.steps == null) focusLines.push(`${EMDASH} Walk <span class="num">${fmtInt(plan.stepTarget)}</span> steps`);
  else if (stepsLeft > 0) focusLines.push(`${EMDASH} Walk <span class="num">${fmtInt(stepsLeft)}</span> more steps`);
  html += `<section class="card focus" id="sec-focus">
    <span class="label">Today's focus</span>
    ${focusLines.map((l) => `<div class="line">${l}</div>`).join('')}
  </section>`;

  // weight card
  html += `<section id="sec-weight">`;
  if (rec.weight == null) {
    html += `<button class="prompt" data-act="sheet" data-sheet="weight">
      <span class="title">Weigh in</span>
      <span class="sub">${lastWeightSub()}</span>
    </button>`;
  } else {
    html += `<section class="card">
      <div class="weight-top">
        <div class="weight-avg num">${avg != null ? avg.toFixed(1) : EMDASH}</div>
        <div class="weight-slope num${slope != null && slope < -0.15 ? ' good' : ''}">${fmtSlope(slope)}</div>
      </div>
      <div class="weight-labels"><span class="label">7-day average</span><span class="label">lb / week</span></div>
      ${trendPlotSvg(state.records, t)}
      <div class="weight-caption">This morning <span class="num">${rec.weight.toFixed(1)}</span> lb · single readings are noise, the line is the signal
        <button class="meal-change" data-act="sheet" data-sheet="weight">Edit</button></div>
      ${weekThreeHtml(t)}
    </section>`;
  }
  html += `</section>`;

  // waist — conditional (§7.5)
  if (L.waistDue(state.configDoc, state.measurements, t)) {
    html += `<button class="prompt" id="sec-waist" data-act="sheet" data-sheet="waist">
      <span class="title">Measure waist</span>
      <span class="sub">At the navel, morning, before eating.</span>
    </button>`;
  }

  // metric tiles
  const sleepPct = rec.sleepMinutes != null ? Math.min(1, rec.sleepMinutes / plan.sleepTargetMinutes) : 0;
  const stepPct = Math.min(1, (rec.steps || 0) / plan.stepTarget);
  const calPct = Math.min(1, nut.cal / plan.calorieTarget);
  const proPct = Math.min(1, nut.protein / plan.proteinFloor);
  html += `<div class="tiles" id="sec-tiles">
    <button class="tile" data-act="sheet" data-sheet="steps">
      <span class="label">Steps</span>
      <div class="value num${rec.steps == null ? ' empty' : ''}">${rec.steps != null ? fmtInt(rec.steps) : EMDASH}</div>
      <div class="of num">of ${fmtInt(plan.stepTarget)}</div>
      <div class="bar"><div class="fill" style="width:${(stepPct * 100).toFixed(1)}%"></div></div>
    </button>
    <button class="tile" data-act="sheet" data-sheet="sleep">
      <span class="label">Sleep</span>
      <div class="value num${rec.sleepMinutes == null ? ' empty' : ''}">${rec.sleepMinutes != null ? fmtSleep(rec.sleepMinutes) : EMDASH}</div>
      <div class="of num">of ${fmtSleep(plan.sleepTargetMinutes)}</div>
      <div class="bar"><div class="fill" style="width:${(sleepPct * 100).toFixed(1)}%"></div></div>
    </button>
    <div class="tile">
      <span class="label">Calories</span>
      <div class="value num">${fmtInt(nut.cal)}</div>
      <div class="of num">of ${fmtInt(plan.calorieTarget)}</div>
      <div class="bar"><div class="fill" style="width:${(calPct * 100).toFixed(1)}%"></div></div>
    </div>
    <div class="tile">
      <span class="label">Protein</span>
      <div class="value num">${fmtInt(nut.protein)} g</div>
      <div class="of num">of ${plan.proteinFloor} g</div>
      <div class="bar"><div class="fill" style="width:${(proPct * 100).toFixed(1)}%"></div></div>
    </div>
  </div>`;

  // training
  html += renderTraining(rec, plan, offered);

  // meals
  html += renderMeals(rec, plan, config);

  // Sunday measurements prompt (§7.12)
  if (L.weekday(t) === 0 && state.meta.measurementsDismissed !== L.weekStart(t) && !measuredThisWeek(t)) {
    html += `<button class="prompt" data-act="sheet" data-sheet="measurements">
      <span class="title">Sunday measurements</span>
      <span class="sub">Resting HR, blood pressure, grip. Each skippable.</span>
    </button>`;
  }

  // check-in
  html += renderCheckin(rec);

  document.getElementById('view-today').innerHTML = html;
}

function lastWeightSub() {
  const t = viewStr();
  for (let i = 1; i <= 30; i++) {
    const r = state.records[L.addDays(t, -i)];
    if (r && r.weight != null) return `Last recorded ${r.weight.toFixed(1)} lb`;
  }
  return 'First weigh-in';
}

// Backup overdue: data exists and the last export is >4 weeks old or absent.
function exportStale(t) {
  const hasData = Object.values(state.records).some((r) => r.weight != null || r.workout || Object.keys(r.meals || {}).length);
  const last = state.meta.lastExport;
  return hasData && (!last || L.daysBetween(last, t) > 28);
}

function weekThreeHtml(t) {
  const note = L.weekThreeNote(state.configDoc, state.records, t);
  return note ? `<div class="weight-note">${esc(note)}</div>` : '';
}

function measuredThisWeek(t) {
  const ws = L.weekStart(t);
  return state.measurements.some((m) => m.kind === 'restingHr' && m.takenAt.slice(0, 10) >= ws);
}

// ---------- training section ----------

// A day's logged lift, with the way back into it. Rendered whenever a workout
// exists on the record — see the orphan note in renderTraining.
function liftCard(rec, config, idAttr) {
  const session = config.sessions[rec.workout.sessionId];
  if (!session) return '';
  const { progressed, allHit } = workoutSummary(rec, session);
  const done = !!rec.workout.completedAt;
  return `<section class="card training-done"${idAttr}>
    <span class="label">Training ${EMDASH} ${esc(session.name)} ${done ? 'complete' : 'in progress'}</span>
    <div class="training-stats">
      <div class="stat"><span class="num">${progressed}</span><span class="label">Exercises progressed</span></div>
      <div class="stat"><span class="num">${allHit ? 'Yes' : 'No'}</span><span class="label">All prescribed reps</span></div>
      <div class="stat"><span class="num">${rec.workout.minutes != null ? rec.workout.minutes : EMDASH}</span><span class="label">Minutes</span></div>
    </div>
    <button class="reopen" data-act="open-logger">Reopen logger</button>
  </section>`;
}

function renderTraining(rec, plan, offered) {
  const config = activeConfig();
  let inner = '';

  // A logged workout must always be reachable, even when the calendar for that
  // day does not offer a lift — a phase override, or a Tuesday substitution
  // that stopped applying once Monday got filled in. Branching only on what is
  // offered stranded the record on disk with no way to open it.
  const hasWorkout = !!(rec.workout && (rec.workout.completedAt || Object.keys(rec.workout.sets || {}).length));
  const orphan = hasWorkout && offered.kind !== 'lift';
  const secId = orphan ? '' : ' id="sec-training"';

  if (plan.suppressed) {
    inner = `<section class="card"${secId}><span class="label">Training</span>
      <div class="rest-copy">Rest day this phase${plan.phase && plan.phase.note ? ` · ${esc(plan.phase.note.toLowerCase())}` : ''}.</div></section>`;
  } else if (offered.kind === 'rest') {
    inner = `<section class="card"${secId}><span class="label">Training</span>
      <div class="rest-copy">Rest day. Walk if you feel like it.</div></section>`;
  } else if (offered.kind === 'lift') {
    const done = rec.workout && rec.workout.completedAt;
    if (!done) {
      const session = config.sessions[offered.sessionId];
      inner = `<button class="prompt"${secId} data-act="open-logger">
        <span class="title">Start ${esc(session.name)}</span>
        <span class="sub">${offered.pushedFrom ? `Pushed from ${offered.pushedFrom}` : `${session.exercises.length} exercises · about 55 min`}</span>
      </button>`;
    } else {
      inner = liftCard(rec, config, secId);
    }
  } else {
    // cardio / walk
    const done = rec.cardio && rec.cardio.completedAt;
    if (!done) {
      const nm = sessionName(offered);
      const subParts = [];
      if (offered.prescription) subParts.push(offered.prescription);
      else subParts.push(`${offered.minutes} min${offered.optional ? ' · optional' : ''}`);
      if (offered.mode === 'zone2') {
        subParts.push(`HR ${config.targets.zone2HrRange[0]}–${config.targets.zone2HrRange[1]}`);
        if (config.zone2Guidance) subParts.push(config.zone2Guidance);
      }
      inner = `<button class="prompt"${secId} data-act="sheet" data-sheet="cardio">
        <span class="title">Log ${esc(nm)}</span>
        <span class="sub">${esc(subParts.join(' · '))}</span>
      </button>`;
    } else {
      inner = `<section class="card training-done"${secId}>
        <span class="label">Training ${EMDASH} ${esc(sessionName(offered))} complete</span>
        <div class="training-stats">
          <div class="stat"><span class="num">${rec.cardio.minutes}</span><span class="label">Minutes</span></div>
          <div class="stat"><span class="num">${rec.cardio.avgHr != null ? rec.cardio.avgHr : EMDASH}</span><span class="label">Avg HR</span></div>
        </div>
        <button class="reopen" data-act="sheet" data-sheet="cardio">Edit</button>
      </section>`;
    }
  }
  // Orphaned lift leads, so the thing that actually happened is what you see
  // first; the day's scheduled session still follows it.
  return orphan ? liftCard(rec, config, ' id="sec-training"') + inner : inner;
}

function workoutSummary(rec, session) {
  // progressed: exercises whose max load today exceeds max load last time.
  const prior = { ...state.records };
  delete prior[rec.date];
  let progressed = 0;
  let allHit = true;
  for (const ex of session.exercises) {
    let todayMax = null;
    let logged = 0;
    for (let i = 0; i < ex.sets; i++) {
      const s = rec.workout.sets[`${ex.id}:${i}`];
      if (s) {
        logged++;
        todayMax = todayMax == null ? s.weight : Math.max(todayMax, s.weight);
        if (s.reps < ex.reps) allHit = false;
      }
    }
    if (logged < ex.sets) allHit = false;
    const hist = L.exerciseHistory(prior, ex.id);
    if (todayMax != null && hist.length) {
      const prevMax = Math.max(...hist[hist.length - 1].logged.map((s) => s.weight));
      if (todayMax > prevMax) progressed++;
    }
  }
  return { progressed, allHit };
}

// ---------- meals section ----------

function renderMeals(rec, plan, config) {
  let rows = '';
  for (const meal of config.meals) {
    const st = rec.meals[meal.id];
    const total = L.mealTotal(meal);
    let sub;
    if (st === 'eaten' || st === 'modified' || st === 'offplan') {
      const tag = st === 'modified' ? ' · similar' : st === 'offplan' ? ' · off-plan' : '';
      sub = `<div class="meal-sub macro num">${total.cal} cal · ${total.protein} g protein${tag}</div>`;
    } else if (st === 'skipped') {
      sub = `<div class="meal-sub">Skipped</div>`;
    } else {
      sub = `<div class="meal-sub">${esc(meal.components.slice(0, 2).map((c) => c.name).join(' · '))}</div>`;
    }
    rows += `<div class="meal-row">
      <button class="meal-check ${st || ''}" data-act="meal-toggle" data-meal="${meal.id}" aria-label="${esc(meal.name)}: ${st || 'not logged'}"></button>
      <button class="meal-main" data-act="meal-toggle" data-meal="${meal.id}">
        <span class="meal-name">${esc(meal.name)}</span>${sub}
      </button>
      <button class="meal-change" data-act="sheet" data-sheet="meal" data-meal="${meal.id}">Change</button>
    </div>`;
  }

  // optional modifiers for the day type (§7.8)
  let mods = '';
  for (const modId of plan.mealModifiers) {
    const mod = config.mealModifiers.find((m) => m.id === modId);
    if (!mod) continue;
    if (mod.optional) {
      const on = !!rec.modifiers[mod.id];
      mods += `<button class="modifier-row${on ? ' on' : ''}" data-act="mod-toggle" data-mod="${mod.id}">
        <span class="box"></span>
        <span class="mlabel">+ ${esc(mod.label)}, <span class="num">${mod.cal}</span> cal</span>
      </button>`;
    } else {
      mods += `<div class="modifier-row"><span class="mlabel">${esc(mod.label)} (<span class="num">${mod.cal}</span> cal) ${EMDASH} applied automatically</span></div>`;
    }
  }

  return `<section class="card" id="sec-meals"><span class="label">Meals</span>${rows}${mods}</section>`;
}

// ---------- check-in section (§7.9) ----------

const CHECKIN_ROWS = [
  { key: 'energy', label: 'Energy', opts: ['Low', 'OK', 'Good'] },
  { key: 'hunger', label: 'Hunger', opts: ['High', 'Normal', 'Low'] },
  { key: 'soreness', label: 'Soreness', opts: ['Heavy', 'Mild', 'None'] },
  { key: 'stress', label: 'Stress', opts: ['High', 'Some', 'Low'] },
];
const SYMPTOMS = ['None', 'Mild soreness', 'Weakness', 'Muscle pain', 'Dark urine'];
const ALERT_SYMPTOMS = ['Weakness', 'Muscle pain', 'Dark urine'];

function renderCheckin(rec) {
  const c = rec.checkin || {};
  let html = `<section class="card checkin" id="sec-checkin"><span class="label">Evening check-in</span>`;
  for (const row of CHECKIN_ROWS) {
    html += `<div class="chip-row"><span class="label">${row.label}</span><div class="chips">
      ${row.opts.map((o, i) => `<button class="chip${c[row.key] === i ? ' sel' : ''}" data-act="chip" data-key="${row.key}" data-val="${i}">${o}</button>`).join('')}
    </div></div>`;
  }
  html += `<hr class="rule">`;
  html += `<div class="chip-row"><span class="label">Muscle symptoms</span><div class="chips">
    ${SYMPTOMS.map((s) => `<button class="chip${c.symptom === s ? ' sel' : ''}${ALERT_SYMPTOMS.includes(s) ? ' alert-chip' : ''}" data-act="symptom" data-val="${esc(s)}">${s}</button>`).join('')}
  </div></div>`;

  if (c.symptom === 'Weakness' || c.symptom === 'Muscle pain') {
    html += `<div class="followup"><span class="label">Did it interfere with training?</span><div class="chips" style="margin-top:6px">
      ${['No', 'Somewhat', 'Yes'].map((o) => `<button class="chip${c.interfered === o ? ' sel alert-chip' : ''}" data-act="interfered" data-val="${o}">${o}</button>`).join('')}
    </div></div>`;
  }
  if (c.symptom === 'Dark urine') {
    // Hard-coded escalation — not dismissible, not configurable (§7.9).
    html += `<div class="medical-notice">Contact your doctor today. Don't train until you've spoken to them.</div>`;
  }
  html += `</section>`;
  return html;
}

// ---------- This week tab (§7.11) ----------

function renderWeek() {
  const t = viewStr();
  const today = todayStr();
  const stats = L.weekStats(state.configDoc, state.records, t, today);
  const rec7 = L.weeklyRecommendation(state.configDoc, state.records, t, today);
  const sympDays = L.symptomDays(state.records, t);
  const dayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  const weekOf = L.parseDate(L.weekStart(t)).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  let html = `<header class="header"><div class="header-row">
    <h1>Week of ${esc(weekOf)}</h1>
    <button class="settings-link" data-act="sheet" data-sheet="settings">Settings</button>
  </div></header>`;

  // Each day is a way in: tapping one points the Today screen at that date,
  // which is how a missed day gets filled in.
  const progStart = L.programStart(state.configDoc);
  html += `<section class="card"><span class="label">Sessions</span>
    <div class="week-strip">
      ${stats.strip.map((d, i) => {
        const pickable = d.date <= today && d.date >= progStart;
        const cell = d.state === 'done' ? 'done' : d.state === 'off' || d.state === 'blank' ? 'off' : '';
        return `<button class="day${d.date === t ? ' sel' : ''}" data-act="day-pick" data-date="${d.date}"${pickable ? '' : ' disabled'}>
          <div class="cell ${cell}"></div><span class="label">${dayLetters[i]}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="strip-hint">Tap a day to fill it in.</div></section>`;

  html += `<section class="card week-weight"><span class="label">Weight</span>
    <div><span class="big num">${stats.avgNow != null ? stats.avgNow.toFixed(1) : EMDASH}</span>
      <span class="delta num">${stats.weekChange != null ? `${stats.weekChange > 0 ? '+' : '−'}${Math.abs(stats.weekChange).toFixed(1)} vs last week` : 'no prior week'}</span></div>
    <div class="weight-labels" style="margin-top:2px"><span class="label">7-day average</span><span class="label">${fmtSlope(stats.trend)} lb / week</span></div>
    ${trendPlotSvg(state.records, t)}
  </section>`;

  html += `<section class="card"><span class="label">This week</span>
    <div class="metric-grid">
      <div><span class="num">${stats.mealAdherence != null ? Math.round(stats.mealAdherence * 100) + '%' : EMDASH}</span><span class="label">Meal adherence</span></div>
      <div><span class="num">${stats.sessionsDone} / ${stats.sessionsPlanned}</span><span class="label">Sessions</span></div>
      <div><span class="num">${stats.avgSteps != null ? fmtInt(stats.avgSteps) : EMDASH}</span><span class="label">Avg steps</span></div>
      <div><span class="num">${stats.avgSleep != null ? fmtSleep(stats.avgSleep) : EMDASH}</span><span class="label">Avg sleep</span></div>
    </div></section>`;

  html += `<section class="card"><span class="label">Recommendation</span>
    <div class="recommendation">${esc(rec7)}</div>
    ${sympDays.length ? `<div class="rec-symptom">Muscle symptoms logged ${sympDays.length} day${sympDays.length > 1 ? 's' : ''} this week. Worth mentioning at your next appointment.</div>` : ''}
  </section>`;

  // Backup staleness (§6.4): this storage is local-only and iOS can evict it.
  // A manual backup that depends on remembering is not backup.
  if (exportStale(today)) {
    const last = state.meta.lastExport;
    html += `<button class="prompt" data-act="export">
      <span class="title">Export a backup</span>
      <span class="sub">${last ? `Last export ${L.daysBetween(last, today)} days ago` : 'Never exported'} · this data has no cloud copy.</span>
    </button>`;
  }

  document.getElementById('view-week').innerHTML = html;
}

// ---------- Reference tab ----------
// Read-only. Every value here comes from config/plan.json or logged history;
// nothing is hard-coded, so a plan revision updates this page automatically.

const DAY_ORDER = ['1', '2', '3', '4', '5', '6', '0'];
const DAY_FULL = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 0: 'Sunday' };
const MEASURE_LABELS = { waist: 'Waist, in', restingHr: 'Resting HR, bpm', bloodPressure: 'Blood pressure', grip: 'Grip, lb' };

function describeSched(entry, config) {
  if (entry.type === 'lift') return 'Lift — A/B alternating';
  if (entry.type === 'rest') return 'Rest';
  if (entry.type === 'walk') return `Walk · ${entry.minutes} min${entry.optional ? ' · optional' : ''}`;
  if (entry.mode === 'intervals') return `Intervals · ${entry.minutes} min · ${entry.prescription || ''}`;
  const [lo, hi] = config.targets.zone2HrRange;
  return `Zone 2 · ${entry.minutes} min · HR ${lo}–${hi}`;
}

function fmtRefDate(iso) {
  return L.parseDate(iso.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderReference() {
  const t = viewStr();
  const config = activeConfig();
  const tg = config.targets;

  let html = `<header class="header"><div class="header-row">
    <h1>Reference</h1>
    <button class="settings-link" data-act="sheet" data-sheet="settings">Settings</button>
  </div></header>`;

  // ---- plan summary ----
  html += `<section class="card"><span class="label">Plan</span>
    <table class="ref-table">
      <tr><td>Version</td><td class="num">${config.planVersion} · ${esc(config.label || '')}</td></tr>
      <tr><td>Program start</td><td class="num">${fmtRefDate(L.programStart(state.configDoc))}</td></tr>
      <tr><td>Weight</td><td class="num">${tg.weightStart} → ${tg.weightGoal} lb</td></tr>
      <tr><td>Protein floor</td><td class="num">${tg.proteinFloor} g / day</td></tr>
      <tr><td>Steps</td><td class="num">${fmtInt(tg.stepTarget)} / day (ramped in early weeks)</td></tr>
      <tr><td>Sleep</td><td class="num">${fmtSleep(tg.sleepTargetMinutes)}</td></tr>
    </table></section>`;

  // ---- dietary protocol ----
  let mealsHtml = '';
  let grandCal = 0, grandPro = 0;
  for (const meal of config.meals) {
    const total = L.mealTotal(meal);
    grandCal += total.cal; grandPro += total.protein;
    mealsHtml += `<table class="ref-table meal-detail">
      <tr class="ref-head"><th>${esc(meal.name)}</th><th class="num r">${total.cal} cal · ${total.protein} g</th></tr>
      ${meal.components.map((c) => `<tr><td>${esc(c.name)}</td><td class="num r">${c.cal} cal · ${c.protein} g</td></tr>`).join('')}
    </table>`;
  }
  const dtRows = Object.entries(config.dayTypes)
    .map(([k, v]) => `<tr><td>${k[0].toUpperCase() + k.slice(1)} days</td><td class="num r">${fmtInt(v.calorieTarget)} cal</td></tr>`).join('');
  const modRows = (config.mealModifiers || []).map((m) =>
    `<tr><td>${esc(m.label)}${m.optional ? ' (optional, by choice)' : ' (automatic)'}</td><td class="num r">${m.cal > 0 ? '+' : ''}${m.cal} cal</td></tr>`).join('');
  html += `<section class="card"><span class="label">Dietary protocol</span>
    <table class="ref-table">${dtRows}</table>
    ${mealsHtml}
    <table class="ref-table"><tr class="ref-head"><th>Base plan total</th><th class="num r">${fmtInt(grandCal)} cal · ${grandPro} g</th></tr>${modRows}</table>
  </section>`;

  // ---- weekly schedule + phases ----
  const schedRows = DAY_ORDER.map((d) =>
    `<tr><td>${DAY_FULL[d]}</td><td>${esc(describeSched(config.schedule[d] || { type: 'rest' }, config))}</td></tr>`).join('');
  let phasesHtml = '';
  for (const p of config.phases || []) {
    const parts = [];
    if (p.stepTarget) parts.push(`steps ${fmtInt(p.stepTarget)}`);
    for (const [d, o] of Object.entries(p.scheduleOverrides || {})) {
      parts.push(`${DAY_FULL[d]} → ${o.type === 'rest' ? 'rest' : describeSched(o, config).toLowerCase()}`);
    }
    phasesHtml += `<tr><td>Weeks ${p.weeks.join('–')}</td><td>${esc(parts.join(' · '))}${p.note ? `<div class="ref-note">${esc(p.note)}</div>` : ''}</td></tr>`;
  }
  html += `<section class="card"><span class="label">Weekly schedule</span>
    <table class="ref-table">${schedRows}</table>
    ${phasesHtml ? `<span class="label" style="display:block;margin-top:14px">Ramp-in phases</span><table class="ref-table">${phasesHtml}</table>` : ''}
    ${config.zone2Guidance ? `<div class="ref-note" style="margin-top:10px">${esc(config.zone2Guidance)}</div>` : ''}
  </section>`;

  // ---- lift sessions ----
  for (const [, session] of Object.entries(config.sessions)) {
    html += `<section class="card"><span class="label">${esc(session.name)}</span>
      <table class="ref-table">
        ${session.exercises.map((e) => `<tr><td>${esc(e.name)}${e.pair ? '<div class="ref-note">paired · 90 s rests</div>' : ''}</td>
          <td class="num r">${e.type === 'carry' ? `${e.sets} × 40 yd` : `${e.sets} × ${e.reps}`}<div class="ref-note">+${e.increment} ${esc(e.unit)}</div></td></tr>`).join('')}
      </table></section>`;
  }
  if (config.restGuidance) {
    html += `<section class="card"><span class="label">Rest periods</span><div class="ref-note">${esc(config.restGuidance)}</div></section>`;
  }

  // ---- progression rules, in plain English from the config parameters ----
  const p = config.progression;
  html += `<section class="card"><span class="label">Load progression</span>
    <table class="ref-table">
      <tr><td>All prescribed reps completed</td><td>Add the exercise's increment next session</td></tr>
      <tr><td>Any set missed</td><td>Repeat the same load</td></tr>
      <tr><td>${p.consecutiveMissesBeforeDeload} consecutive misses at your last successful load</td><td>Deload to ${Math.round(p.deloadFactor * 100)}% and rebuild</td></tr>
      <tr><td>More than ${p.layoffDays} days off an exercise</td><td>Resume at ${Math.round(p.layoffFactor * 100)}% of last success</td></tr>
      <tr><td>Misses above your last successful load</td><td>Don't count toward deload</td></tr>
      <tr><td>All suggestions</td><td>Round to nearest ${p.roundToNearest} lb; the app suggests, never enforces</td></tr>
    </table></section>`;

  // ---- for your clinician ----
  const avg = L.rollingAverage(state.records, t);
  const slope = L.trendSlope(state.records, t);
  const symptomRows = Object.values(state.records)
    .filter((r) => r.checkin && r.checkin.symptom && r.checkin.symptom !== 'None')
    .sort((a, b) => b.date.localeCompare(a.date));
  const measureRows = [...state.measurements].sort((a, b) => b.takenAt.localeCompare(a.takenAt));

  html += `<section class="card"><span class="label">For your clinician</span>
    <table class="ref-table">
      <tr><td>Current weight</td><td class="num r">${avg != null ? `${avg.toFixed(1)} lb (7-day avg)` : EMDASH}</td></tr>
      <tr><td>Trend</td><td class="num r">${slope != null ? `${fmtSlope(slope)} lb / week` : EMDASH}</td></tr>
    </table>
    <span class="label" style="display:block;margin-top:14px">Muscle symptom log</span>
    ${symptomRows.length
      ? `<table class="ref-table">${symptomRows.map((r) => `<tr><td class="num">${fmtRefDate(r.date)}</td>
          <td${r.checkin.symptom !== 'Mild soreness' ? ' class="ref-alert"' : ''}>${esc(r.checkin.symptom)}${r.checkin.interfered ? `<div class="ref-note">Interfered with training: ${esc(r.checkin.interfered)}</div>` : ''}</td></tr>`).join('')}</table>`
      : `<div class="ref-note">No symptoms logged.</div>`}
    <span class="label" style="display:block;margin-top:14px">Measurements</span>
    ${measureRows.length
      ? `<table class="ref-table">${measureRows.map((m) => `<tr><td class="num">${fmtRefDate(m.takenAt)}</td>
          <td>${MEASURE_LABELS[m.kind] || esc(m.kind)}</td><td class="num r">${m.value}${m.value2 != null ? ` / ${m.value2}` : ''}</td></tr>`).join('')}</table>`
      : `<div class="ref-note">No measurements logged.</div>`}
    <div class="disclaimer" style="margin-top:14px">A personal log, not a medical device. Recorded by the patient; single readings are noise, trends are signal.</div>
  </section>`;

  document.getElementById('view-ref').innerHTML = html;
}

// ---------- sheets ----------

function sheetHtml(sheet) {
  const t = viewStr();
  const rec = state.records[t] || {};
  const config = activeConfig();

  if (sheet.kind === 'weight') {
    return `<span class="label">Weight</span><h2>This morning, lb</h2>
      <div class="field"><input id="sh-weight" type="text" inputmode="decimal" value="${rec.weight != null ? rec.weight : ''}" placeholder="${lastWeightSub().replace(/[^\d.]/g, '') || '220.0'}" autocomplete="off"></div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-weight">Save</button></div>`;
  }
  if (sheet.kind === 'sleep') {
    const h = rec.sleepMinutes != null ? Math.floor(rec.sleepMinutes / 60) : '';
    const m = rec.sleepMinutes != null ? rec.sleepMinutes % 60 : '';
    return `<span class="label">Sleep</span><h2>Last night</h2>
      <div class="two">
        <div class="field"><span class="fl label">Hours</span><input id="sh-sleep-h" type="text" inputmode="numeric" value="${h}" placeholder="7"></div>
        <div class="field"><span class="fl label">Minutes</span><input id="sh-sleep-m" type="text" inputmode="numeric" value="${m}" placeholder="30"></div>
      </div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-sleep">Save</button></div>`;
  }
  if (sheet.kind === 'steps') {
    return `<span class="label">Steps</span><h2>So far today</h2>
      <div class="field"><input id="sh-steps" type="text" inputmode="numeric" value="${rec.steps != null ? rec.steps : ''}" placeholder="8000"></div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-steps">Save</button></div>`;
  }
  if (sheet.kind === 'waist') {
    return `<span class="label">Waist</span><h2>At the navel, inches</h2>
      <div class="field"><input id="sh-waist" type="text" inputmode="decimal" placeholder="40.0"></div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-waist">Save</button></div>`;
  }
  if (sheet.kind === 'cardio') {
    const offered = L.offeredSession(state.configDoc, state.records, t);
    const cd = rec.cardio || {};
    return `<span class="label">${esc(sessionName(offered))}</span><h2>Log session</h2>
      <div class="two">
        <div class="field"><span class="fl label">Minutes</span><input id="sh-cardio-min" type="text" inputmode="numeric" value="${cd.minutes != null ? cd.minutes : ''}" placeholder="${offered.minutes || 40}"></div>
        <div class="field"><span class="fl label">Avg HR (optional)</span><input id="sh-cardio-hr" type="text" inputmode="numeric" value="${cd.avgHr != null ? cd.avgHr : ''}" placeholder="${config.targets.zone2HrRange[0]}–${config.targets.zone2HrRange[1]}"></div>
      </div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-cardio">Save</button></div>`;
  }
  if (sheet.kind === 'meal') {
    const meal = config.meals.find((m) => m.id === sheet.mealId);
    const total = L.mealTotal(meal);
    return `<span class="label">Meal</span><h2>${esc(meal.name)} · <span class="num">${total.cal}</span> cal · <span class="num">${total.protein}</span> g</h2>
      <ul class="components">${meal.components.map((c) => `<li><span>${esc(c.name)}</span><span class="num">${c.cal} cal · ${c.protein} g</span></li>`).join('')}</ul>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="eaten">Ate the planned meal</button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="modified">Ate something similar<span class="sub">Counts the same toward totals; tracked separately.</span></button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="offplan">Ate off-plan<span class="sub">Low protein, heavy carbs, restaurant food. Counts toward calories and protein; does not count as adherence.</span></button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="skipped">Skipped it</button>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`;
  }
  if (sheet.kind === 'measurements') {
    return `<span class="label">Sunday measurements</span><h2>Each one skippable</h2>
      <div class="field"><span class="fl label">Resting heart rate, bpm</span><input id="sh-rhr" type="text" inputmode="numeric" placeholder="62"></div>
      <div class="two">
        <div class="field"><span class="fl label">Systolic</span><input id="sh-sys" type="text" inputmode="numeric" placeholder="125"></div>
        <div class="field"><span class="fl label">Diastolic</span><input id="sh-dia" type="text" inputmode="numeric" placeholder="80"></div>
      </div>
      <div class="field"><span class="fl label">Grip, lb (quarterly is fine)</span><input id="sh-grip" type="text" inputmode="decimal" placeholder=""></div>
      <div class="sheet-actions"><button class="btn quiet" data-act="dismiss-measurements">Not today</button><button class="btn primary" data-act="save-measurements">Save</button></div>`;
  }
  if (sheet.kind === 'settings') {
    const cfg = activeConfig();
    return `<span class="label">Settings</span><h2>Tracker</h2>
      <div class="settings-list">
        <button class="srow" data-act="export">Export backup<span class="sub">days.csv, workouts.csv, measurements.csv, plan config</span></button>
        <button class="srow" data-act="import">Import backup<span class="sub">Same files back in; idempotent on date and id.</span></button>
        <div class="srow">Plan<span class="sub num">Version ${cfg.planVersion} · ${esc(cfg.label || '')} · effective ${cfg.effectiveFrom}</span></div>
        <div class="srow">Edit the plan<span class="sub">Edit config/plan.json in the repo. A revision is a new planVersion with a new effectiveFrom; history stays valued under the version in force when it was logged.</span></div>
        <button class="srow" data-act="wipe" style="color:var(--alert)">Erase all data<span class="sub">Everything local to this phone. Export first.</span></button>
      </div>
      <div class="disclaimer">A personal log, not a medical device. No diagnosis, no medical advice. Decisions about the statin, lipid management, or symptom escalation belong to your physician.</div>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Close</button></div>
      <input id="import-file" type="file" accept=".csv,.json" multiple hidden>`;
  }
  return '';
}

function renderOverlay() {
  const overlay = document.getElementById('overlay');
  if (state.logger) {
    overlay.innerHTML = renderLogger();
    return;
  }
  if (state.sheet) {
    overlay.innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true">${sheetHtml(state.sheet)}</div>`;
    const first = overlay.querySelector('input:not([hidden])');
    if (first && state.sheet.autofocus) first.focus();
    return;
  }
  overlay.innerHTML = '';
}

// ---------- lift logger (§7.10) ----------

function ensureWorkout() {
  const rec = getRec();
  if (!rec.workout) {
    rec.workout = { sessionId: state.logger.sessionId, sets: {} };
  }
  return rec.workout;
}

function renderLogger() {
  const t = viewStr();
  const rec = state.records[t] || { workout: null };
  const config = activeConfig();
  const session = config.sessions[state.logger.sessionId];
  const workout = (rec.workout && rec.workout.sessionId === state.logger.sessionId) ? rec.workout : { sets: {}, minutes: undefined };

  // Progression cues computed against history excluding today.
  const prior = { ...state.records };
  delete prior[t];

  let ex = '';
  let prevPair = null;
  for (const e of session.exercises) {
    const prog = L.progression(state.configDoc, prior, e.id, e, t);
    const scheme = e.type === 'carry' ? `${e.sets} × 40 yd` : `${e.sets} × ${e.reps}`;
    const paired = e.pair != null;
    let rows = '';
    for (let i = 0; i < e.sets; i++) {
      const key = `${e.id}:${i}`;
      const s = workout.sets[key];
      const editing = state.editingSet === key;
      if (s && !editing) {
        rows += `<button class="set-row compact" data-act="edit-set" data-key="${key}">
          <span class="idx num">${i + 1}</span>
          <span class="val num">${s.weight} <span class="x">×</span> ${s.reps}</span>
        </button>`;
      } else {
        // The weight is a real value, not a placeholder: on a fresh exercise it
        // is the plan's seeded start load, after that the progression
        // suggestion. An empty box asks for a number at the worst moment.
        const wVal = s ? s.weight : (prog.suggested != null ? prog.suggested : '');
        const rPh = s ? s.reps : e.reps;
        rows += `<div class="set-row" data-key="${key}">
          <span class="idx num">${i + 1}</span>
          <input type="text" inputmode="decimal" class="wt" placeholder="${wVal}" value="${wVal}" aria-label="weight">
          <span class="times">×</span>
          <input type="text" inputmode="numeric" class="reps" placeholder="${rPh}" value="${s ? s.reps : ''}" aria-label="reps">
          <button class="save-set" data-act="save-set" data-key="${key}" data-ex="${e.id}">Log</button>
        </div>`;
        if (!s && !editing) break; // one open row at a time per exercise
      }
    }

    // How the set felt, which the logged reps cannot express. Drives what the
    // app suggests next time: hit adds load, grindy holds it, two misses deload.
    const mk = (workout.marks || {})[e.id] || null;
    const markRow = `<div class="mark-row">
      ${[['hit', 'Hit'], ['grindy', 'Grindy'], ['miss', 'Missed']].map(([v, label]) =>
        `<button class="mark ${v}${mk === v ? ' sel' : ''}" data-act="mark-set" data-ex="${e.id}" data-mark="${v}">${label}</button>`).join('')}
    </div>`;
    ex += `<div class="exercise${paired ? ' paired' : ''}">
      <div class="ex-head"><span class="name">${esc(e.name)}</span><span class="scheme num">${scheme}</span></div>
      ${paired && e.pair !== prevPair ? `<div class="pair-tag">Alternate with next · 90 s rests</div>` : ''}
      ${prog.cue ? `<div class="ex-cue${prog.tone === 'done' ? ' done' : ''}">${esc(prog.cue)}</div>` : ''}
      ${rows}
      ${markRow}
    </div>`;
    prevPair = paired ? e.pair : null;
  }

  return `<div class="logger"><div class="logger-inner">
    <div class="logger-head"><h2>${esc(session.name)}</h2><button class="close" data-act="close-logger">Close</button></div>
    ${ex}
  </div>
  <div class="logger-foot"><div class="inner">
    <span class="label">Min</span>
    <input id="lg-minutes" type="text" inputmode="numeric" value="${workout.minutes != null ? workout.minutes : ''}" placeholder="55">
    <button class="btn primary" data-act="finish-workout">Finish</button>
  </div></div></div>`;
}

// ---------- CSV export / import (§6.4) ----------

function download(name, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function doExport() {
  const stamp = todayStr();
  download(`days-${stamp}.csv`, L.daysToCsv(state.records));
  download(`workouts-${stamp}.csv`, L.workoutsToCsv(state.records));
  download(`measurements-${stamp}.csv`, L.measurementsToCsv(state.measurements));
  download(`plan-${stamp}.json`, JSON.stringify(state.configDoc, null, 2), 'application/json');
  state.meta.lastExport = stamp;
  save();
  render();
}

async function doImport(files) {
  let imported = [];
  for (const f of files) {
    const text = await f.text();
    const first = text.slice(0, 200);
    if (f.name.endsWith('.json')) { imported.push('plan config ignored (edit config/plan.json in the repo instead)'); continue; }
    if (first.startsWith('date,') && first.includes('sessionId')) {
      const w = L.csvToWorkouts(text);
      for (const [date, workout] of Object.entries(w)) { getRec(date).workout = workout; }
      imported.push(`${Object.keys(w).length} workouts`);
    } else if (first.startsWith('date,')) {
      state.records = L.mergeDays(state.records, L.csvToDays(text));
      imported.push('day records');
    } else if (first.startsWith('id,')) {
      state.measurements = L.mergeMeasurements(state.measurements, L.csvToMeasurements(text));
      imported.push('measurements');
    } else {
      imported.push(`${f.name}: unrecognized`);
    }
  }
  save();
  render();
  alert(`Imported: ${imported.join(', ')}`);
}

// ---------- actions ----------

function handleAction(act, el) {
  const t = viewStr();
  switch (act) {
    case 'sheet': {
      state.sheet = { kind: el.dataset.sheet, mealId: el.dataset.meal, autofocus: true };
      renderOverlay();
      break;
    }
    case 'close-sheet': state.sheet = null; renderOverlay(); break;

    case 'next': {
      const id = el.dataset.next;
      if (id === 'weight' || id === 'sleep' || id === 'steps' || id === 'waist') {
        state.sheet = { kind: id, autofocus: true }; renderOverlay();
      } else if (id === 'training') {
        const offered = L.offeredSession(state.configDoc, state.records, t);
        if (offered.kind === 'lift') { openLogger(offered.sessionId); }
        else { state.sheet = { kind: 'cardio', autofocus: true }; renderOverlay(); }
      } else if (id.startsWith('meal-')) {
        document.getElementById('sec-meals')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (id === 'checkin') {
        document.getElementById('sec-checkin')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (id === 'export') {
        doExport();
      }
      break;
    }

    case 'save-weight': {
      const v = parseFloat(document.getElementById('sh-weight').value);
      if (!isNaN(v) && v > 50 && v < 500) mutate(() => { getRec().weight = Math.round(v * 10) / 10; state.sheet = null; });
      else { state.sheet = null; render(); }
      break;
    }
    case 'save-sleep': {
      const h = parseInt(document.getElementById('sh-sleep-h').value || '0', 10);
      const m = parseInt(document.getElementById('sh-sleep-m').value || '0', 10);
      if (h || m) mutate(() => { getRec().sleepMinutes = h * 60 + m; state.sheet = null; });
      else { state.sheet = null; render(); }
      break;
    }
    case 'save-steps': {
      const v = parseInt((document.getElementById('sh-steps').value || '').replace(/[^\d]/g, ''), 10);
      if (!isNaN(v)) mutate(() => { getRec().steps = v; state.sheet = null; });
      else { state.sheet = null; render(); }
      break;
    }
    case 'save-waist': {
      const v = parseFloat(document.getElementById('sh-waist').value);
      if (!isNaN(v) && v > 20 && v < 80) {
        mutate(() => {
          state.measurements.push({ id: `waist-${Date.now()}`, takenAt: stampIso(), kind: 'waist', value: v, schemaVersion: state.meta.schemaVersion });
          state.sheet = null;
        });
      } else { state.sheet = null; render(); }
      break;
    }
    case 'save-cardio': {
      const min = parseInt(document.getElementById('sh-cardio-min').value, 10);
      const hr = parseInt(document.getElementById('sh-cardio-hr').value, 10);
      if (!isNaN(min) && min > 0) {
        const offered = L.offeredSession(state.configDoc, state.records, t);
        mutate(() => {
          const rec = getRec();
          rec.cardio = { mode: offered.mode || 'walk', minutes: min, completedAt: rec.cardio?.completedAt || stampIso() };
          if (!isNaN(hr)) rec.cardio.avgHr = hr;
          state.sheet = null;
        });
      } else { state.sheet = null; render(); }
      break;
    }
    case 'save-measurements': {
      const fields = [
        ['sh-rhr', 'restingHr'], ['sh-grip', 'grip'],
      ];
      mutate(() => {
        for (const [id, kind] of fields) {
          const v = parseFloat(document.getElementById(id).value);
          if (!isNaN(v)) state.measurements.push({ id: `${kind}-${Date.now()}`, takenAt: stampIso(), kind, value: v, schemaVersion: state.meta.schemaVersion });
        }
        const sys = parseFloat(document.getElementById('sh-sys').value);
        const dia = parseFloat(document.getElementById('sh-dia').value);
        if (!isNaN(sys)) {
          const m = { id: `bp-${Date.now()}`, takenAt: stampIso(), kind: 'bloodPressure', value: sys, schemaVersion: state.meta.schemaVersion };
          if (!isNaN(dia)) m.value2 = dia;
          state.measurements.push(m);
        }
        state.meta.measurementsDismissed = L.weekStart(t);
        state.sheet = null;
      });
      break;
    }
    case 'dismiss-measurements':
      mutate(() => { state.meta.measurementsDismissed = L.weekStart(t); state.sheet = null; });
      break;

    case 'meal-toggle': {
      const id = el.dataset.meal;
      mutate(() => {
        const rec = getRec();
        rec.meals[id] = rec.meals[id] === 'eaten' ? undefined : 'eaten';
      });
      break;
    }
    case 'meal-set': {
      const id = el.dataset.meal;
      const st = el.dataset.state;
      mutate(() => { getRec().meals[id] = st; state.sheet = null; });
      break;
    }
    case 'mod-toggle': {
      const id = el.dataset.mod;
      mutate(() => { const rec = getRec(); rec.modifiers[id] = !rec.modifiers[id]; });
      break;
    }

    case 'chip': mutate(() => {
      const rec = getRec();
      rec.checkin = rec.checkin || {};
      const k = el.dataset.key, v = Number(el.dataset.val);
      rec.checkin[k] = rec.checkin[k] === v ? undefined : v;
    }); break;
    case 'symptom': mutate(() => {
      const rec = getRec();
      rec.checkin = rec.checkin || {};
      rec.checkin.symptom = el.dataset.val;
      if (el.dataset.val !== 'Weakness' && el.dataset.val !== 'Muscle pain') rec.checkin.interfered = undefined;
    }); break;
    case 'interfered': mutate(() => {
      const rec = getRec();
      rec.checkin.interfered = el.dataset.val;
    }); break;

    case 'open-logger': {
      const offered = L.offeredSession(state.configDoc, state.records, t);
      const rec = state.records[t];
      // offered.sessionId is undefined on a day that offers no lift, which is
      // reachable now that a logged workout is openable from any day.
      const sessionId = (rec && rec.workout && rec.workout.sessionId)
        || offered.sessionId
        || L.nextLiftId(state.records);
      openLogger(sessionId);
      break;
    }
    case 'close-logger': state.logger = null; state.editingSet = null; render(); break;
    case 'edit-set': state.editingSet = el.dataset.key; renderOverlay(); break;
    case 'save-set': saveSetFromRow(el.dataset.key, el.dataset.ex); break;
    case 'finish-workout': {
      const min = parseInt(document.getElementById('lg-minutes').value, 10);
      mutate(() => {
        const w = ensureWorkout();
        if (!isNaN(min)) w.minutes = min;
        w.completedAt = w.completedAt || stampIso();
        state.logger = null;
        state.editingSet = null;
      });
      break;
    }

    // ---- day navigation (backfill) ----
    // Bounded to the program's own span: never before day 1, never the future.
    case 'day-prev': {
      const d = L.addDays(viewStr(), -1);
      if (d >= L.programStart(state.configDoc)) { state.viewDate = d; state.tab = 'today'; render(); }
      break;
    }
    case 'day-next': {
      const d = L.addDays(viewStr(), 1);
      if (d <= todayStr()) { state.viewDate = d === todayStr() ? null : d; render(); }
      break;
    }
    case 'day-today': state.viewDate = null; render(); break;
    case 'day-pick': {
      const d = el.dataset.date;
      if (d && d <= todayStr() && d >= L.programStart(state.configDoc)) {
        state.viewDate = d === todayStr() ? null : d;
        state.tab = 'today';
        render();
      }
      break;
    }

    case 'mark-set': {
      const exId = el.dataset.ex;
      const m = el.dataset.mark;
      mutate(() => {
        const w = ensureWorkout();
        if (!w.marks) w.marks = {};
        if (w.marks[exId] === m) delete w.marks[exId];
        else w.marks[exId] = m;
      });
      break;
    }

    case 'export': doExport(); break;
    case 'import': {
      const input = document.getElementById('import-file');
      input.onchange = () => doImport([...input.files]);
      input.click();
      break;
    }
    case 'wipe': {
      if (confirm('Erase all local data? Export first if you have not.') && confirm('Really erase everything?')) {
        localStorage.removeItem(KEYS.days);
        localStorage.removeItem(KEYS.measurements);
        localStorage.removeItem(KEYS.meta);
        location.reload();
      }
      break;
    }
  }
}

function openLogger(sessionId) {
  state.sheet = null;
  state.logger = { sessionId };
  const rec = getRec();
  if (!rec.workout || rec.workout.sessionId !== sessionId) {
    rec.workout = { sessionId, sets: {} };
  }
  save();
  render();
}

function saveSetFromRow(key, exId) {
  const row = document.querySelector(`.set-row[data-key="${key}"]`);
  if (!row) return;
  const wtInput = row.querySelector('.wt');
  const repsInput = row.querySelector('.reps');
  const wt = parseFloat(wtInput.value || wtInput.placeholder);
  const reps = parseInt(repsInput.value || repsInput.placeholder, 10);
  if (isNaN(wt) || isNaN(reps)) return;
  mutate(() => {
    const w = ensureWorkout();
    w.sets[key] = { weight: wt, reps };
    state.editingSet = null;
  });
}

// ---------- render root ----------

function render() {
  if (state.tab === 'today') renderToday();
  else if (state.tab === 'week') renderWeek();
  else renderReference();
  for (const tab of ['today', 'week', 'ref']) {
    document.getElementById(`view-${tab}`).hidden = state.tab !== tab;
    document.getElementById(`tab-${tab}`).setAttribute('aria-selected', state.tab === tab);
  }
  renderOverlay();
}

// ---------- boot ----------

async function boot() {
  const res = await fetch('config/plan.json');
  state.configDoc = await res.json();

  if (DEMO) {
    const d = demoData();
    state.records = d.records;
    state.measurements = d.measurements;
  } else {
    const s = loadStore();
    state.records = s.records;
    state.measurements = s.measurements;
    state.meta = s.meta;
    save();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) handleAction(el.dataset.act, el);
  });
  document.getElementById('tab-today').addEventListener('click', () => { state.tab = 'today'; render(); });
  document.getElementById('tab-week').addEventListener('click', () => { state.tab = 'week'; render(); });
  document.getElementById('tab-ref').addEventListener('click', () => { state.tab = 'ref'; render(); });

  // Enter key submits the primary action of an open sheet.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.sheet) {
      const primary = document.querySelector('.sheet .btn.primary');
      if (primary && e.target.tagName === 'INPUT') { e.preventDefault(); primary.click(); }
    }
    if (e.key === 'Escape') {
      if (state.sheet) { state.sheet = null; renderOverlay(); }
      else if (state.logger) { state.logger = null; state.editingSet = null; render(); }
    }
  });

  render();

  // Demo-only preview hook for the logger (?demo&logger).
  if (DEMO && new URLSearchParams(location.search).has('logger')) {
    openLogger(L.nextLiftId(state.records));
  }

  // Re-render on the minute so the NEXT bar and date follow the clock, and
  // when returning to the app (backgrounding must lose nothing).
  let lastMinuteKey = '';
  setInterval(() => {
    const key = `${todayStr()}:${nowHour()}:${new Date().getMinutes()}`;
    if (key !== lastMinuteKey && !state.logger && !state.sheet) { lastMinuteKey = key; render(); }
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.logger && !state.sheet) render();
  });

  // Keep the browser from evicting months of history.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
