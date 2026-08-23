// UI layer. All business logic lives in logic.js; this file renders state and
// writes user input to localStorage. Autosave on every change (§7.1).

import * as L from './logic.js';

// ---------- store ----------

const DEMO = new URLSearchParams(location.search).has('demo');
const KEYS = { days: 'tracker.days', measurements: 'tracker.measurements', meta: 'tracker.meta' };

// schemaVersion migrations, applied in order at load (§6.3). v1 is current.
const MIGRATIONS = [
  // v2 added the Achilles rehab record, the morning Achilles answer, the
  // chin-up phase stamp, and accepted exercise variations. Every one of them is
  // an optional field on a day that did not have it, so no existing record
  // changes shape — the migration only moves the marker forward.
  { to: 2 },
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

// Which cached build is actually serving this session. Read from the service
// worker's own cache name, so it reports what is running rather than what was
// last deployed — the two diverged repeatedly and there was no way to tell.
let activeBuild = null;

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
  const start = L.programStart(state.configDoc);
  const weights = [221.2, 220.6, 220.9, 220.1, 219.8, 220.3, 219.4, 219.6, 218.9, 219.2, 218.4, 218.7, 218.0, 218.3, 217.6, 217.9, 217.2, 217.4];
  for (let i = 0; i < weights.length; i++) {
    const d = L.addDays(start, i);
    if (d > todayStr()) break;
    const r = {
      date: d, schemaVersion: 1, planVersion: L.configFor(state.configDoc, d).planVersion,
      weight: weights[i],
      sleepMinutes: 420 + (i * 7) % 60,
      steps: 5200 + (i * 731) % 4500,
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: i % 5 === 3 ? 'skipped' : 'eaten', dinner: 'eaten', dessert: i % 4 === 2 ? 'modified' : 'eaten' },
      modifiers: {},
      checkin: {
        energy: 1 + (i % 2), hunger: 1, soreness: i % 3 === 0 ? 1 : 2, stress: 1,
        symptom: i === 9 ? 'Mild soreness' : 'None',
        achilles: i === 11 ? 'worse' : i % 4 === 0 ? 'better' : 'same',
      },
      rehab: { heelRaisesDone: i % 6 !== 4, loadUsed: i < 8 ? 0 : 10 },
    };
    const plan = L.dayPlan(state.configDoc, d);
    if (plan.type === 'lift' && !plan.suppressed && i !== weights.length - 1) {
      const sessionId = L.nextLiftId(records);
      const exs = L.sessionExercises(state.configDoc, records, sessionId, d);
      const sets = {};
      for (const ex of exs) {
        const base = ex.startWeight != null ? ex.startWeight : 0;
        for (let s = 0; s < ex.sets; s++) sets[`${ex.id}:${s}`] = { weight: base + Math.floor(i / 7) * 5, reps: ex.reps };
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
    date: t, schemaVersion: 1, planVersion: L.configFor(state.configDoc, t).planVersion,
    weight: 217.4, sleepMinutes: 462, steps: 5832,
    meals: { breakfast: 'eaten' }, modifiers: {},
  };
  const measurements = [
    { id: 'demo-w1', takenAt: `${start}T07:00:00`, kind: 'waist', value: 42.0, schemaVersion: 1 },
    { id: 'demo-b1', takenAt: `${L.addDays(start, 6)}T08:00:00`, kind: 'bloodPressure', value: 126, value2: 80, schemaVersion: 1 },
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
  if (offered.mode === 'hike') return 'Hike';
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
    <div class="sub num">${day < 1 ? `Starts ${startLabel()}` : `Day ${day} · Week ${week}`} · ${toGo != null ? toGo.toFixed(1) : EMDASH} lb to go</div>
    ${isToday() ? '' : `<button class="backfill-flag" data-act="day-today">Filling in a past day ${EMDASH} back to today</button>`}
    <div class="gauge" role="img" aria-label="${gauge.filter((g) => g.done).length} of ${gauge.length} logged">
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
  const pace = L.stepPace(state.configDoc, state.records, t);
  const onPace = !!(pace && pace.onPace && rec.steps != null);
  const focusLines = [];
  if (offered.kind !== 'rest' && !plan.suppressed) {
    let nm = sessionName(offered);
    if (offered.kind === 'cardio' || offered.kind === 'walk') nm += ` ${offered.minutes} min`;
    focusLines.push(`${EMDASH} ${esc(nm)}${offered.pushedFrom ? ` <span class="num">(pushed from ${offered.pushedFrom})</span>` : ''}`);
  }
  focusLines.push(`${EMDASH} Eat <span class="num">${fmtInt(plan.calorieTarget)}</span> cal · <span class="num">${plan.proteinTarget}</span> g protein`);
  if (rec.steps == null) focusLines.push(`${EMDASH} Walk <span class="num">${fmtInt(plan.stepTarget)}</span> steps`);
  else if (stepsLeft > 0 && !onPace) focusLines.push(`${EMDASH} Walk <span class="num">${fmtInt(stepsLeft)}</span> more steps`);
  else if (stepsLeft > 0) focusLines.push(`${EMDASH} Short today, week on pace at <span class="num">${fmtInt(pace.total)}</span>`);
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
  // The step segment clears on the daily target or on the week being on pace,
  // so the tile shows both numbers rather than nagging about a covered day.
  const weekSteps = pace
    ? `<div class="of num${onPace ? ' good' : ''}">week ${fmtInt(pace.total)} of ${fmtInt(pace.weekly)}</div>`
    : '';
  const calPct = Math.min(1, nut.cal / plan.calorieTarget);
  const proPct = Math.min(1, nut.protein / plan.proteinTarget);
  html += `<div class="tiles" id="sec-tiles">
    <button class="tile" data-act="sheet" data-sheet="steps">
      <span class="label">Steps</span>
      <div class="value num${rec.steps == null ? ' empty' : ''}">${rec.steps != null ? fmtInt(rec.steps) : EMDASH}</div>
      <div class="of num">of ${fmtInt(plan.stepTarget)}</div>
      ${weekSteps}
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
      <div class="of num">of ${plan.proteinTarget} g today</div>
      <div class="bar"><div class="fill" style="width:${(proPct * 100).toFixed(1)}%"></div></div>
    </div>
  </div>`;

  // A desk-job habit, not a session. It is one quiet line and it can be turned
  // off; a web app cannot raise a notification while it is closed, and
  // pretending otherwise would be the wrong kind of promise.
  const mb = (config.habits || {}).movementBreak;
  if (mb && state.meta.movementBreaks !== false) {
    html += `<div class="habit-line"><span class="label">Every ${mb.everyMinutes} min sitting</span> ${esc(mb.text)} <span class="ref-note">${esc(mb.why || '')}</span></div>`;
  }

  // training
  html += renderTraining(rec, plan, offered);

  // Achilles rehab — daily, and deliberately outside the strength days (§9.1)
  html += renderRehab(rec);

  // meals
  html += renderMeals(rec, plan, config);

  // Sunday measurements prompt (§7.12)
  if (L.weekday(t) === 0 && state.meta.measurementsDismissed !== L.weekStart(t) && !measuredThisWeek(t)) {
    html += `<button class="prompt" data-act="sheet" data-sheet="measurements">
      <span class="title">Sunday measurements</span>
      <span class="sub">Blood pressure. Skippable.</span>
    </button>`;
  }

  // check-in
  html += renderCheckin(rec);

  document.getElementById('view-today').innerHTML = html;
}

// Day 1 can be in the future: a plan is written before the block it starts.
// "Day 0 · Week 0" reads as a bug, so name the date the program begins instead.
function startLabel() {
  return L.parseDate(L.programStart(state.configDoc))
    .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
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
  return state.measurements.some((m) => m.kind === 'bloodPressure' && m.takenAt.slice(0, 10) >= ws);
}

// ---------- training section ----------

// A day's logged lift, with the way back into it. Rendered whenever a workout
// exists on the record — see the orphan note in renderTraining.
function liftCard(rec, config, idAttr) {
  const session = config.sessions[rec.workout.sessionId];
  if (!session) return '';
  const { progressed, allHit } = workoutSummary(rec, L.sessionExercises(state.configDoc, state.records, rec.workout.sessionId, rec.date));
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
      const count = L.sessionExercises(state.configDoc, state.records, offered.sessionId, viewStr()).length;
      inner = `<button class="prompt"${secId} data-act="open-logger">
        <span class="title">Start ${esc(session.name)}</span>
        <span class="sub">${offered.pushedFrom ? `Pushed from ${offered.pushedFrom}` : `${count} exercises · about ${(config.schedule[String(L.weekday(viewStr()))] || {}).minutes || 55} min`}</span>
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
      // Steps are never inferred from a cardio session. What a bike does for
      // the step count is nothing, and the card says so rather than quietly
      // crediting minutes as movement.
      if (plan.schedule.stepsNote) subParts.push(plan.schedule.stepsNote);
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

function workoutSummary(rec, exercises) {
  // progressed: exercises whose max load today exceeds max load last time.
  const prior = { ...state.records };
  delete prior[rec.date];
  let progressed = 0;
  let allHit = true;
  for (const ex of exercises) {
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

// ---------- Achilles rehab (§9.1) ----------

// Its own card, run daily, sitting outside the strength days on purpose: it is
// the thing that has to happen whether or not there was a session, and burying
// it inside a lift day would mean it stops on rest days.
function renderRehab(rec) {
  const config = activeConfig();
  const cfg = L.rehabConfig(config);
  if (!cfg) return '';
  const t = viewStr();
  const done = !!(rec.rehab && rec.rehab.heelRaisesDone);
  const load = L.rehabLoad(state.configDoc, state.records, t);
  const pull = L.achillesPullBack(state.configDoc, state.records, t);
  const cleared = state.meta.achillesClinicianCleared;
  const used = rec.rehab && rec.rehab.loadUsed != null ? rec.rehab.loadUsed : null;
  const loadText = (v) => (v ? `${v} ${cfg.loadUnit || 'lb'}` : 'bodyweight');

  let html = `<section class="card rehab" id="sec-rehab"><span class="label">Achilles rehab</span>`;

  // The clinician flag is a gate, not a notice: bilateral and spontaneous is
  // the presentation that wants a look before it gets self-managed. It stays
  // until it is marked cleared, and there is no way to tap past it.
  if (!cleared) {
    html += `<div class="medical-notice">${esc(cfg.medicalFlag.text)}
      <button class="notice-action" data-act="achilles-cleared">${esc(cfg.medicalFlag.action)}</button></div>`;
  }

  html += `<div class="rehab-move">${cfg.movements.map((m) =>
    `<div class="line"><span>${esc(m.name)}</span><span class="num">${m.sets} × ${m.reps}</span></div>`).join('')}</div>
    <div class="ref-note">${esc(cfg.technique)}</div>`;

  if (pull) {
    // Order matters more than the fact of pulling back: the rehab load is the
    // last thing to come down, because it is the thing rebuilding the tendon.
    html += `<div class="followup"><span class="label">Morning reading was worse</span>
      <div class="pull-text">${esc(pull.text)}</div>
      <ol class="pull-order">${pull.order.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>
      <div class="pull-text">${load.from ? `Then the heel raises: ${esc(loadText(load.suggested))}, down from ${esc(loadText(load.from))}.` : 'The heel raises are already at bodyweight. Keep doing them; they are what rebuilds the tendon.'}</div>
    </div>`;
  }

  html += `<div class="rehab-row">
    <button class="rehab-check${done ? ' done' : ''}" data-act="rehab-toggle" aria-label="Heel raises ${done ? 'done' : 'not done'}"></button>
    <button class="rehab-main" data-act="sheet" data-sheet="rehab">
      <span class="rehab-name">${done ? 'Done today' : 'Both variations, 3 × 15'}</span>
      <span class="meal-sub num">${done && used != null ? `${loadText(used)} used` : `${loadText(load.suggested)} suggested`}</span>
    </button>
    <button class="meal-change" data-act="sheet" data-sheet="rehab">Load</button>
  </div>
  <div class="ref-note">${esc(cfg.painRule)} ${esc(cfg.cadenceNote)}</div>
  </section>`;
  return html;
}

// ---------- meals section ----------

function renderMeals(rec, plan, config) {
  let rows = '';
  for (const meal of L.mealsFor(config, viewStr())) {
    const st = rec.meals[meal.id];
    const total = L.mealTotal(meal);
    let sub;
    if (st === 'eaten' || st === 'modified' || st === 'offplan') {
      const tag = st === 'modified' ? ' · similar' : st === 'offplan' ? ' · off-plan' : meal.estimate ? ' · estimate' : '';
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
      // A zero-calorie item (creatine) is tracked for adherence only, so
      // hanging "0 cal" off it would be noise on every row, every day.
      const cost = mod.cal ? `, <span class="num">${mod.cal}</span> cal` : '';
      mods += `<button class="modifier-row${on ? ' on' : ''}" data-act="mod-toggle" data-mod="${mod.id}">
        <span class="box"></span>
        <span class="mlabel">+ ${esc(mod.label)}${cost}</span>
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
  // The exercise is judged by the next morning, not by how it felt at the
  // time, so this reading is the one that governs the rehab load.
  const rehab = L.rehabConfig(activeConfig());
  if (rehab) {
    html += `<hr class="rule">`;
    html += `<div class="chip-row"><span class="label">${esc(rehab.morningQuestion)}</span><div class="chips">
      ${rehab.morningOptions.map((o) => `<button class="chip${c.achilles === o ? ' sel' : ''}${o === 'worse' ? ' alert-chip' : ''}" data-act="achilles" data-val="${esc(o)}">${esc(o[0].toUpperCase() + o.slice(1))}</button>`).join('')}
    </div></div>`;
    if (c.achilles === 'worse') {
      html += `<div class="followup"><span class="label">Pull back in this order</span>
        <ol class="pull-order">${(rehab.pullBackOrder || []).map((o) => `<li>${esc(o)}</li>`).join('')}<li>Then reduce the heel-raise load.</li></ol></div>`;
    }
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
  const achWorse = L.achillesWorseDays(state.records, t);
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

  // Protein is the plan's one governing number and it is a WEEKLY average, so
  // the week screen is where it is judged. The daily tile can read short on a
  // salmon Monday and the week can still be exactly on plan.
  const wkPlan = L.dayPlan(state.configDoc, t);
  const proGoal = wkPlan.proteinWeeklyAvg;
  const proMet = stats.avgProtein != null && stats.avgProtein >= proGoal - 5;
  html += `<section class="card"><span class="label">This week</span>
    <div class="metric-grid">
      <div><span class="num">${stats.mealAdherence != null ? Math.round(stats.mealAdherence * 100) + '%' : EMDASH}</span><span class="label">Meal adherence</span></div>
      <div><span class="num">${stats.sessionsDone} / ${stats.sessionsPlanned}</span><span class="label">Sessions</span></div>
      <div><span class="num${proMet ? ' good' : ''}">${stats.avgProtein != null ? `${fmtInt(stats.avgProtein)} g` : EMDASH}</span><span class="label">Avg protein</span></div>
      <div><span class="num">${stats.avgCalories != null ? fmtInt(stats.avgCalories) : EMDASH}</span><span class="label">Avg calories</span></div>
      <div><span class="num${stats.steps && stats.steps.onPace ? ' good' : ''}">${stats.steps ? fmtInt(stats.steps.total) : EMDASH}</span><span class="label">Steps this week</span></div>
      <div><span class="num">${stats.avgSleep != null ? fmtSleep(stats.avgSleep) : EMDASH}</span><span class="label">Avg sleep</span></div>
    </div>
    <div class="ref-note">Achilles rehab logged ${stats.rehabDays} of ${stats.days.length} day${stats.days.length === 1 ? '' : 's'} so far this week.</div>
    ${stats.steps ? `<div class="ref-note">Steps are judged by the week: ${fmtInt(stats.steps.total)} of ${fmtInt(stats.steps.weekly)}, ${stats.steps.onPace ? 'on pace' : `${fmtInt(Math.max(0, stats.steps.required - stats.steps.total))} behind pace`} through ${stats.steps.elapsed} day${stats.steps.elapsed > 1 ? 's' : ''}. A hike banks against a quiet day.</div>` : ''}
    <div class="ref-note">Protein is judged here, as a weekly average: aim ${proGoal} g. Weekday dinners bank the surplus that covers the weekend.${stats.nutritionDays ? ` Averaged over ${stats.nutritionDays} logged day${stats.nutritionDays > 1 ? 's' : ''}.` : ''}</div>
  </section>`;

  html += `<section class="card"><span class="label">Recommendation</span>
    <div class="recommendation">${esc(rec7)}</div>
    ${sympDays.length ? `<div class="rec-symptom">Muscle symptoms logged ${sympDays.length} day${sympDays.length > 1 ? 's' : ''} this week. Worth mentioning at your next appointment.</div>` : ''}
    ${achWorse.length ? `<div class="rec-symptom">Achilles came back worse on ${achWorse.length} morning${achWorse.length > 1 ? 's' : ''} this week. Worth mentioning at your next appointment.</div>` : ''}
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
const MEASURE_LABELS = {
  waist: 'Waist, in',
  bloodPressure: 'Blood pressure',
  // No longer collected. Kept so measurements already on the record still
  // render with a name: removing a measurement ends the tracking, it does not
  // delete what was recorded.
  restingHr: 'Resting HR, bpm',
  grip: 'Grip, lb',
};

function describeSched(entry, config) {
  if (entry.type === 'lift') return `${entry.label || 'Lift'} — A/B alternating`;
  if (entry.type === 'rest') return 'Rest';
  if (entry.type === 'walk') return `Walk · ${entry.minutes} min${entry.optional ? ' · optional' : ''}`;
  if (entry.mode === 'intervals') return `Intervals · ${entry.minutes} min · ${entry.prescription || ''}`;
  const [lo, hi] = config.targets.zone2HrRange;
  return `Zone 2 · ${entry.minutes} min · HR ${lo}–${hi}`;
}

// Exercise presentation, shared by the Reference tab and the logger. A carry is
// not sets × reps, and a lift whose target is a clean bodyweight chin-up has no
// number at all, so both come from the plan when it supplies them.
function exScheme(e) {
  return e.scheme || `${e.sets} × ${e.reps}`;
}
// Where the lift starts, and where it is going when the plan says. This plan
// mostly does not: the goals moved off barbell numbers onto the scale and the
// mirror, so an exercise with no destination shows its starting point alone
// rather than an em dash standing in for a number that was deliberately cut.
function exRange(e) {
  const start = e.startLabel || (e.startWeight != null ? String(e.startWeight) : null);
  const goal = e.goalLabel || (e.goal != null ? String(e.goal) : null);
  const unit = !e.startLabel && !e.goalLabel && e.unit ? ` ${e.unit}` : '';
  if (!start) return '';
  return goal ? `${start} → ${goal}${unit}` : `from ${start}${unit}`;
}
function exProgressionNote(e, config) {
  const parts = [];
  const rule = config ? L.progressionRule(config, e) : null;
  if (e.incrementNote) parts.push(e.incrementNote);
  else if (e.taperIncrement != null) parts.push(`+${e.increment}, then +${e.taperIncrement} over ${e.taperAbove}`);
  else if (rule && rule.rule) parts.push(rule.rule);
  else if (e.increment != null) parts.push(`+${e.increment} ${e.unit}`);
  if (e.goalWeeks) parts.push(`~${e.goalWeeks} wks`);
  if (e.pair) parts.push('paired');
  return parts.join(' · ');
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
      <tr><td>Protein</td><td class="num">${tg.proteinWeeklyAvg != null ? `${tg.proteinWeeklyAvg} g — weekly average${tg.proteinAcceptableFloor != null ? `, ${tg.proteinAcceptableFloor} g floor` : ''}` : `${tg.proteinFloor} g / day`}</td></tr>
      ${tg.calorieDailyTarget != null ? `<tr><td>Calories</td><td class="num">${fmtInt(tg.calorieDailyTarget)} / day target</td></tr>` : ''}
      ${tg.satFatBudget != null ? `<tr><td>Saturated fat</td><td class="num">under ${tg.satFatBudget} g / day</td></tr>` : ''}
      <tr><td>Steps</td><td class="num">${fmtInt(tg.stepTarget)} / day${tg.stepWeeklyTarget != null ? `, ${fmtInt(tg.stepWeeklyTarget)} / week` : ''} (ramped in early weeks)</td></tr>
      <tr><td>Sleep</td><td class="num">${fmtSleep(tg.sleepTargetMinutes)}</td></tr>
    </table>
    ${(config.goals || []).length ? `<span class="label" style="display:block;margin-top:14px">What it is for</span>
      <ul class="ref-list">${config.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
      ${config.goalNote ? `<div class="ref-note">${esc(config.goalNote)}</div>` : ''}` : ''}
    </section>`;

  // ---- dietary protocol ----
  // Two tables, because the plan has two halves: blocks that never change, and
  // a dinner that changes by weekday. Every number is derived from the config,
  // so a portion edit re-totals the page.
  let mealsHtml = '';
  let fixedCal = 0, fixedPro = 0;
  for (const meal of config.meals) {
    const total = L.mealTotal(meal);
    fixedCal += total.cal; fixedPro += total.protein;
    const when = meal.hour != null ? `${meal.hour > 12 ? meal.hour - 12 : meal.hour}${meal.hour >= 12 ? 'pm' : 'am'} · ` : '';
    mealsHtml += `<table class="ref-table meal-detail">
      <tr class="ref-head"><th>${when}${esc(meal.name)}</th><th class="num r">${total.cal} cal · ${total.protein} g</th></tr>
      ${meal.components.map((c) => `<tr><td>${esc(c.name)}</td><td class="num r">${c.cal} cal · ${c.protein} g</td></tr>`).join('')}
    </table>`;
  }

  // Dinner by day, taken from the same weekday overrides the app eats from.
  let dayRows = '';
  let weekCal = 0, weekPro = 0, weekN = 0;
  if (config.weekdays) {
    for (const wd of DAY_ORDER) {
      const w = config.weekdays[wd];
      if (!w) continue;
      const dinner = L.mealsForWeekday(config, wd).find((m) => m.id === 'dinner');
      const base = config.meals.find((m) => m.id === 'dinner');
      const baseIds = new Set(base.components.map((c) => c.name));
      const shown = dinner.components.filter((c) => !baseIds.has(c.name));
      const extras = (w.mealModifiers || [])
        .map((id) => (config.mealModifiers || []).find((m) => m.id === id))
        .filter((m) => m && m.cal);
      weekCal += w.calorieTarget; weekPro += w.proteinTarget; weekN++;
      dayRows += `<tr><td>${DAY_FULL[wd]}
          <div class="ref-note">${esc(shown.map((c) => c.name).join(' · '))}${extras.length ? ` + ${esc(extras.map((m) => m.label).join(' + '))}` : ''}${dinner.estimate ? ' · estimate' : ''}</div></td>
        <td class="num r">${fmtInt(w.calorieTarget)} cal<div class="ref-note">${w.proteinTarget} g protein</div></td></tr>`;
    }
  }

  const modRows = (config.mealModifiers || []).map((m) =>
    `<tr><td>${esc(m.label)}${m.optional ? ' (optional, by choice)' : ' (automatic)'}</td><td class="num r">${m.cal > 0 ? '+' : ''}${m.cal} cal</td></tr>`).join('');
  const notes = (config.dietNotes || []).map((n) => `<li>${esc(n)}</li>`).join('');

  html += `<section class="card"><span class="label">Dietary protocol</span>
    <span class="label" style="display:block;margin-top:6px">Every day</span>
    ${mealsHtml}
    <table class="ref-table"><tr class="ref-head"><th>Fixed subtotal, before dinner protein</th><th class="num r">${fmtInt(fixedCal)} cal · ${fixedPro} g</th></tr></table>
    ${dayRows ? `<span class="label" style="display:block;margin-top:14px">Dinner by day</span>
      <table class="ref-table">${dayRows}</table>` : ''}
    ${weekN ? `<table class="ref-table"><tr class="ref-head"><th>Weekly average</th><th class="num r">${fmtInt(weekCal / weekN)} cal · ${Math.round(weekPro / weekN)} g</th></tr>
      <tr><td>Target</td><td class="num r">${tg.calorieDailyTarget != null ? `${fmtInt(tg.calorieDailyTarget)} cal` : EMDASH} · ${tg.proteinWeeklyAvg != null ? tg.proteinWeeklyAvg : tg.proteinFloor} g</td></tr></table>` : ''}
    <span class="label" style="display:block;margin-top:14px">Add-ons</span>
    <table class="ref-table">${modRows}</table>
    ${notes ? `<span class="label" style="display:block;margin-top:14px">How to run it</span><ul class="ref-list">${notes}</ul>` : ''}
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
    phasesHtml += `<tr><td class="nw">Weeks ${p.weeks.join('–')}</td><td>${esc(parts.join(' · '))}${p.note ? `<div class="ref-note">${esc(p.note)}</div>` : ''}</td></tr>`;
  }
  html += `<section class="card"><span class="label">Weekly schedule</span>
    <table class="ref-table">${schedRows}</table>
    ${phasesHtml ? `<span class="label" style="display:block;margin-top:14px">Ramp-in phases</span><table class="ref-table">${phasesHtml}</table>` : ''}
    ${config.zone2Guidance ? `<div class="ref-note" style="margin-top:10px">${esc(config.zone2Guidance)}</div>` : ''}
  </section>`;

  // ---- lift sessions ----
  // Start → goal is the whole point of the table: every load in the plan is a
  // waypoint between two numbers, and the app can only suggest the next step if
  // the destination is written down.
  const chinNow = L.chinupState(state.configDoc, state.records, t);
  for (const [sid, session] of Object.entries(config.sessions)) {
    const warm = [(config.warmup || {}).all, (config.warmup || {})[sid]].filter(Boolean).join(' ');
    html += `<section class="card"><span class="label">${esc(session.name)}${session.day ? ` · ${esc(session.day)}` : ''}</span>
      <table class="ref-table">
        <tr class="ref-head"><th>Exercise</th><th class="r">Sets × reps</th></tr>
        ${session.exercises.map((e) => {
          // The chin-up is a phase, not a load, so the table names the phase
          // in force and leaves the detail to its own section below.
          if (e.phased === 'chinup' && chinNow) {
            return `<tr><td>${esc(e.name)}
              <div class="ex-goal num">phase ${chinNow.phase} of ${(config.chinup.phases || []).length} · ${esc(chinNow.cfg.name)}</div>
              <div class="ref-note">${esc(chinNow.detail || '')}</div></td>
              <td class="num r">${esc(chinNow.cfg.prescription)}</td></tr>`;
          }
          const range = exRange(e);
          return `<tr>
            <td>${esc(e.name)}
              ${range ? `<div class="ex-goal num">${esc(range)}</div>` : ''}
              <div class="ref-note">${esc(exProgressionNote(e, config))}</div>
              ${e.note ? `<div class="ref-note">${esc(e.note)}</div>` : ''}</td>
            <td class="num r">${esc(exScheme(e))}${e.rest ? `<div class="ref-note">rest ${esc(e.rest)}</div>` : ''}</td>
          </tr>`;
        }).join('')}
      </table>
      ${session.note ? `<div class="ref-note" style="margin-top:10px">${esc(session.note)}</div>` : ''}
      ${warm ? `<span class="label" style="display:block;margin-top:14px">Warm-up</span><div class="ref-note">${esc(warm)}</div>` : ''}
    </section>`;
  }

  // ---- chin-up progression, all three phases, current one marked
  if (config.chinup && (config.chinup.phases || []).length) {
    html += `<section class="card"><span class="label">Chin-up progression</span>
      <table class="ref-table">
        ${config.chinup.phases.map((ph) => `<tr>
          <td class="nw">Phase ${ph.phase}${chinNow && chinNow.phase === ph.phase ? '<div class="ref-note">current</div>' : ''}</td>
          <td><strong>${esc(ph.name)}</strong>
            <div class="ref-note">${esc(ph.prescription)}</div>
            <div class="ref-note">Advance on: ${esc(ph.advanceLabel)}</div>
            ${ph.note ? `<div class="ref-note">${esc(ph.note)}</div>` : ''}</td>
        </tr>`).join('')}
      </table>
      <div class="ref-note" style="margin-top:10px">The phase moves when you accept it, not when the app decides. ${esc(config.chinup.moraleNote || '')}</div>
    </section>`;
  }

  // ---- Achilles rehab protocol
  const rehabCfg = L.rehabConfig(config);
  if (rehabCfg) {
    html += `<section class="card"><span class="label">Achilles rehab</span>
      <table class="ref-table">
        ${rehabCfg.movements.map((m) => `<tr><td>${esc(m.name)}<div class="ref-note">${esc(m.targets)}</div></td><td class="num r">${m.sets} × ${m.reps}</td></tr>`).join('')}
      </table>
      <div class="ref-note" style="margin-top:10px">${esc(rehabCfg.technique)}</div>
      <div class="ref-note">${esc(rehabCfg.progression)}</div>
      <div class="ref-note">${esc(rehabCfg.painRule)}</div>
      <div class="ref-note">${esc(rehabCfg.cadenceNote)}</div>
      <span class="label" style="display:block;margin-top:14px">If the morning comes back worse</span>
      <ol class="pull-order">${(rehabCfg.pullBackOrder || []).map((o) => `<li>${esc(o)}</li>`).join('')}<li>Then reduce the heel-raise load.</li></ol>
    </section>`;
  }

  // ---- step logic, in the plan's own words
  if (config.stepLogic) {
    const sl = config.stepLogic;
    html += `<section class="card"><span class="label">Steps</span>
      <table class="ref-table">
        <tr><td>Daily</td><td class="num r">${fmtInt(sl.dailyTarget)}</td></tr>
        <tr><td>Weekly</td><td class="num r">${fmtInt(sl.weeklyTarget)}</td></tr>
      </table>
      <div class="ref-note" style="margin-top:10px">${esc(sl.rule)}</div>
      <div class="ref-note">${esc(sl.weeklyRule)}</div>
      <div class="ref-note">${esc(sl.nonStepCardio)}</div>
      <div class="ref-note">${esc(sl.why)}</div>
    </section>`;
  }

  // ---- desk-job habits
  if (config.habits) {
    html += `<section class="card"><span class="label">Desk habits</span>
      <table class="ref-table">
        ${Object.values(config.habits).map((h) => `<tr><td>${esc(h.text)}<div class="ref-note">${esc(h.why || h.conditional || '')}</div></td>
          <td class="num r">${h.everyMinutes ? `every ${h.everyMinutes} min` : 'conditional'}</td></tr>`).join('')}
      </table>
    </section>`;
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
      ${p.neverGrind ? `<tr><td>Never grind</td><td>${esc(p.neverGrind)}</td></tr>` : ''}
    </table>
    ${config.progressionRules ? `<span class="label" style="display:block;margin-top:14px">By exercise</span>
      <table class="ref-table">
        ${Object.entries(config.progressionRules).map(([key, r]) => {
          const users = Object.values(config.sessions).flatMap((se) => se.exercises).filter((e) => e.progressionKey === key).map((e) => e.name);
          return `<tr><td>${esc(users.join(', ') || key)}<div class="ref-note">${esc(r.note || '')}</div></td>
            <td class="wrap">${esc(r.rule || '')}</td></tr>`;
        }).join('')}
      </table>` : ''}
    ${config.startLoadNote ? `<div class="ref-note" style="margin-top:12px">${esc(config.startLoadNote)}</div>` : ''}
    </section>`;

  // ---- for your clinician ----
  const avg = L.rollingAverage(state.records, t);
  const slope = L.trendSlope(state.records, t);
  const symptomRows = Object.values(state.records)
    .filter((r) => r.checkin && r.checkin.symptom && r.checkin.symptom !== 'None')
    .sort((a, b) => b.date.localeCompare(a.date));
  const measureRows = [...state.measurements].sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  const achRows = L.achillesTimeline(state.records);

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
    ${achRows.length ? `<span class="label" style="display:block;margin-top:14px">Achilles log</span>
      <table class="ref-table">${achRows.map((r) => `<tr><td class="num">${fmtRefDate(r.date)}</td>
        <td${r.answer === 'worse' ? ' class="ref-alert"' : ''}>${r.answer ? `Morning: ${esc(r.answer)}` : 'No morning reading'}
          <div class="ref-note">${r.done ? `Heel raises done${r.load ? ` at ${r.load} lb` : ' at bodyweight'}` : 'Heel raises not logged'}</div></td></tr>`).join('')}</table>`
      : `<span class="label" style="display:block;margin-top:14px">Achilles log</span><div class="ref-note">Nothing logged yet.</div>`}
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
  if (sheet.kind === 'rehab') {
    const cfg = L.rehabConfig(config);
    const load = L.rehabLoad(state.configDoc, state.records, t);
    const used = rec.rehab && rec.rehab.loadUsed != null ? rec.rehab.loadUsed : load.suggested;
    return `<span class="label">Achilles rehab</span><h2>Heel raises</h2>
      <ul class="components">${cfg.movements.map((m) => `<li><span>${esc(m.name)}</span><span class="num">${m.sets} × ${m.reps}</span></li>`).join('')}</ul>
      <div class="ref-note">${esc(cfg.progression)}</div>
      <div class="field"><span class="fl label">Load, ${esc(cfg.loadUnit || 'lb')} (0 is bodyweight)</span>
        <input id="sh-rehab-load" type="text" inputmode="decimal" value="${used != null ? used : ''}" placeholder="0"></div>
      ${load.reduced ? `<div class="ref-note">Suggested down from ${load.from} after a worse morning.</div>` : ''}
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-rehab">Log it</button></div>`;
  }
  if (sheet.kind === 'meal') {
    const meal = L.mealsFor(config, t).find((m) => m.id === sheet.mealId);
    const total = L.mealTotal(meal);
    return `<span class="label">Meal</span><h2>${esc(meal.name)} · <span class="num">${total.cal}</span> cal · <span class="num">${total.protein}</span> g</h2>
      ${meal.estimate ? `<div class="ref-note">Restaurant estimate, ±20%. Order protein-forward.</div>` : ''}
      <ul class="components">${meal.components.map((c) => `<li><span>${esc(c.name)}</span><span class="num">${c.cal} cal · ${c.protein} g</span></li>`).join('')}</ul>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="eaten">Ate the planned meal</button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="modified">Ate something similar<span class="sub">Counts the same toward totals; tracked separately.</span></button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="offplan">Ate off-plan<span class="sub">Low protein, heavy carbs, restaurant food. Counts toward calories and protein; does not count as adherence.</span></button>
      <button class="option-row" data-act="meal-set" data-meal="${meal.id}" data-state="skipped">Skipped it</button>
      <div class="sheet-actions"><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`;
  }
  if (sheet.kind === 'measurements') {
    return `<span class="label">Sunday measurement</span><h2>Blood pressure, skippable</h2>
      <div class="two">
        <div class="field"><span class="fl label">Systolic</span><input id="sh-sys" type="text" inputmode="numeric" placeholder="125"></div>
        <div class="field"><span class="fl label">Diastolic</span><input id="sh-dia" type="text" inputmode="numeric" placeholder="80"></div>
      </div>
      <div class="sheet-actions"><button class="btn quiet" data-act="dismiss-measurements">Not today</button><button class="btn primary" data-act="save-measurements">Save</button></div>`;
  }
  if (sheet.kind === 'settings') {
    const cfg = activeConfig();
    return `<span class="label">Settings</span><h2>Tracker</h2>
      <div class="settings-list">
        <button class="srow" data-act="export">Export backup<span class="sub">days.csv, workouts.csv, measurements.csv, clinician.csv, plan config ${EMDASH} through the share sheet, so it lands in Files or iCloud</span></button>
        <button class="srow" data-act="import">Import backup<span class="sub">Same files back in; idempotent on date and id.</span></button>
        <div class="srow">Plan<span class="sub num">Version ${cfg.planVersion} · ${esc(cfg.label || '')} · effective ${cfg.effectiveFrom}</span></div>
        <div class="srow">Build<span class="sub num">${esc(activeBuild || 'not cached')}</span></div>
        <button class="srow" data-act="movement-breaks">Movement breaks<span class="sub">${state.meta.movementBreaks === false ? 'Off' : 'On'} ${EMDASH} a line on Today every ${(cfg.habits && cfg.habits.movementBreak ? cfg.habits.movementBreak.everyMinutes : 45)} min of sitting. This is a web app: it cannot raise a notification while it is closed, so set three repeating iOS Reminders if you want a buzz.</span></button>
        <div class="srow">Achilles clinician flag<span class="sub">${state.meta.achillesClinicianCleared ? `Marked cleared ${state.meta.achillesClinicianCleared}` : 'Open — the rehab card shows it until you mark it cleared'}</span></div>
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
    rec.workout = { sessionId: (state.logger && state.logger.sessionId) || L.nextLiftId(state.records), sets: {} };
  }
  return rec.workout;
}

// The chin-up card. One phase is shown, never all three: the app works out
// which phase the history puts you in and shows that one's prescription, its
// trigger, and how close the trigger is. Meeting a trigger PROMPTS — the phase
// only moves when the user accepts it.
function chinHeader(chin) {
  if (!chin) return '';
  const c = chin.cfg;
  const pct = (chin.progress * 100).toFixed(1);
  let html = `<div class="phase-head">
    <div class="ex-head"><span class="name">Chin-up ${EMDASH} ${esc(c.name)}</span><span class="scheme num">Phase ${chin.phase}</span></div>
    <div class="ex-cue">${esc(c.prescription)}</div>
    <div class="phase-bar">
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      <div class="of num">${esc(chin.detail || '')} ${EMDASH} trigger: ${esc(c.advanceLabel)}</div>
    </div>`;
  if (chin.met && chin.next) {
    html += `<button class="phase-advance" data-act="chin-advance" data-phase="${chin.next.phase}">
      Trigger met. Move to phase ${chin.next.phase}, ${esc(chin.next.name.toLowerCase())}?</button>`;
  }
  if (chin.dueTest) {
    html += `<div class="ex-cue done">Two weeks since the last test. Try one unassisted chin-up and log it below.</div>`;
  }
  if (c.note) html += `<div class="ref-note">${esc(c.note)}</div>`;
  if (chin.phase === 1 && chin.moraleNote) html += `<div class="ref-note">${esc(chin.moraleNote)}</div>`;
  html += `</div>`;
  return html;
}

// One logged set, in the shape the exercise is actually measured in: load ×
// reps for most, reps alone for bodyweight, seconds for a hold. A bodyweight
// set reads BW rather than 0, which is a weight nobody lifted.
function setRowHtml(e, i, s, prog, editing) {
  const key = `${e.id}:${i}`;
  const entry = e.entry || 'weightReps';
  if (s && !editing) {
    const val = entry === 'seconds'
      ? `${s.reps} s`
      : entry === 'reps' || entry === 'barWork'
        ? `${s.reps} reps`
        : `${s.weight ? s.weight : 'BW'} <span class="x">×</span> ${s.reps}`;
    return `<button class="set-row compact" data-act="edit-set" data-key="${key}">
      <span class="idx num">${i + 1}</span>
      <span class="val num">${val}</span>
    </button>`;
  }
  // The value in the box is a real suggestion, not a placeholder: the plan's
  // seeded start load on a fresh exercise, the progression's number after that.
  const repTarget = prog.reps != null ? prog.reps : e.reps;
  const rVal = s ? s.reps : '';
  if (entry === 'reps' || entry === 'seconds' || entry === 'barWork') {
    return `<div class="set-row" data-key="${key}">
      <span class="idx num">${i + 1}</span>
      <input type="text" inputmode="numeric" class="reps wide" placeholder="${repTarget}" value="${rVal}" aria-label="${entry === 'seconds' ? 'seconds' : 'reps'}">
      <span class="times">${entry === 'seconds' ? 'sec' : 'reps'}</span>
      <button class="save-set" data-act="save-set" data-key="${key}" data-ex="${e.id}">Log</button>
    </div>`;
  }
  const wVal = s ? s.weight : (prog.suggested != null ? prog.suggested : '');
  return `<div class="set-row" data-key="${key}">
    <span class="idx num">${i + 1}</span>
    <input type="text" inputmode="decimal" class="wt" placeholder="${wVal}" value="${wVal}" aria-label="weight">
    <span class="times">×</span>
    <input type="text" inputmode="numeric" class="reps" placeholder="${repTarget}" value="${rVal}" aria-label="reps">
    <button class="save-set" data-act="save-set" data-key="${key}" data-ex="${e.id}">Log</button>
  </div>`;
}

function renderLogger() {
  const t = viewStr();
  const rec = state.records[t] || { workout: null };
  const config = activeConfig();
  const session = config.sessions[state.logger.sessionId];
  const workout = (rec.workout && rec.workout.sessionId === state.logger.sessionId) ? rec.workout : { sets: {}, minutes: undefined };

  // What is actually performed today: the plan's list with the chin-up slot
  // resolved to its phase and any accepted variation applied.
  const exercises = L.sessionExercises(state.configDoc, state.records, state.logger.sessionId, t);
  const chin = L.chinupState(state.configDoc, state.records, t);

  // Progression cues computed against history excluding today.
  const prior = { ...state.records };
  delete prior[t];

  let ex = '';
  let prevPair = null;
  let chinShown = false;
  for (const e of exercises) {
    if (e.phasedFrom === 'chinup' && !chinShown) { ex += chinHeader(chin); chinShown = true; }
    const prog = L.progression(state.configDoc, prior, e.id, e, t);
    const scheme = e.scheme || `${e.sets} × ${e.reps}`;
    const paired = e.pair != null;
    let rows = '';
    for (let i = 0; i < e.sets; i++) {
      const key = `${e.id}:${i}`;
      const s = workout.sets[key];
      const editing = state.editingSet === key;
      rows += setRowHtml(e, i, s, prog, editing);
      if (!s && !editing) break; // one open row at a time per exercise
    }

    // Phase 2 bar work carries a note instead of a load: which band, how many
    // negatives, and the periodic unassisted test that ends the phase.
    let barWork = '';
    if (e.entry === 'barWork') {
      barWork = `<div class="bar-work">
        <div class="field"><span class="fl label">Band or negatives</span>
          <input id="lg-chin-note" type="text" value="${esc(workout.chinBandOrNegatives || '')}" placeholder="green band · or 4 negatives, 5 s down"></div>
        <div class="field"><span class="fl label">Unassisted reps today</span>
          <input id="lg-chin-un" type="text" inputmode="numeric" value="${workout.chinUnassisted != null ? workout.chinUnassisted : ''}" placeholder="0"></div>
        <button class="save-set" data-act="save-chin">Save note</button>
      </div>`;
    }

    // How the set felt, which the logged reps cannot express. Drives what the
    // app suggests next time: hit adds load, grindy holds it, two misses deload.
    const mk = (workout.marks || {})[e.id] || null;
    const markRow = `<div class="mark-row">
      ${[['hit', 'Hit'], ['grindy', 'Grindy'], ['miss', 'Missed']].map(([v, label]) =>
        `<button class="mark ${v}${mk === v ? ' sel' : ''}" data-act="mark-set" data-ex="${e.id}" data-mark="${v}">${label}</button>`).join('')}
    </div>`;

    // A prompt is a change the app will not make on its own. A harder push-up
    // variation is a decision; adding a rep is not.
    let prompt = '';
    if (prog.prompt && prog.prompt.kind === 'variation') {
      prompt = `<button class="phase-advance" data-act="accept-variation" data-ex="${e.id}" data-to="${esc(prog.prompt.to)}">${esc(prog.prompt.label)}</button>`;
    } else if (prog.prompt) {
      prompt = `<div class="ex-cue done">${esc(prog.prompt.label)}</div>`;
    }

    ex += `<div class="exercise${paired ? ' paired' : ''}">
      <div class="ex-head"><span class="name">${esc(e.name)}</span><span class="scheme num">${esc(scheme)}</span></div>
      ${paired && e.pair !== prevPair ? `<div class="pair-tag">Alternate with next${e.rest ? ` · ${esc(e.rest)} rests` : ''}</div>` : ''}
      ${prog.cue ? `<div class="ex-cue${prog.tone === 'done' ? ' done' : ''}">${esc(prog.cue)}</div>` : ''}
      ${e.note ? `<div class="ref-note">${esc(e.note)}</div>` : ''}
      ${rows}
      ${barWork}
      ${prompt}
      ${markRow}
    </div>`;
    prevPair = paired ? e.pair : null;
  }

  const warm = config.warmup || {};
  const warmText = [warm.all, warm[state.logger.sessionId]].filter(Boolean).join(' ');

  return `<div class="logger"><div class="logger-inner">
    <div class="logger-head"><h2>${esc(session.name)}</h2><button class="close" data-act="close-logger">Close</button></div>
    ${warmText ? `<div class="warmup"><span class="label">Warm-up</span><div class="ref-note">${esc(warmText)}</div></div>` : ''}
    ${ex}
    ${session.note ? `<div class="ref-note session-note">${esc(session.note)}</div>` : ''}
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

// Backup files. The clinician timeline ships with them: its whole value is
// being complete and handable to someone else.
function exportFiles() {
  const stamp = todayStr();
  return [
    { name: `days-${stamp}.csv`, text: L.daysToCsv(state.records), type: 'text/csv' },
    { name: `workouts-${stamp}.csv`, text: L.workoutsToCsv(state.records), type: 'text/csv' },
    { name: `measurements-${stamp}.csv`, text: L.measurementsToCsv(state.measurements), type: 'text/csv' },
    { name: `clinician-${stamp}.csv`, text: L.clinicianToCsv(state.records), type: 'text/csv' },
    { name: `plan-${stamp}.json`, text: JSON.stringify(state.configDoc, null, 2), type: 'application/json' },
  ];
}

// Out through the iOS share sheet where it exists, so the backup lands in
// Files or iCloud rather than in the app's own sandbox — which is exactly the
// storage the backup is insurance against. A plain download is the fallback.
async function doExport() {
  const specs = exportFiles();
  let shared = false;
  try {
    const files = specs.map((f) => new File([f.text], f.name, { type: f.type }));
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: 'Tracker backup' });
      shared = true;
    }
  } catch (e) {
    // A cancelled share is not a failure, but it is not a backup either.
    if (e && e.name === 'AbortError') return;
  }
  if (!shared) for (const f of specs) download(f.name, f.text, f.type);
  state.meta.lastExport = todayStr();
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
      } else if (id === 'rehab') {
        document.getElementById('sec-rehab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      mutate(() => {
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

    // ---- Achilles rehab (§9)
    case 'rehab-toggle': mutate(() => {
      const rec = getRec();
      rec.rehab = rec.rehab || {};
      rec.rehab.heelRaisesDone = !rec.rehab.heelRaisesDone;
      // The load that was actually used is the point of the log, so a card
      // ticked without opening the sheet records the suggested one rather
      // than leaving the session with no load at all.
      if (rec.rehab.heelRaisesDone && rec.rehab.loadUsed == null) {
        const load = L.rehabLoad(state.configDoc, state.records, t);
        if (load) rec.rehab.loadUsed = load.suggested;
      }
    }); break;
    case 'save-rehab': {
      const v = parseFloat(document.getElementById('sh-rehab-load').value);
      mutate(() => {
        const rec = getRec();
        rec.rehab = rec.rehab || {};
        rec.rehab.loadUsed = isNaN(v) ? 0 : v;
        rec.rehab.heelRaisesDone = true;
        state.sheet = null;
      });
      break;
    }
    case 'achilles': mutate(() => {
      const rec = getRec();
      rec.checkin = rec.checkin || {};
      rec.checkin.achilles = rec.checkin.achilles === el.dataset.val ? undefined : el.dataset.val;
    }); break;
    // Not a dismissal: the flag comes down only by recording that a clinician
    // has actually looked at it.
    case 'achilles-cleared': mutate(() => { state.meta.achillesClinicianCleared = todayStr(); }); break;

    // ---- chin-up phases (§6.2): the app prompts, the user advances
    case 'chin-advance': {
      const to = Number(el.dataset.phase);
      mutate(() => {
        const w = ensureWorkout();
        w.chinPhase = to;
      });
      break;
    }
    case 'save-chin': {
      const note = document.getElementById('lg-chin-note').value.trim();
      const un = parseInt(document.getElementById('lg-chin-un').value, 10);
      mutate(() => {
        const w = ensureWorkout();
        if (note) w.chinBandOrNegatives = note; else delete w.chinBandOrNegatives;
        if (!isNaN(un)) w.chinUnassisted = un; else delete w.chinUnassisted;
      });
      break;
    }
    case 'accept-variation': {
      const exId = el.dataset.ex;
      const to = el.dataset.to;
      mutate(() => {
        const w = ensureWorkout();
        if (!w.variants) w.variants = {};
        w.variants[exId] = to;
      });
      break;
    }

    case 'movement-breaks': mutate(() => {
      state.meta.movementBreaks = state.meta.movementBreaks === false;
    }); break;

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
      // What is offered wins, because that is the name on the button that was
      // just tapped; offeredSession already yields to a workout started on this
      // day. The record is the fallback only where no lift is offered at all —
      // an orphan, reachable now that a logged workout opens from any day.
      const sessionId = offered.sessionId
        || (rec && rec.workout && rec.workout.sessionId)
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
  // No weight box means the exercise carries no load: bodyweight reps, or a
  // hold measured in seconds. It logs as 0 rather than refusing to save.
  const wt = wtInput ? parseFloat(wtInput.value || wtInput.placeholder) : 0;
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

  // The demo needs three weeks of history behind it, so it back-dates day 1.
  // The real plan's start date is never touched; ?demo persists nothing.
  if (DEMO) state.configDoc = { ...state.configDoc, programStart: L.addDays(todayStr(), -20) };

  if (window.caches) {
    try {
      const keys = await caches.keys();
      activeBuild = keys.find((k) => k.startsWith('tracker-')) || null;
    } catch { /* private mode or no cache API — Settings shows "not cached" */ }
  }

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
    // A new build installs in the background and only takes effect on the open
    // AFTER this one, so a shipped fix looks like it never shipped. Reload once
    // when the new worker takes control. Skipped on first install (nothing to
    // replace) and while a sheet or the logger is open, since those hold typed
    // values that autosave has not seen yet.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || state.logger || state.sheet) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
