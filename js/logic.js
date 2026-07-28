// Pure business logic. No DOM, no storage. Everything here is a function of
// (records, measurements, config, date/time). Tested in tests/logic.test.mjs.

export const SCHEMA_VERSION = 1;

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
export function configFor(configDoc, dateStr) {
  const eligible = configDoc.versions
    .filter((v) => v.effectiveFrom <= dateStr)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return eligible[eligible.length - 1] || configDoc.versions[0];
}

export function configByVersion(configDoc, planVersion) {
  return (
    configDoc.versions.find((v) => v.planVersion === planVersion) ||
    configDoc.versions[configDoc.versions.length - 1]
  );
}

// Program day 1 = the earliest effectiveFrom in the config document.
export function programStart(configDoc) {
  return configDoc.versions
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
  return {
    config,
    week,
    phase,
    schedule: sched,
    type: sched.type,
    suppressed,
    calorieTarget: dt.calorieTarget,
    mealModifiers: dt.mealModifiers || [],
    stepTarget: (phase && phase.stepTarget) || config.targets.stepTarget,
    sleepTargetMinutes: config.targets.sleepTargetMinutes,
    proteinFloor: config.targets.proteinFloor,
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
  for (const meal of config.meals) {
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
    const sessionId = nextLiftId(records);
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
        sessionId: nextLiftId(records),
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

// Returns { suggested, cue, tone } — suggestion only, never enforced.
export function progression(configDoc, records, exerciseId, exCfg, todayStr) {
  const config = configFor(configDoc, todayStr);
  const p = config.progression;
  const hist = exerciseHistory(records, exerciseId);

  // No history: the seeded start load from the plan. A blank field asks the
  // user to invent a number at the moment they are least able to judge it.
  if (!hist.length) {
    if (exCfg.startWeight == null) return { suggested: null, cue: null, tone: 'none' };
    return {
      suggested: exCfg.startWeight,
      cue: `Starting weight — ${exCfg.startWeight} ${exCfg.unit}`,
      tone: 'neutral',
    };
  }

  const last = hist[hist.length - 1];
  const lastLoad = sessionLoad(last);
  const lastOutcome = outcomeOf(last, exCfg);

  // Heaviest load carried for all prescribed reps. Grindy counts: the reps were
  // completed, it just cost everything to do it.
  let lastSuccess = null;
  for (const s of hist) {
    if (outcomeOf(s, exCfg) !== 'miss') {
      const load = sessionLoad(s);
      if (lastSuccess === null || load > lastSuccess) lastSuccess = load;
    }
  }

  // Layoff: long gap since this exercise was last performed.
  const gap = daysBetween(last.date, todayStr);
  if (gap > p.layoffDays && lastSuccess !== null) {
    const suggested = roundTo(lastSuccess * p.layoffFactor, p.roundToNearest);
    return {
      suggested,
      cue: `It's been ${gap} days — start at ${suggested} ${exCfg.unit}`,
      tone: 'neutral',
    };
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
    const suggested = roundTo(lastSuccess * p.deloadFactor, p.roundToNearest);
    return {
      suggested,
      cue: `${misses} misses — drop to ${suggested} ${exCfg.unit} and rebuild`,
      tone: 'neutral',
    };
  }

  if (lastOutcome === 'grindy') {
    return {
      suggested: lastLoad,
      cue: `Ground it out at ${lastLoad} ${exCfg.unit} — run it again`,
      tone: 'neutral',
    };
  }

  if (lastOutcome === 'hit') {
    const inc = exCfg.increment != null ? exCfg.increment : p.roundToNearest;
    const suggested = roundTo(lastLoad + inc, p.roundToNearest);
    return {
      suggested,
      cue: `All reps hit last time — go ${suggested} ${exCfg.unit}`,
      tone: 'done',
    };
  }

  return {
    suggested: lastLoad,
    cue: `Last time ${lastLoad} ${exCfg.unit} — repeat it`,
    tone: 'neutral',
  };
}

// ---------- day gauge (§7.1) ----------

export function dayGauge(configDoc, records, dateStr) {
  const rec = records[dateStr] || {};
  const plan = dayPlan(configDoc, dateStr);
  const offered = offeredSession(configDoc, records, dateStr);
  const mealsCfg = configFor(configDoc, dateStr).meals;
  const allMeals = mealsCfg.every((m) => rec.meals && rec.meals[m.id]);
  const trainingDone =
    offered.kind === 'rest' ||
    plan.suppressed ||
    (offered.kind === 'lift'
      ? !!(rec.workout && rec.workout.completedAt)
      : !!(rec.cardio && rec.cardio.completedAt)) ||
    (offered.kind === 'walk' && offered.optional && !!(rec.cardio && rec.cardio.completedAt));
  return [
    { id: 'weight',   label: 'Weight',   done: rec.weight != null },
    { id: 'sleep',    label: 'Sleep',    done: rec.sleepMinutes != null },
    { id: 'meals',    label: 'Meals',    done: allMeals },
    { id: 'steps',    label: 'Steps',    done: (rec.steps || 0) >= plan.stepTarget },
    { id: 'training', label: 'Training', done: trainingDone },
    { id: 'checkin',  label: 'Check-in', done: !!(rec.checkin && rec.checkin.symptom) },
  ];
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

// `hour` is the local hour 0-23. First unsatisfied wins. `exportStale` lets
// the NEXT bar surface an overdue backup once the day itself is fully logged.
export function nextAction(configDoc, records, measurements, dateStr, hour, exportStale = false) {
  const rec = records[dateStr] || {};
  const plan = dayPlan(configDoc, dateStr);
  const offered = offeredSession(configDoc, records, dateStr);
  const config = configFor(configDoc, dateStr);

  if (hour < 12 && rec.weight == null) return { id: 'weight', label: 'Log weight' };
  if (hour < 12 && rec.sleepMinutes == null) return { id: 'sleep', label: 'Log sleep' };

  const sessionDone =
    offered.kind === 'lift'
      ? !!(rec.workout && rec.workout.completedAt)
      : !!(rec.cardio && rec.cardio.completedAt);
  const hasSession = offered.kind !== 'rest' && !plan.suppressed && !(offered.kind === 'walk' && offered.optional);
  if (hasSession && !sessionDone && (hour >= 15 || (hour >= 17 && hour < 20))) {
    const name =
      offered.kind === 'lift'
        ? config.sessions[offered.sessionId].name
        : offered.mode === 'intervals'
          ? 'Intervals'
          : offered.mode === 'zone2'
            ? 'Zone 2'
            : 'Walk';
    return { id: 'training', label: `${offered.kind === 'lift' ? 'Start ' : ''}${name}` };
  }

  // Next meal by time of day.
  const mealHours = { breakfast: 6, lunch: 11, snack: 14, dinner: 17, dessert: 19 };
  for (const meal of config.meals) {
    const state = rec.meals && rec.meals[meal.id];
    if (!state && hour >= (mealHours[meal.id] != null ? mealHours[meal.id] : 6)) {
      return { id: `meal-${meal.id}`, label: `Mark ${meal.name.toLowerCase()}` };
    }
  }

  if (hour >= 18 && (rec.steps || 0) < plan.stepTarget) {
    return { id: 'steps', label: 'Log steps' };
  }
  if (hour >= 19 && !(rec.checkin && rec.checkin.symptom)) {
    return { id: 'checkin', label: 'Evening check-in' };
  }
  if (waistDue(configDoc, measurements, dateStr)) {
    return { id: 'waist', label: 'Measure waist' };
  }

  // Anything still unmarked (before its usual hour) — earliest unsatisfied.
  if (rec.weight == null) return { id: 'weight', label: 'Log weight' };
  if (rec.sleepMinutes == null) return { id: 'sleep', label: 'Log sleep' };
  for (const meal of config.meals) {
    if (!(rec.meals && rec.meals[meal.id])) {
      return { id: `meal-${meal.id}`, label: `Mark ${meal.name.toLowerCase()}` };
    }
  }
  if (hasSession && !sessionDone) {
    return { id: 'training', label: offered.kind === 'lift' ? `Start ${config.sessions[offered.sessionId].name}` : 'Log session' };
  }
  if ((rec.steps || 0) < plan.stepTarget) return { id: 'steps', label: 'Log steps' };
  if (!(rec.checkin && rec.checkin.symptom)) return { id: 'checkin', label: 'Evening check-in' };

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
      for (const meal of cfg.meals) {
        mealsPossible++;
        const st = rec.meals && rec.meals[meal.id];
        if (st) mealsMarked++;
        if (st === 'eaten' || st === 'modified') mealsAdhered++;
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
    avgNow,
    avgPrev,
    weekChange: avgNow != null && avgPrev != null ? avgNow - avgPrev : null,
    trend: trendSlope(records, end),
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
  return 'New training holds water. Waist and resting heart rate are the honest readings right now.';
}

// ---------- CSV (§6.4) ----------

const DAY_COLUMNS = [
  'date', 'schemaVersion', 'planVersion', 'weight', 'sleepMinutes', 'steps',
  'meal_breakfast', 'meal_lunch', 'meal_snack', 'meal_dinner', 'meal_dessert',
  'modifiers',
  'checkin_energy', 'checkin_hunger', 'checkin_soreness', 'checkin_stress',
  'checkin_symptom', 'checkin_interfered',
  'cardio_mode', 'cardio_minutes', 'cardio_avgHr', 'cardio_completedAt',
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
    lines.push(csvLine([
      r.date, r.schemaVersion, r.planVersion, r.weight, r.sleepMinutes, r.steps,
      r.meals && r.meals.breakfast, r.meals && r.meals.lunch, r.meals && r.meals.snack,
      r.meals && r.meals.dinner, r.meals && r.meals.dessert,
      Object.entries(r.modifiers || {}).filter(([, v]) => v).map(([k]) => k).join(';'),
      c.energy, c.hunger, c.soreness, c.stress, c.symptom, c.interfered,
      cd.mode, cd.minutes, cd.avgHr, cd.completedAt,
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
    if (Object.keys(checkin).length) rec.checkin = checkin;
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
  const lines = [csvLine(['date', 'sessionId', 'minutes', 'completedAt', 'exerciseId', 'setIndex', 'weight', 'reps', 'mark'])];
  for (const r of Object.values(records).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!r.workout) continue;
    const w = r.workout;
    const marks = w.marks || {};
    const keys = Object.keys(w.sets || {});
    if (!keys.length) {
      lines.push(csvLine([r.date, w.sessionId, w.minutes, w.completedAt, '', '', '', '', '']));
      continue;
    }
    for (const key of keys.sort()) {
      const [exId, setIdx] = key.split(':');
      const s = w.sets[key];
      lines.push(csvLine([r.date, w.sessionId, w.minutes, w.completedAt, exId, setIdx, s.weight, s.reps, marks[exId]]));
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
