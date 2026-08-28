// Pure business logic. No DOM, no storage. Everything here is a function of
// (records, measurements, config, date/time). Tested in tests/logic.test.mjs.

export const SCHEMA_VERSION = 2;

// ---------- dates ----------

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function weekday(dateStr) {
  return parseDate(dateStr).getDay();
}

// ---------- config resolution ----------

// Active config version for a date: latest version with effectiveFrom <= date.
// Ties on effectiveFrom break on planVersion, so a revision that supersedes an
// earlier version from the same date wins explicitly rather than by relying on
// sort stability or array order.
export function configFor(configDoc, dateStr) {
  const eligible = configDoc.versions
    .filter((v) => v.effectiveFrom <= dateStr)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.planVersion - b.planVersion);
  return eligible[eligible.length - 1] || configDoc.versions[0];
}

export function configByVersion(configDoc, planVersion) {
  return (
    configDoc.versions.find((v) => v.planVersion === planVersion) ||
    configDoc.versions[configDoc.versions.length - 1]
  );
}

// Program day 1. An explicit top-level `programStart` wins, so restarting the
// program is one date in one place; without it, day 1 falls back to the
// earliest effectiveFrom. A restart must not require back-dating old versions,
// which would misstate when they were actually in force.
export function programStart(configDoc) {
  return configDoc.programStart || configDoc.versions
    .map((v) => v.effectiveFrom)
    .sort()[0];
}

export function programDay(configDoc, dateStr) {
  return daysBetween(programStart(configDoc), dateStr) + 1;
}

export function programWeek(configDoc, dateStr) {
  return Math.floor((programDay(configDoc, dateStr) - 1) / 7) + 1;
}

export function phaseFor(config, week) {
  return (config.phases || []).find((p) => p.weeks.includes(week)) || null;
}

// The weekday entry for a date: per-day calorie/protein targets, dinner
// overrides, day-specific modifiers. Absent on plans whose menu is the same
// every day, so every caller must tolerate {}.
export function weekdayPlan(config, dateStr) {
  return (config.weekdays || {})[String(weekday(dateStr))] || {};
}

// The meals eaten on a given weekday: the fixed daily blocks with that day's
// override applied. `add` puts the day's own items at the FRONT of the block
// (the weekday dinner protein, ahead of the fixed sides) because the thing that
// changes daily is the thing worth reading first, and every preview of a meal
// shows its opening components. `components` replaces the block outright (a
// restaurant dinner, where the fixed sides are not eaten at all). Keyed by
// weekday so the Reference tab, which describes the plan rather than any
// particular date, can use it too.
export function mealsForWeekday(config, wd) {
  const ov = ((config.weekdays || {})[String(wd)] || {}).meals;
  if (!ov) return config.meals;
  return config.meals.map((m) => {
    const o = ov[m.id];
    if (!o) return m;
    const out = { ...m, ...o };
    out.components = o.components || m.components;
    if (o.add) out.components = [...o.add, ...out.components];
    delete out.add;
    return out;
  });
}

export function mealsFor(config, dateStr) {
  return mealsForWeekday(config, weekday(dateStr));
}

// The day's plan: schedule entry (with phase overrides), day type, targets.
export function dayPlan(configDoc, dateStr) {
  const config = configFor(configDoc, dateStr);
  const week = programWeek(configDoc, dateStr);
  const phase = phaseFor(config, week);
  const wd = String(weekday(dateStr));
  let sched = config.schedule[wd] || { type: 'rest' };
  let suppressed = false;
  if (phase && phase.scheduleOverrides && phase.scheduleOverrides[wd]) {
    const o = phase.scheduleOverrides[wd];
    suppressed = !!o.suppressed;
    sched = { ...o };
  }
  const dt = config.dayTypes[sched.type] || config.dayTypes.rest;
  const wdp = weekdayPlan(config, dateStr);
  // Protein is a weekly average, so the day target and the weekly target are
  // two different numbers and must never be collapsed: no single day is
  // supposed to hit 180 g, the week is.
  const weeklyProtein = config.targets.proteinWeeklyAvg != null
    ? config.targets.proteinWeeklyAvg
    : config.targets.proteinFloor;
  return {
    config,
    week,
    phase,
    schedule: sched,
    type: sched.type,
    suppressed,
    calorieTarget: wdp.calorieTarget != null ? wdp.calorieTarget : dt.calorieTarget,
    mealModifiers: [...(dt.mealModifiers || []), ...(wdp.mealModifiers || [])],
    stepTarget: (phase && phase.stepTarget) || config.targets.stepTarget,
    sleepTargetMinutes: config.targets.sleepTargetMinutes,
    proteinTarget: wdp.proteinTarget != null ? wdp.proteinTarget : weeklyProtein,
    proteinWeeklyAvg: weeklyProtein,
    proteinFloor: weeklyProtein,
  };
}

// ---------- nutrition ----------

export function mealTotal(meal) {
  return meal.components.reduce(
    (a, c) => ({ cal: a.cal + c.cal, protein: a.protein + c.protein }),
    { cal: 0, protein: 0 }
  );
}

// Calories/protein for a day record, computed against the config version in
// force when it was recorded (§6.3).
export function dayNutrition(configDoc, record) {
  const config = configByVersion(configDoc, record.planVersion);
  let cal = 0, protein = 0;
  // 'offplan' is food eaten that departed from the plan. It counts toward the
  // day's totals — a meal was eaten — but never toward adherence (§weekStats),
  // which is the signal the weekly recommendation acts on.
  const ate = (id) => {
    const s = record.meals && record.meals[id];
    return s === 'eaten' || s === 'modified' || s === 'offplan';
  };
  for (const meal of mealsFor(config, record.date)) {
    if (ate(meal.id)) {
      const t = mealTotal(meal);
      cal += t.cal;
      protein += t.protein;
    }
  }
  // Day-type modifiers: optional ones are user-toggled (persisted on the
  // record); non-optional ones are derived — applied automatically when their
  // target meal was eaten. Persist only what the user entered (§6.1).
  const dtModIds = new Set(dayPlan(configDoc, record.date).mealModifiers);
  for (const mod of config.mealModifiers || []) {
    const active = mod.optional
      ? record.modifiers && record.modifiers[mod.id]
      : dtModIds.has(mod.id) && (!mod.appliesTo || ate(mod.appliesTo));
    if (active) {
      cal += mod.cal;
      protein += mod.protein;
    }
  }
  return { cal, protein };
}

// ---------- weight ----------

function weightsInWindow(records, endDate, windowDays) {
  const start = addDays(endDate, -(windowDays - 1));
  return Object.values(records)
    .filter((r) => r.weight != null && r.date >= start && r.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, weight: r.weight }));
}

// 7-day rolling average ending on endDate (average of available raw weights).
export function rollingAverage(records, endDate, windowDays = 7) {
  const pts = weightsInWindow(records, endDate, windowDays);
  if (!pts.length) return null;
  return pts.reduce((a, p) => a + p.weight, 0) / pts.length;
}

// Least-squares slope over raw weights in the trailing `windowDays`,
// expressed in lb/week. Requires >= 4 points (§7.4).
export function trendSlope(records, endDate, windowDays = 21) {
  const pts = weightsInWindow(records, endDate, windowDays);
  if (pts.length < 4) return null;
  const xs = pts.map((p) => daysBetween(pts[0].date, p.date));
  const ys = pts.map((p) => p.weight);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 7; // lb/day -> lb/week
}

// Series for the trend plot: for each day in the window, raw weight (if any)
// and rolling average (if any weights exist in its trailing 7 days).
export function trendSeries(records, endDate, windowDays = 21) {
  const out = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = addDays(endDate, -i);
    const rec = records[date];
    out.push({
      date,
      weight: rec && rec.weight != null ? rec.weight : null,
      avg: rollingAverage(records, date),
    });
  }
  return out;
}

// ---------- sessions and scheduling (§8.1) ----------

function completedWorkouts(records) {
  return Object.values(records)
    .filter((r) => r.workout && r.workout.completedAt)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Whichever of A/B was not completed most recently.
export function nextLiftId(records) {
  const done = completedWorkouts(records);
  if (!done.length) return 'liftA';
  const last = done[done.length - 1].workout.sessionId;
  return last === 'liftA' ? 'liftB' : 'liftA';
}

// Which lift a given day is on. A workout already started or finished on that
// day owns it; the A/B alternation only decides a day with nothing on it yet.
// An empty shell (logger opened, then backed out of) is not "started" and must
// not own the day, or a stale shell keeps offering a session already done.
export function liftIdFor(records, dateStr) {
  const w = records[dateStr] && records[dateStr].workout;
  const started = w && w.sessionId && (w.completedAt || Object.keys(w.sets || {}).length);
  return started ? w.sessionId : nextLiftId(records);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Most recent scheduled, non-suppressed lift day strictly before dateStr that
// has no completed workout. Used only for the "Pushed from X" label.
export function missedLiftDayBefore(configDoc, records, dateStr, lookback = 6) {
  for (let i = 1; i <= lookback; i++) {
    const d = addDays(dateStr, -i);
    if (d < programStart(configDoc)) break;
    const plan = dayPlan(configDoc, d);
    if (plan.type === 'lift' && !plan.suppressed) {
      const rec = records[d];
      if (rec && rec.workout && rec.workout.completedAt) return null;
      return d;
    }
  }
  return null;
}

// What the app offers today. The calendar proposes the kind; completion
// decides which lift. Tuesday may substitute a missed Monday lift in place of
// Zone 2. Never a lift on Friday.
export function offeredSession(configDoc, records, dateStr) {
  const plan = dayPlan(configDoc, dateStr);
  const wd = weekday(dateStr);

  if (plan.type === 'lift') {
    const sessionId = liftIdFor(records, dateStr);
    const missed = missedLiftDayBefore(configDoc, records, dateStr);
    return {
      kind: 'lift',
      sessionId,
      pushedFrom: missed ? DAY_NAMES[weekday(missed)] : null,
      plan,
    };
  }

  // Tuesday substitution: Monday's lift missed -> offer it in place of Zone 2,
  // trading the cheapest session while preserving Wednesday's separation.
  // Friday never offers a lift.
  if (plan.type === 'cardio' && wd === 2 && !plan.suppressed) {
    const yesterday = addDays(dateStr, -1);
    const yPlan = dayPlan(configDoc, yesterday);
    const yRec = records[yesterday];
    const yDone = yRec && yRec.workout && yRec.workout.completedAt;
    const tRec = records[dateStr];
    const alreadyCardio = tRec && tRec.cardio && tRec.cardio.completedAt;
    if (yPlan.type === 'lift' && !yPlan.suppressed && !yDone && !alreadyCardio) {
      return {
        kind: 'lift',
        sessionId: liftIdFor(records, dateStr),
        pushedFrom: DAY_NAMES[weekday(yesterday)],
        substituted: true,
        plan,
      };
    }
  }

  if (plan.type === 'cardio' || plan.type === 'walk') {
    return {
      kind: plan.type,
      mode: plan.schedule.mode || 'walk',
      minutes: plan.schedule.minutes,
      optional: !!plan.schedule.optional,
      prescription: plan.schedule.prescription || null,
      plan,
    };
  }
  return { kind: 'rest', plan };
}

// ---------- load progression (§8.2) ----------

// Per-exercise session history: [{date, sets:[{weight,reps}]}] oldest-first.
export function exerciseHistory(records, exerciseId) {
  const out = [];
  for (const r of completedWorkouts(records)) {
    const sets = [];
    for (const [key, s] of Object.entries(r.workout.sets || {})) {
      const [id, idx] = key.split(':');
      if (id === exerciseId) sets[Number(idx)] = s;
    }
    const logged = sets.filter(Boolean);
    const mark = (r.workout.marks || {})[exerciseId];
    if (logged.length) out.push({ date: r.date, sets, logged, mark: mark || null });
  }
  return out;
}

function allRepsHit(session, exCfg) {
  if (session.logged.length < exCfg.sets) return false;
  return session.logged.every((s) => s.reps >= exCfg.reps);
}

export const MARKS = ['hit', 'grindy', 'miss'];

// How a past session resolved. An explicit mark always wins; without one the
// outcome is inferred from reps, which is what every pre-mark session has.
//
// 'grindy' exists because it cannot be inferred: the reps were all completed,
// so it is indistinguishable from a clean set in the logged numbers. It is a
// success that does not advance — it holds the load rather than adding to it,
// and it never counts toward a deload.
function outcomeOf(session, exCfg) {
  if (MARKS.includes(session.mark)) return session.mark;
  return allRepsHit(session, exCfg) ? 'hit' : 'miss';
}

function sessionLoad(session) {
  return Math.max(...session.logged.map((s) => s.weight));
}

function roundTo(v, step) {
  return Math.round(v / step) * step;
}

// Rounding is per-exercise where the plan calls for smaller jumps than the bar
// math elsewhere allows: a 2.5 lb press increment rounded to the nearest 5
// silently becomes a 5 lb increment.
function roundStep(exCfg, p) {
  return exCfg.roundToNearest != null ? exCfg.roundToNearest : p.roundToNearest;
}

// The jump to add after a successful session. Some lifts taper: the deadlift
// climbs 10 lb a week until it gets heavy, then 5. `taperAbove` is the load at
// which the smaller increment takes over.
function incrementFor(exCfg, load, p) {
  if (exCfg.taperAbove != null && exCfg.taperIncrement != null && load >= exCfg.taperAbove) {
    return exCfg.taperIncrement;
  }
  return exCfg.increment != null ? exCfg.increment : p.roundToNearest;
}

// The rule that governs an exercise. Rules are config, not code: a plan that
// progresses a lift by reps first, or by variation, or by a coach's eye, says
// so in `progressionRules` and the engine reads it. Absent a key, load.
export function progressionRule(config, exCfg) {
  const rules = config.progressionRules || {};
  return rules[(exCfg || {}).progressionKey] || { type: 'load' };
}

// Reps completed on the lightest set of a session — the rep target a session
// actually delivered on every set, which is what a rep ladder advances off.
function minReps(session) {
  return session.logged.length ? Math.min(...session.logged.map((s) => s.reps)) : 0;
}

function fullSets(session, exCfg) {
  return session.logged.length >= exCfg.sets;
}

// The rung of a rep ladder a session cleared: the highest listed value every
// set met. Below the first rung, the ladder has not started.
function ladderRung(ladder, reps) {
  let out = null;
  for (const r of ladder) if (reps >= r) out = r;
  return out;
}

function nextLadder(ladder, rung) {
  const i = ladder.indexOf(rung);
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : null;
}

// Returns { suggested, reps, cue, tone, prompt } — a suggestion, never enforced.
// `suggested` is the load and is null where the exercise carries none.
// `reps` is the rep (or second) target for the next session.
// `prompt` is a change the app will not make on its own — a harder push-up
// variation, load on a bodyweight lift — offered for the user to accept.
export function progression(configDoc, records, exerciseId, exCfg, todayStr) {
  const config = configFor(configDoc, todayStr);
  const p = config.progression;
  const rule = progressionRule(config, exCfg);
  const step = roundStep(exCfg, p);
  // Whether the exercise is measured in load at all. Bodyweight reps and timed
  // holds are not, and the load machinery — layoff, deload, the increment —
  // has nothing to act on. It is the entry shape that decides this, not
  // whether the plan happened to seed a starting weight.
  const carriesLoad = (exCfg.entry || 'weightReps') === 'weightReps';
  const defaults = { suggested: null, reps: exCfg.reps, cue: null, tone: 'none', prompt: null };

  // Loads restart when the program restarts. Sessions from a previous block
  // are kept (they are still history, still exported) but they no longer set
  // today's load, or a restart would silently resume at the old weights
  // instead of the plan's seeded start loads.
  const hist = exerciseHistory(records, exerciseId)
    .filter((s) => s.date >= programStart(configDoc));

  // No history: the seeded start load from the plan. A blank field asks the
  // user to invent a number at the moment they are least able to judge it.
  if (!hist.length) {
    if (!carriesLoad || exCfg.startWeight == null) {
      return { ...defaults, cue: `Starting point — ${exCfg.startLabel || exScheme(exCfg)}`, tone: 'neutral' };
    }
    return {
      ...defaults,
      suggested: exCfg.startWeight,
      cue: `Starting weight — ${exCfg.startLabel || `${exCfg.startWeight} ${exCfg.unit}`}`,
      tone: 'neutral',
    };
  }

  const last = hist[hist.length - 1];
  const lastLoad = sessionLoad(last);
  const lastOutcome = outcomeOf(last, exCfg);
  const lastReps = minReps(last);
  const unit = exCfg.unit || 'lb';

  // Heaviest load carried for all prescribed reps. Grindy counts: the reps were
  // completed, it just cost everything to do it.
  let lastSuccess = null;
  for (const s of hist) {
    if (outcomeOf(s, exCfg) !== 'miss') {
      const load = sessionLoad(s);
      if (lastSuccess === null || load > lastSuccess) lastSuccess = load;
    }
  }

  // Layoff and deload govern every exercise that carries a load, whatever
  // shape its progression takes on top.
  if (carriesLoad) {
    const gap = daysBetween(last.date, todayStr);
    if (gap > p.layoffDays && lastSuccess !== null) {
      const suggested = roundTo(lastSuccess * p.layoffFactor, step);
      return { ...defaults, suggested, reps: lastReps || exCfg.reps, cue: `It's been ${gap} days — start at ${suggested} ${unit}`, tone: 'neutral' };
    }

    // Misses count only at >= the user's own last successful load (§8.2).
    // Attempts above lastSuccess that fail are ambition, not failure; attempts
    // below it neither count nor break the streak.
    let misses = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      const s = hist[i];
      if (outcomeOf(s, exCfg) !== 'miss') break;
      if (lastSuccess === null || sessionLoad(s) >= lastSuccess) {
        if (lastSuccess !== null && sessionLoad(s) > lastSuccess) continue; // over-reach: skip
        misses++;
      }
    }
    if (lastSuccess !== null && misses >= p.consecutiveMissesBeforeDeload) {
      const suggested = roundTo(lastSuccess * p.deloadFactor, step);
      return { ...defaults, suggested, cue: `${misses} misses — drop to ${suggested} ${unit} and rebuild`, tone: 'neutral' };
    }
  }

  const hold = (cue) => ({ ...defaults, suggested: carriesLoad ? lastLoad : null, reps: lastReps || exCfg.reps, cue, tone: 'neutral' });

  if (lastOutcome === 'grindy') {
    return hold(carriesLoad
      ? `Ground it out at ${lastLoad} ${unit} — run it again`
      : `Ground it out at ${lastReps} — run it again`);
  }

  switch (rule.type) {
    // Reps first, then load: 8 → 9 → 10, then the increment and back to 8.
    case 'repsThenLoad': {
      const from = rule.repFrom != null ? rule.repFrom : exCfg.reps;
      const to = rule.repTo != null ? rule.repTo : exCfg.reps;
      if (lastOutcome === 'miss') return hold(`Missed at ${lastLoad} ${unit} × ${lastReps || exCfg.reps} — repeat it`);
      if (fullSets(last, exCfg) && lastReps >= to) {
        const suggested = roundTo(lastLoad + incrementFor(exCfg, lastLoad, p), step);
        return { ...defaults, suggested, reps: from, cue: `${last.logged.length} × ${to} clean — go ${suggested} ${unit}, back to ${from} reps`, tone: 'done' };
      }
      const reps = Math.min(to, (lastReps || from) + 1);
      return { ...defaults, suggested: lastLoad, reps, cue: `Add a rep — ${lastLoad} ${unit} × ${reps}`, tone: 'done' };
    }

    // Bodyweight reps to a ceiling, then a harder variation. Never more reps
    // past the ceiling: the answer to easy push-ups is leverage, not volume.
    case 'repsThenVariation': {
      const from = rule.repFrom != null ? rule.repFrom : exCfg.reps;
      const to = rule.repTo != null ? rule.repTo : exCfg.reps;
      const vars = rule.variations || [];
      const at = vars.indexOf(exCfg.variation || vars[0]);
      if (lastOutcome === 'miss') return hold(`Missed at ${lastReps} — repeat it`);
      if (fullSets(last, exCfg) && lastReps >= to) {
        const next = at >= 0 && at < vars.length - 1 ? vars[at + 1] : null;
        return {
          ...defaults,
          reps: from,
          cue: `${last.logged.length} × ${to} clean — that's the ceiling`,
          tone: 'done',
          prompt: next ? { kind: 'variation', to: next, label: `Move to ${next.toLowerCase()}, back to ${from} reps` } : null,
        };
      }
      const reps = Math.min(to, (lastReps || from) + 1);
      return { ...defaults, reps, cue: `Add a rep — ${last.logged.length || exCfg.sets} × ${reps}`, tone: 'done' };
    }

    // A fixed bodyweight ladder, then load. Regresses a rung on a miss, which
    // is the whole point on a lift that answers to the back.
    case 'repLadder': {
      const ladder = rule.ladder || [exCfg.reps];
      const rung = ladderRung(ladder, lastReps) || ladder[0];
      if (lastOutcome === 'miss') {
        const i = ladder.indexOf(rung);
        const back = i > 0 ? ladder[i - 1] : ladder[0];
        return { ...defaults, suggested: carriesLoad ? lastLoad : null, reps: back, cue: `Back to ${last.logged.length || exCfg.sets} × ${back}${rule.note ? ` — ${rule.note.toLowerCase()}` : ''}`, tone: 'neutral' };
      }
      if (!fullSets(last, exCfg) || lastReps < rung) return hold(`Repeat ${exCfg.sets} × ${rung}`);
      const next = nextLadder(ladder, rung);
      if (next) return { ...defaults, suggested: carriesLoad ? lastLoad : null, reps: next, cue: `${exCfg.sets} × ${rung} clean — go ${exCfg.sets} × ${next}`, tone: 'done' };
      return {
        ...defaults,
        suggested: carriesLoad ? lastLoad : null,
        reps: rung,
        cue: carriesLoad
          ? `${exCfg.sets} × ${rung} — the ladder is finished`
          : `${exCfg.sets} × ${rung} at bodyweight — the ladder is finished`,
        tone: 'done',
        prompt: rule.thenLoad ? { kind: 'load', to: rule.thenLoad, label: `Add ${rule.thenLoad} lb and drop back to ${exCfg.sets} × ${ladder[0]}` } : null,
      };
    }

    // Judged by eye, not by a rep count. The app holds the load and states the
    // gate; a session marked Hit is the user saying the gate was cleared.
    case 'subjective': {
      if (lastOutcome !== 'hit') return hold(carriesLoad ? `Last time ${lastLoad} ${unit} — repeat it` : `Last time ${lastReps} ${unit === 'sec' ? 's' : ''} — repeat it`);
      if (carriesLoad) {
        const suggested = roundTo(lastLoad + incrementFor(exCfg, lastLoad, p), step);
        return { ...defaults, suggested, cue: `${suggested} ${unit} — ${rule.rule || 'only if it stays clean'}`, tone: 'done' };
      }
      const reps = lastReps + (rule.increment || 5);
      return { ...defaults, reps, cue: `${reps}${unit === 'sec' ? ' s' : ''} — ${rule.rule || 'only if it stays easy'}`, tone: 'done' };
    }

    // Bar work in chin-up phase 2: negatives or a band, logged as a note. There
    // is no number to progress — the band gets thinner, which the user judges.
    case 'chinBar':
      return { ...defaults, reps: lastReps || exCfg.reps, cue: 'Thinner band or slower negatives than last time', tone: 'neutral' };

    // Chin-up phase 3: one more rep anywhere across the three sets.
    case 'chinReps': {
      if (lastOutcome === 'miss') return hold(`Repeat ${last.logged.map((s) => s.reps).join('/')}`);
      const total = last.logged.reduce((a, s) => a + s.reps, 0);
      return { ...defaults, reps: lastReps, cue: `${last.logged.map((s) => s.reps).join('/')} last time, ${total} total — add one rep anywhere`, tone: 'done' };
    }

    default: {
      // Plain load progression. `cleanSessionsBeforeAdvance` holds the load
      // until it has been carried cleanly more than once, which is what the
      // plan asks for on the glute and hamstring work.
      if (lastOutcome !== 'hit') return hold(`Last time ${lastLoad} ${unit} — repeat it`);
      const need = rule.cleanSessionsBeforeAdvance || 1;
      if (need > 1) {
        let clean = 0;
        for (let i = hist.length - 1; i >= 0; i--) {
          const s = hist[i];
          if (outcomeOf(s, exCfg) === 'hit' && sessionLoad(s) === lastLoad) clean++;
          else break;
        }
        if (clean < need) {
          return hold(`${clean} clean session${clean === 1 ? '' : 's'} at ${lastLoad} ${unit} — one more before it moves`);
        }
      }
      const suggested = roundTo(lastLoad + incrementFor(exCfg, lastLoad, p), step);
      return { ...defaults, suggested, cue: `All reps hit last time — go ${suggested} ${unit}`, tone: 'done' };
    }
  }
}

// Sets × reps as the plan writes it. Lives here rather than in the UI because
// the progression cues quote it.
export function exScheme(e) {
  return e.scheme || `${e.sets} × ${e.reps}`;
}

// ---------- chin-up phases (§6.2) ----------

export function chinupConfig(config) {
  return config.chinup || null;
}

// The phase in force. Read from what the user accepted, never inferred from
// performance: meeting a trigger prompts, it does not advance.
export function chinupPhase(configDoc, records, dateStr) {
  const config = configFor(configDoc, dateStr);
  const phases = (chinupConfig(config) || {}).phases || [];
  if (!phases.length) return 0;
  const start = programStart(configDoc);
  let ph = 1;
  for (const r of Object.values(records)) {
    if (r.date > dateStr || r.date < start) continue;
    const p = r.workout && r.workout.chinPhase;
    if (p && p > ph) ph = p;
  }
  return Math.min(ph, phases.length);
}

// Everything the chin-up card needs: the active phase, its exercises, how far
// along its trigger is, and whether the trigger has been met.
export function chinupState(configDoc, records, dateStr) {
  const config = configFor(configDoc, dateStr);
  const chin = chinupConfig(config);
  if (!chin || !(chin.phases || []).length) return null;
  const phase = chinupPhase(configDoc, records, dateStr);
  const cfg = chin.phases.find((p) => p.phase === phase) || chin.phases[0];
  const adv = cfg.advance || {};
  const start = programStart(configDoc);
  const histFor = (id) => exerciseHistory(records, id).filter((s) => s.date >= start && s.date <= dateStr);

  let current = 0, target = null, met = false, detail = null, dueTest = false, lastNote = null;

  if (adv.kind === 'load') {
    target = adv.target;
    const need = adv.reps != null ? adv.reps : 8;
    for (const s of histFor(adv.exerciseId)) {
      if (s.logged.length && s.logged.every((x) => x.reps >= need)) {
        current = Math.max(current, sessionLoad(s));
      }
    }
    met = current >= target;
    detail = `${current || 0} of ${target} lb`;
  } else if (adv.kind === 'unassisted') {
    target = adv.target != null ? adv.target : 1;
    let lastTest = null;
    for (const r of Object.values(records)) {
      if (r.date > dateStr || r.date < start) continue;
      const w = r.workout;
      if (!w) continue;
      if (w.chinUnassisted != null) {
        current = Math.max(current, w.chinUnassisted);
        if (!lastTest || r.date > lastTest) lastTest = r.date;
      }
      if (w.chinBandOrNegatives && (!lastNote || r.date >= lastNote.date)) {
        lastNote = { date: r.date, text: w.chinBandOrNegatives };
      }
    }
    met = current >= target;
    dueTest = !met && (!lastTest || daysBetween(lastTest, dateStr) >= (cfg.testEveryDays || 14));
    detail = current ? `${current} unassisted logged` : 'no unassisted rep logged yet';
  } else if (adv.kind === 'reps') {
    const perSet = adv.perSet != null ? adv.perSet : 8;
    target = perSet;
    const h = histFor(adv.exerciseId);
    const lastS = h[h.length - 1];
    const prevS = h[h.length - 2];
    if (lastS) {
      current = Math.min(...lastS.logged.map((s) => s.reps));
      const total = lastS.logged.reduce((a, s) => a + s.reps, 0);
      const prevTotal = prevS ? prevS.logged.reduce((a, s) => a + s.reps, 0) : null;
      detail = `${lastS.logged.map((s) => s.reps).join('/')} last time, ${total} total${prevTotal != null ? ` (was ${prevTotal})` : ''}`;
      met = lastS.logged.length >= 3 && current >= perSet;
    } else {
      detail = 'nothing logged yet';
    }
  }

  const progress = target ? Math.max(0, Math.min(1, current / target)) : 0;
  const next = chin.phases.find((p) => p.phase === phase + 1) || null;
  return { phase, cfg, next, current, target, progress, met, detail, dueTest, lastNote, moraleNote: chin.moraleNote };
}

// The exercises actually performed in a session on a given day: the plan's
// list with any phased slot expanded to the phase in force. Everything
// downstream keys off real exercise ids, so history survives a phase change.
export function sessionExercises(configDoc, records, sessionId, dateStr) {
  const config = configFor(configDoc, dateStr);
  const session = config.sessions[sessionId];
  if (!session) return [];
  const out = [];
  for (const e of session.exercises) {
    if (e.phased === 'chinup') {
      const st = chinupState(configDoc, records, dateStr);
      if (!st) continue;
      for (const pe of st.cfg.exercises) out.push(withVariant(records, { ...pe, phasedFrom: 'chinup', phase: st.phase, rest: pe.rest || e.rest }, dateStr));
    } else {
      out.push(withVariant(records, e, dateStr));
    }
  }
  return out;
}

// A harder variation the user accepted (feet-elevated push-ups, say). It is
// logged history, not settings: the app proposes it, accepting writes it to
// that day's workout, and every later session reads the most recent one.
export function exerciseVariant(records, exerciseId, dateStr) {
  let best = null;
  for (const r of Object.values(records)) {
    if (r.date > dateStr) continue;
    const v = r.workout && r.workout.variants && r.workout.variants[exerciseId];
    if (v && (!best || r.date >= best.date)) best = { date: r.date, variant: v };
  }
  return best ? best.variant : null;
}

function withVariant(records, e, dateStr) {
  const v = exerciseVariant(records, e.id, dateStr);
  return v ? { ...e, name: v, variation: v } : e;
}

// ---------- Achilles rehab (§9) ----------

export function rehabConfig(config) {
  return (config.rehab && config.rehab.achilles) || null;
}

export function rehabDone(records, dateStr) {
  const r = records[dateStr];
  return !!(r && r.rehab && r.rehab.heelRaisesDone);
}

export function achillesAnswer(records, dateStr) {
  const r = records[dateStr];
  return (r && r.checkin && r.checkin.achilles) || null;
}

// The most recent morning reading, today's first. It governs today's rehab
// load: the exercise is judged by the next morning, not by how it felt.
export function achillesLatest(records, dateStr, lookback = 3) {
  for (let i = 0; i < lookback; i++) {
    const d = addDays(dateStr, -i);
    const a = achillesAnswer(records, d);
    if (a) return { date: d, answer: a };
  }
  return null;
}

// A 'worse' morning is a pull-back, and the order matters: the load-bearing
// sessions come down before the rehab does, or the tendon loses the one thing
// that is actually rebuilding it.
export function achillesPullBack(configDoc, records, dateStr) {
  const cfg = rehabConfig(configFor(configDoc, dateStr));
  const latest = achillesLatest(records, dateStr);
  if (!cfg || !latest || latest.answer !== 'worse') return null;
  return { since: latest.date, text: cfg.worseResponse, order: cfg.pullBackOrder || [] };
}

// Suggested heel-raise load: what was last used, held back a step when the
// morning reading came in worse. Under-set beats over-set here — an irritated
// tendon loaded too fast costs weeks.
export function rehabLoad(configDoc, records, dateStr) {
  const cfg = rehabConfig(configFor(configDoc, dateStr));
  if (!cfg) return null;
  const start = programStart(configDoc);
  let last = null;
  for (const r of Object.values(records)) {
    if (r.date >= dateStr || r.date < start) continue;
    if (r.rehab && r.rehab.loadUsed != null && (!last || r.date > last.date)) last = { date: r.date, load: r.rehab.loadUsed };
  }
  const pull = achillesPullBack(configDoc, records, dateStr);
  const base = last ? last.load : (cfg.startLoad != null ? cfg.startLoad : 0);
  if (pull) {
    const inc = cfg.loadIncrement || 5;
    return { suggested: Math.max(0, base - inc), from: base, reduced: true };
  }
  return { suggested: base, from: last ? last.load : null, reduced: false };
}

export function achillesWorseDays(records, dateStr) {
  return weekDays(dateStr).filter((d) => achillesAnswer(records, d) === 'worse');
}

// Dates and answers, oldest last — the list the user's clinician actually
// wants, and the reason the question is one tap rather than a free-text box.
export function achillesTimeline(records) {
  return Object.values(records)
    .filter((r) => (r.checkin && r.checkin.achilles) || (r.rehab && (r.rehab.heelRaisesDone || r.rehab.loadUsed != null)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => ({
      date: r.date,
      answer: (r.checkin && r.checkin.achilles) || null,
      done: !!(r.rehab && r.rehab.heelRaisesDone),
      load: r.rehab && r.rehab.loadUsed != null ? r.rehab.loadUsed : null,
    }));
}

// ---------- steps (§8) ----------

// Steps banked this week against the pace the weekly target implies. A 14k
// hike covers an 8.2k recovery day: the week is what has to clear, so a low
// day inside a covered week is not a miss and is not flagged as one.
export function stepPace(configDoc, records, dateStr) {
  const config = configFor(configDoc, dateStr);
  const weekly = config.targets.stepWeeklyTarget;
  if (!weekly) return null;
  const days = weekDays(dateStr).filter((d) => d <= dateStr);
  const total = days.reduce((a, d) => a + ((records[d] && records[d].steps) || 0), 0);
  const required = Math.round((weekly * days.length) / 7);
  return { total, required, weekly, elapsed: days.length, onPace: total >= required };
}

// ---------- day gauge (§7.1) ----------

export function dayGauge(configDoc, records, dateStr) {
  const rec = records[dateStr] || {};
  const plan = dayPlan(configDoc, dateStr);
  const offered = offeredSession(configDoc, records, dateStr);
  const mealsCfg = mealsFor(configFor(configDoc, dateStr), dateStr);
  const allMeals = mealsCfg.every((m) => rec.meals && rec.meals[m.id]);
  const trainingDone =
    offered.kind === 'rest' ||
    plan.suppressed ||
    (offered.kind === 'lift'
      ? !!(rec.workout && rec.workout.completedAt)
      : !!(rec.cardio && rec.cardio.completedAt)) ||
    offered.optional === true ||
    (offered.kind === 'walk' && offered.optional && !!(rec.cardio && rec.cardio.completedAt));
  // Steps clear on the daily target OR on the week being on pace, because the
  // plan sets both and a low day inside a covered week is not a miss.
  const pace = stepPace(configDoc, records, dateStr);
  const stepsDone = (rec.steps || 0) >= plan.stepTarget || !!(pace && pace.onPace && rec.steps != null);
  const rehab = rehabConfig(configFor(configDoc, dateStr));
  const segs = [
    { id: 'weight',   label: 'Weight',   done: rec.weight != null },
    { id: 'sleep',    label: 'Sleep',    done: rec.sleepMinutes != null },
    { id: 'meals',    label: 'Meals',    done: allMeals },
    { id: 'steps',    label: 'Steps',    done: stepsDone },
    { id: 'training', label: 'Training', done: trainingDone },
  ];
  // Rehab runs daily and stands on its own, outside the strength days.
  if (rehab) segs.push({ id: 'rehab', label: 'Rehab', done: rehabDone(records, dateStr) });
  segs.push({
    id: 'checkin',
    label: 'Check-in',
    done: !!(rec.checkin && rec.checkin.symptom && (!rehab || rec.checkin.achilles)),
  });
  return segs;
}

// ---------- waist due (§7.5) ----------

export function waistDue(configDoc, measurements, dateStr) {
  const config = configFor(configDoc, dateStr);
  const waists = measurements
    .filter((m) => m.kind === 'waist')
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  if (!waists.length) return true;
  const last = waists[waists.length - 1].takenAt.slice(0, 10);
  return daysBetween(last, dateStr) >= config.targets.waistIntervalDays;
}

// ---------- NEXT bar (§7.3) ----------

// The day runs in one fixed order and the NEXT bar walks it in that order:
// weight, sleep, training, then the meals at their own hours with the heel
// raises and the walk between the afternoon snack and dinner, and the evening
// check-in last. Each step carries the hour it comes due, so the
// bar waits for a block rather than nagging about dinner at breakfast, but it
// never reorders the list around the clock.
const STEPS_HOUR = 16;
// Rehab is near-daily and sits after the day's training rather than inside it.
// It comes due ahead of the walk: heel raises are the loaded work and the walk
// is the easy thing that follows them, never the other way round.
const REHAB_HOUR = 15;
// Blood pressure is the Sunday reading, and caffeine raises it, so it comes due
// before the 10am coffee rather than whenever the day gets around to it.
const BP_HOUR = 8;
const CHECKIN_HOUR = 19;

// Default hours for a meal the plan does not time itself. The hour a block is
// eaten belongs to the plan, not to the app: a 10am coffee and a noon oat bowl
// are the plan's own times.
const MEAL_HOURS = { breakfast: 6, lunch: 11, snack: 14, dinner: 17, dessert: 19 };

// The Sunday reading is resolved once it is taken or once it is waved off for
// the week. Both are resolutions: a skippable prompt that cannot be skipped
// would hold the bar for the rest of the day.
export function bpResolved(measurements, meta, dateStr) {
  const ws = weekStart(dateStr);
  if (meta && meta.measurementsDismissed === ws) return true;
  return (measurements || []).some((m) => m.kind === 'bloodPressure' && m.takenAt.slice(0, 10) >= ws);
}

// The day's ordered steps, each with the hour it comes due and whether it is
// already satisfied. Exported so the order is testable on its own.
export function nextChain(configDoc, records, dateStr, measurements = [], meta = {}) {
  const rec = records[dateStr] || {};
  const plan = dayPlan(configDoc, dateStr);
  const offered = offeredSession(configDoc, records, dateStr);
  const config = configFor(configDoc, dateStr);
  const out = [];

  out.push({ id: 'weight', label: 'Log weight', hour: 0, done: rec.weight != null });
  out.push({ id: 'sleep', label: 'Log sleep', hour: 0, done: rec.sleepMinutes != null });

  const hasSession = offered.kind !== 'rest' && !plan.suppressed && !(offered.kind === 'walk' && offered.optional);
  if (hasSession) {
    const name =
      offered.kind === 'lift'
        ? config.sessions[offered.sessionId].name
        : offered.mode === 'intervals'
          ? 'Intervals'
          : offered.mode === 'zone2'
            ? 'Zone 2'
            : 'Walk';
    out.push({
      id: 'training',
      label: `${offered.kind === 'lift' ? 'Start ' : ''}${name}`,
      hour: 0,
      done: offered.kind === 'lift'
        ? !!(rec.workout && rec.workout.completedAt)
        : !!(rec.cardio && rec.cardio.completedAt),
    });
  }

  // The add-ons (creatine, the pre-training carb, the weekend shake) stay off
  // the chain. Creatine goes in the coffee, so the coffee step already carries
  // it, and a modifier has no "skipped" state: one that was never going to
  // happen would stall the bar for the rest of the day.

  // The Sunday reading goes ahead of the meals, because coffee is the first of
  // them and caffeine moves the number the reading exists to capture.
  const rehab = rehabConfig(config);
  if (weekday(dateStr) === 0) {
    out.push({
      id: 'bp',
      label: 'Blood pressure',
      hour: BP_HOUR,
      done: bpResolved(measurements, meta, dateStr),
    });
  }

  // Meals in plan order, with the heel raises and then the walk dropped in
  // ahead of the first meal that comes due after them — the afternoon snack is
  // eaten, then the rehab, then the walk, then dinner. The check-in is last.
  const pace = stepPace(configDoc, records, dateStr);
  const rehabStep = rehab
    ? { id: 'rehab', label: 'Achilles heel raises', hour: REHAB_HOUR, done: rehabDone(records, dateStr) }
    : null;
  const walk = {
    id: 'steps',
    label: 'Log steps',
    hour: STEPS_HOUR,
    done: (rec.steps || 0) >= plan.stepTarget || !!(pace && pace.onPace && rec.steps != null),
  };
  const afternoon = () => { if (rehabStep) out.push(rehabStep); out.push(walk); };
  let walked = false;
  for (const meal of mealsFor(config, dateStr)) {
    const at = meal.hour != null ? meal.hour : (MEAL_HOURS[meal.id] != null ? MEAL_HOURS[meal.id] : 6);
    if (!walked && at > walk.hour) { afternoon(); walked = true; }
    out.push({
      id: `meal-${meal.id}`,
      label: `Mark ${meal.name.toLowerCase()}`,
      hour: at,
      done: !!(rec.meals && rec.meals[meal.id]),
    });
  }
  if (!walked) afternoon();

  out.push({
    id: 'checkin',
    label: 'Evening check-in',
    hour: CHECKIN_HOUR,
    done: !!(rec.checkin && rec.checkin.symptom && (!rehab || rec.checkin.achilles)),
  });

  return out;
}

// `hour` is the local hour 0-23. First unsatisfied step whose hour has arrived
// wins; failing that, the earliest unsatisfied step still ahead of its hour.
// `exportStale` lets the NEXT bar surface an overdue backup once the day itself
// is fully logged.
export function nextAction(configDoc, records, measurements, dateStr, hour, exportStale = false, meta = {}) {
  const chain = nextChain(configDoc, records, dateStr, measurements, meta);

  for (const s of chain) {
    if (!s.done && hour >= s.hour) return { id: s.id, label: s.label };
  }
  if (waistDue(configDoc, measurements, dateStr)) {
    return { id: 'waist', label: 'Measure waist' };
  }
  // Nothing is due yet — surface the earliest thing still unmarked.
  for (const s of chain) {
    if (!s.done) return { id: s.id, label: s.label };
  }

  // Day fully logged: an overdue backup is the only thing still owed.
  if (exportStale) return { id: 'export', label: 'Export a backup' };

  return { id: 'done', label: "Nothing. Day's logged." };
}

// ---------- weekly review (§7.11, §8.3) ----------

// Week runs Monday-Sunday; returns the Monday of the week containing dateStr.
export function weekStart(dateStr) {
  const wd = weekday(dateStr);
  return addDays(dateStr, -((wd + 6) % 7));
}

export function weekDays(dateStr) {
  const start = weekStart(dateStr);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function weekStats(configDoc, records, dateStr, todayStr) {
  const days = weekDays(dateStr).filter((d) => d <= todayStr && d >= programStart(configDoc));
  let mealsMarked = 0, mealsAdhered = 0, mealsPossible = 0;
  let sessionsPlanned = 0, sessionsDone = 0;
  let stepsSum = 0, stepsN = 0, sleepSum = 0, sleepN = 0;
  let calSum = 0, proSum = 0, nutriN = 0;
  const strip = [];

  for (const d of weekDays(dateStr)) {
    const inRange = d <= todayStr && d >= programStart(configDoc);
    const rec = records[d] || {};
    const plan = inRange ? dayPlan(configDoc, d) : null;
    const offered = inRange ? offeredSession(configDoc, records, d) : null;
    let state = 'blank';
    if (inRange) {
      if (plan.suppressed || offered.kind === 'rest' || (offered.kind === 'walk' && offered.optional)) {
        state = 'off';
      } else {
        sessionsPlanned++;
        const done =
          offered.kind === 'lift'
            ? !!(rec.workout && rec.workout.completedAt)
            : !!(rec.cardio && rec.cardio.completedAt);
        if (done) sessionsDone++;
        state = done ? 'done' : d === todayStr ? 'pending' : 'missed';
      }
      const cfg = configByVersion(configDoc, rec.planVersion || dayPlan(configDoc, d).config.planVersion);
      for (const meal of mealsFor(cfg, d)) {
        mealsPossible++;
        const st = rec.meals && rec.meals[meal.id];
        if (st) mealsMarked++;
        if (st === 'eaten' || st === 'modified') mealsAdhered++;
      }
      // Protein is a weekly average, so it is averaged over the days that were
      // actually logged. A day with nothing marked is missing data, not a 0 g
      // day, and folding it in would report a shortfall that did not happen.
      if (rec.meals && Object.keys(rec.meals).length) {
        const n = dayNutrition(configDoc, rec);
        calSum += n.cal; proSum += n.protein; nutriN++;
      }
      if (rec.steps != null) { stepsSum += rec.steps; stepsN++; }
      if (rec.sleepMinutes != null) { sleepSum += rec.sleepMinutes; sleepN++; }
    }
    strip.push({ date: d, state });
  }

  const end = days.length ? days[days.length - 1] : dateStr;
  const avgNow = rollingAverage(records, end);
  const avgPrev = rollingAverage(records, addDays(end, -7));

  return {
    strip,
    days,
    mealAdherence: mealsPossible ? mealsAdhered / mealsPossible : null,
    sessionsPlanned,
    sessionsDone,
    avgSteps: stepsN ? Math.round(stepsSum / stepsN) : null,
    avgSleep: sleepN ? Math.round(sleepSum / sleepN) : null,
    avgCalories: nutriN ? Math.round(calSum / nutriN) : null,
    avgProtein: nutriN ? Math.round(proSum / nutriN) : null,
    nutritionDays: nutriN,
    avgNow,
    avgPrev,
    weekChange: avgNow != null && avgPrev != null ? avgNow - avgPrev : null,
    trend: trendSlope(records, end),
    steps: stepPace(configDoc, records, days.length ? days[days.length - 1] : dateStr),
    achillesWorse: achillesWorseDays(records, dateStr).length,
    rehabDays: weekDays(dateStr).filter((d) => d <= todayStr && rehabDone(records, d)).length,
  };
}

// Count consecutive weeks (ending with the week of dateStr) whose trend was
// flat, i.e. slope > -0.15 lb/wk.
export function consecutiveFlatWeeks(configDoc, records, dateStr) {
  let count = 0;
  let end = weekDays(dateStr)[6];
  for (let k = 0; k < 26; k++) {
    const t = trendSlope(records, addDays(end, -7 * k));
    if (t == null || t <= -0.15) break;
    count++;
  }
  return count;
}

export function weightDataDays(records, endDate) {
  const pts = Object.values(records).filter((r) => r.weight != null && r.date <= endDate);
  if (!pts.length) return 0;
  const dates = pts.map((r) => r.date).sort();
  return daysBetween(dates[0], dates[dates.length - 1]) + 1;
}

// §8.3 — priority order, first match wins.
export function weeklyRecommendation(configDoc, records, dateStr, todayStr) {
  const stats = weekStats(configDoc, records, dateStr, todayStr);
  const end = weekDays(dateStr)[6] <= todayStr ? weekDays(dateStr)[6] : todayStr;

  if (weightDataDays(records, end) < 14) {
    return 'Not enough data yet. Keep logging — the picture needs about two weeks.';
  }
  if (stats.mealAdherence != null && stats.mealAdherence < 0.8) {
    return 'Targets are fine; adherence is the gap. Fix the meals before changing any number.';
  }
  const trend = stats.trend;
  const config = configFor(configDoc, end);
  // Steps before food. A stall on 6,000 steps is a step problem, and cutting
  // calories against it spends the lever that was still free.
  if (stats.avgSteps != null && stats.avgSteps < config.targets.stepTarget && trend != null && trend > -0.15) {
    return `Steps are short of target — that's the first lever. Hit ${config.targets.stepTarget.toLocaleString('en-US')} before cutting food.`;
  }
  if (trend != null && trend > -0.15) {
    if (consecutiveFlatWeeks(configDoc, records, dateStr) >= 3) {
      return "Flat for three weeks. Cut 150 calories — don't add cardio.";
    }
    return "Flat. If this holds another week, cut 150 calories — don't add cardio.";
  }
  if (trend != null && trend < -1.1) {
    return 'Losing faster than planned. Add 150 calories to protect strength and recovery.';
  }
  return 'On track. Stay the course — no changes needed.';
}

// Symptom days beyond mild soreness in the week of dateStr.
export function symptomDays(records, dateStr) {
  return weekDays(dateStr).filter((d) => {
    const rec = records[d];
    const s = rec && rec.checkin && rec.checkin.symptom;
    return s && s !== 'None' && s !== 'Mild soreness';
  });
}

// §8.4 — week-three protection. Program days 14-24, trend flat or positive.
export function weekThreeNote(configDoc, records, dateStr) {
  const day = programDay(configDoc, dateStr);
  if (day < 14 || day > 24) return null;
  const trend = trendSlope(records, dateStr);
  if (trend == null || trend <= -0.15) return null;
  // Points only at what is still measured. Resting heart rate came out of the
  // app, and a note that sends you to a reading you no longer take is worse
  // than no note.
  return 'New training and creatine hold water. The waist is the honest reading right now.';
}

// ---------- CSV (§6.4) ----------

const DAY_COLUMNS = [
  'date', 'schemaVersion', 'planVersion', 'weight', 'sleepMinutes', 'steps',
  'meal_breakfast', 'meal_lunch', 'meal_snack', 'meal_dinner', 'meal_dessert',
  'modifiers',
  'checkin_energy', 'checkin_hunger', 'checkin_soreness', 'checkin_stress',
  'checkin_symptom', 'checkin_interfered', 'checkin_achilles',
  'cardio_mode', 'cardio_minutes', 'cardio_avgHr', 'cardio_completedAt',
  'rehab_heelRaisesDone', 'rehab_loadUsed',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells) {
  return cells.map(csvEscape).join(',');
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function daysToCsv(records) {
  const lines = [csvLine(DAY_COLUMNS)];
  for (const r of Object.values(records).sort((a, b) => a.date.localeCompare(b.date))) {
    const c = r.checkin || {};
    const cd = r.cardio || {};
    const rh = r.rehab || {};
    lines.push(csvLine([
      r.date, r.schemaVersion, r.planVersion, r.weight, r.sleepMinutes, r.steps,
      r.meals && r.meals.breakfast, r.meals && r.meals.lunch, r.meals && r.meals.snack,
      r.meals && r.meals.dinner, r.meals && r.meals.dessert,
      Object.entries(r.modifiers || {}).filter(([, v]) => v).map(([k]) => k).join(';'),
      c.energy, c.hunger, c.soreness, c.stress, c.symptom, c.interfered, c.achilles,
      cd.mode, cd.minutes, cd.avgHr, cd.completedAt,
      rh.heelRaisesDone == null ? undefined : (rh.heelRaisesDone ? 'yes' : 'no'),
      rh.loadUsed,
    ]));
  }
  return lines.join('\n') + '\n';
}

export function csvToDays(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const str = (v) => (v === '' || v == null ? undefined : v);
  const out = {};
  for (const row of rows.slice(1)) {
    const get = (col) => row[idx[col]];
    const date = get('date');
    if (!date) continue;
    const rec = {
      date,
      schemaVersion: num(get('schemaVersion')) || SCHEMA_VERSION,
      planVersion: num(get('planVersion')) || 1,
      meals: {},
      modifiers: {},
    };
    const w = num(get('weight')); if (w != null) rec.weight = w;
    const sl = num(get('sleepMinutes')); if (sl != null) rec.sleepMinutes = sl;
    const st = num(get('steps')); if (st != null) rec.steps = st;
    for (const m of ['breakfast', 'lunch', 'snack', 'dinner', 'dessert']) {
      const v = str(get(`meal_${m}`));
      if (v) rec.meals[m] = v;
    }
    const mods = str(get('modifiers'));
    if (mods) for (const id of mods.split(';')) rec.modifiers[id] = true;
    const checkin = {};
    for (const f of ['energy', 'hunger', 'soreness', 'stress']) {
      const v = num(get(`checkin_${f}`));
      if (v != null) checkin[f] = v;
    }
    const sym = str(get('checkin_symptom')); if (sym) checkin.symptom = sym;
    const intf = str(get('checkin_interfered')); if (intf) checkin.interfered = intf;
    const ach = str(get('checkin_achilles')); if (ach) checkin.achilles = ach;
    if (Object.keys(checkin).length) rec.checkin = checkin;
    // Rehab round-trips only when it was actually logged: an absent column
    // must import as "no record", never as a day the raises were skipped.
    const hr = str(get('rehab_heelRaisesDone'));
    const rl = num(get('rehab_loadUsed'));
    if (hr || rl != null) {
      rec.rehab = {};
      if (hr) rec.rehab.heelRaisesDone = hr === 'yes' || hr === 'true';
      if (rl != null) rec.rehab.loadUsed = rl;
    }
    const cmode = str(get('cardio_mode'));
    if (cmode) {
      rec.cardio = { mode: cmode, minutes: num(get('cardio_minutes')) || 0 };
      const hr = num(get('cardio_avgHr')); if (hr != null) rec.cardio.avgHr = hr;
      const at = str(get('cardio_completedAt')); if (at) rec.cardio.completedAt = at;
    }
    out[date] = rec;
  }
  return out;
}

export function workoutsToCsv(records) {
  const lines = [csvLine(['date', 'sessionId', 'minutes', 'completedAt', 'exerciseId', 'setIndex', 'weight', 'reps', 'mark', 'chinPhase', 'chinUnassisted', 'chinNote'])];
  for (const r of Object.values(records).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!r.workout) continue;
    const w = r.workout;
    const marks = w.marks || {};
    const keys = Object.keys(w.sets || {});
    const chin = [w.chinPhase, w.chinUnassisted, w.chinBandOrNegatives];
    if (!keys.length) {
      lines.push(csvLine([r.date, w.sessionId, w.minutes, w.completedAt, '', '', '', '', '', ...chin]));
      continue;
    }
    for (const key of keys.sort()) {
      const [exId, setIdx] = key.split(':');
      const s = w.sets[key];
      lines.push(csvLine([r.date, w.sessionId, w.minutes, w.completedAt, exId, setIdx, s.weight, s.reps, marks[exId], ...chin]));
    }
  }
  return lines.join('\n') + '\n';
}

export function csvToWorkouts(text) {
  const rows = parseCsv(text);
  const idx = Object.fromEntries(rows[0].map((h, i) => [h, i]));
  const out = {};
  for (const row of rows.slice(1)) {
    const get = (col) => row[idx[col]];
    const date = get('date');
    if (!date) continue;
    if (!out[date]) {
      out[date] = { sessionId: get('sessionId'), sets: {} };
      const min = get('minutes'); if (min !== '') out[date].minutes = Number(min);
      const at = get('completedAt'); if (at !== '') out[date].completedAt = at;
      const cp = get('chinPhase'); if (cp) out[date].chinPhase = Number(cp);
      const cu = get('chinUnassisted'); if (cu) out[date].chinUnassisted = Number(cu);
      const cn = get('chinNote'); if (cn) out[date].chinBandOrNegatives = cn;
    }
    const exId = get('exerciseId');
    if (exId) {
      out[date].sets[`${exId}:${get('setIndex')}`] = {
        weight: Number(get('weight')),
        reps: Number(get('reps')),
      };
      // Created only when a mark exists, so a workout that has none round-trips
      // byte-identical rather than gaining an empty object.
      const mark = get('mark');
      if (mark) {
        if (!out[date].marks) out[date].marks = {};
        out[date].marks[exId] = mark;
      }
    }
  }
  return out;
}

// The clinician timeline: one row per day the Achilles was rehabbed or
// reported on, plus the muscle-symptom days. Its value is being complete and
// exportable, so it ships as its own file rather than as a screen to read off.
export function clinicianToCsv(records) {
  const lines = [csvLine(['date', 'achilles_vs_yesterday', 'heel_raises_done', 'rehab_load', 'muscle_symptom', 'interfered_with_training'])];
  const rows = Object.values(records)
    .filter((r) => (r.checkin && (r.checkin.achilles || (r.checkin.symptom && r.checkin.symptom !== 'None')))
      || (r.rehab && (r.rehab.heelRaisesDone || r.rehab.loadUsed != null)))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows) {
    const c = r.checkin || {};
    const rh = r.rehab || {};
    lines.push(csvLine([
      r.date, c.achilles, rh.heelRaisesDone ? 'yes' : (rh.heelRaisesDone === false ? 'no' : ''),
      rh.loadUsed, c.symptom && c.symptom !== 'None' ? c.symptom : '', c.interfered,
    ]));
  }
  return lines.join('\n') + '\n';
}

export function measurementsToCsv(measurements) {
  const lines = [csvLine(['id', 'takenAt', 'kind', 'value', 'value2', 'schemaVersion'])];
  for (const m of [...measurements].sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
    lines.push(csvLine([m.id, m.takenAt, m.kind, m.value, m.value2, m.schemaVersion]));
  }
  return lines.join('\n') + '\n';
}

export function csvToMeasurements(text) {
  const rows = parseCsv(text);
  const idx = Object.fromEntries(rows[0].map((h, i) => [h, i]));
  const out = [];
  for (const row of rows.slice(1)) {
    const get = (col) => row[idx[col]];
    if (!get('id')) continue;
    const m = {
      id: get('id'),
      takenAt: get('takenAt'),
      kind: get('kind'),
      value: Number(get('value')),
      schemaVersion: Number(get('schemaVersion')) || SCHEMA_VERSION,
    };
    const v2 = get('value2');
    if (v2 !== '' && v2 != null) m.value2 = Number(v2);
    out.push(m);
  }
  return out;
}

// Idempotent merges: imported rows win on key collision.
export function mergeDays(existing, imported) {
  return { ...existing, ...imported };
}

export function mergeMeasurements(existing, imported) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of imported) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}
