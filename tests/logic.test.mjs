// Run: node tests/logic.test.mjs
// Covers the computable acceptance criteria in the brief (§11).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as L from '../js/logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const liveDoc = JSON.parse(readFileSync(join(__dirname, '../config/plan.json'), 'utf8'));
// Every hard-coded date below assumes a Monday 2026-07-13 program start. The
// live effectiveFrom is Noah's actual start date and moves when the program
// (re)starts, so pin the anchor here and test the live plan content under it.
const configDoc = {
  ...liveDoc,
  versions: liveDoc.versions.map((v, i) => (i === 0 ? { ...v, effectiveFrom: '2026-07-13' } : v)),
};

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}`); }
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}
function assertEq(a, b, name) {
  const ok = JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  if (!ok) { fail++; console.error(`FAIL: ${name}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`); }
  else pass++;
}

const V3 = configDoc.versions[0];

function rec(date, extra = {}) {
  return { date, schemaVersion: 1, planVersion: 3, meals: {}, modifiers: {}, ...extra };
}

// ---------- config / calendar ----------

assertEq(L.programStart(configDoc), '2026-07-13', 'program starts at first effectiveFrom');
// Brief §7.1: July 23 renders "Day 11 · Week 2"
assertEq(L.programDay(configDoc, '2026-07-23'), 11, 'Jul 23 is day 11');
assertEq(L.programWeek(configDoc, '2026-07-23'), 2, 'Jul 23 is week 2');

// Phase overrides: week 2 -> Tuesday is a 30-min walk, Friday rest (suppressed), steps 6500
{
  const tue = L.dayPlan(configDoc, '2026-07-21'); // Tuesday, week 2
  assertEq(tue.type, 'walk', 'phase 1 overrides Tuesday to walk');
  assertEq(tue.stepTarget, 6500, 'phase 1 step target');
  const fri = L.dayPlan(configDoc, '2026-07-24'); // Friday, week 2
  assert(fri.suppressed, 'phase 1 suppresses Friday intervals');
  const fri5 = L.dayPlan(configDoc, '2026-08-14'); // Friday, week 5
  assertEq(fri5.type, 'cardio', 'week 5 Friday back to intervals');
  assertEq(fri5.stepTarget, 9000, 'week 5 full step target');
}

// Day-type calorie targets
assertEq(L.dayPlan(configDoc, '2026-08-10').calorieTarget, 2430, 'Monday lift calories'); // Mon wk5
assertEq(L.dayPlan(configDoc, '2026-08-16').calorieTarget, 2260, 'Sunday rest calories');

// ---------- nutrition ----------

{
  // All five meals eaten on a cardio day -> exactly the plan totals from the brief table.
  const r = rec('2026-08-15', { meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' } });
  assertEq(L.dayNutrition(configDoc, r), { cal: 2322, protein: 187 }, 'full day = 2322 cal / 187 g');
  // modified counts identically; skipped counts zero
  const r2 = rec('2026-08-16', { meals: { breakfast: 'modified', lunch: 'skipped' } });
  assertEq(L.dayNutrition(configDoc, r2), { cal: 621, protein: 43 }, 'modified counts, skipped zero');
  // Non-optional rest-day modifier derives automatically when dinner is eaten.
  const r3 = rec('2026-08-16', { meals: { dinner: 'eaten' } }); // Sunday = rest
  assertEq(L.dayNutrition(configDoc, r3), { cal: 678 - 64, protein: 47 - 2 }, 'halfDinnerStarch auto-applies on rest day');
  // ...but not when dinner is skipped, and not on non-rest days.
  const r4 = rec('2026-08-16', { meals: { dinner: 'skipped' } });
  assertEq(L.dayNutrition(configDoc, r4), { cal: 0, protein: 0 }, 'no phantom modifier when dinner skipped');
  const r5 = rec('2026-08-15', { meals: { dinner: 'eaten' } });
  assertEq(L.dayNutrition(configDoc, r5), { cal: 678, protein: 47 }, 'no starch modifier on cardio day');
  // Optional modifier (pre-workout carb) is user-toggled on a lift day.
  const r6 = rec('2026-08-10', { meals: { breakfast: 'eaten' }, modifiers: { preworkoutCarb: true } }); // Monday = lift
  assertEq(L.dayNutrition(configDoc, r6), { cal: 621 + 110, protein: 43 + 2 }, 'preworkoutCarb toggle');
}

// ---------- weight trend ----------

{
  // Perfectly linear series: slope must match least squares exactly (§11).
  const records = {};
  for (let i = 0; i < 21; i++) {
    const d = L.addDays('2026-07-13', i);
    records[d] = rec(d, { weight: 220 - (0.5 / 7) * i }); // -0.5 lb/week
  }
  const slope = L.trendSlope(records, '2026-08-02');
  assert(Math.abs(slope - -0.5) < 1e-9, `linear slope -0.5 (got ${slope})`);

  // Independent least-squares check on noisy data, to 2 decimal places.
  const noisy = {};
  const vals = [220.0, 219.4, 220.2, 219.1, 219.8, 218.6, 219.0, 218.2];
  vals.forEach((w, i) => { const d = L.addDays('2026-07-13', i); noisy[d] = rec(d, { weight: w }); });
  const xs = vals.map((_, i) => i), ys = vals;
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const expected = (num / den) * 7;
  const got = L.trendSlope(noisy, '2026-07-20');
  assert(Math.abs(got - expected) < 0.005, `noisy slope matches independent calc (${got} vs ${expected})`);

  // <4 points -> null
  const few = {};
  ['2026-07-13', '2026-07-14', '2026-07-15'].forEach((d, i) => { few[d] = rec(d, { weight: 220 - i }); });
  assertEq(L.trendSlope(few, '2026-07-15'), null, 'trend needs >=4 points');

  // Rolling average: last 7 days only
  const avg = L.rollingAverage(records, '2026-08-02');
  const last7 = Object.values(records).filter((r) => r.date >= '2026-07-27').map((r) => r.weight);
  assert(Math.abs(avg - last7.reduce((a, b) => a + b) / 7) < 1e-9, 'rolling average = mean of trailing 7');
}

// ---------- scheduling (§8.1, §11) ----------

{
  // Acceptance: missing Monday's lift causes Thursday to offer Lift A, and the
  // following Monday to offer Lift B.
  const records = {};
  // Prior week (week 5+, no suppression): Mon Aug 10 lift A done, Thu Aug 13 lift B done.
  records['2026-08-10'] = rec('2026-08-10', { workout: { sessionId: 'liftA', sets: {}, completedAt: '2026-08-10T07:00:00' } });
  records['2026-08-13'] = rec('2026-08-13', { workout: { sessionId: 'liftB', sets: {}, completedAt: '2026-08-13T07:00:00' } });
  // Monday Aug 17: lift A offered, missed (no workout logged).
  assertEq(L.offeredSession(configDoc, records, '2026-08-17').sessionId, 'liftA', 'Monday offers A');
  // Thursday Aug 20: still offers A, labeled pushed from Monday.
  const thu = L.offeredSession(configDoc, records, '2026-08-20');
  assertEq(thu.sessionId, 'liftA', 'Thursday offers Lift A after Monday miss');
  assertEq(thu.pushedFrom, 'Monday', 'Thursday labeled pushed from Monday');
  // User does A on Thursday.
  records['2026-08-20'] = rec('2026-08-20', { workout: { sessionId: 'liftA', sets: {}, completedAt: '2026-08-20T07:00:00' } });
  // Following Monday offers B.
  assertEq(L.offeredSession(configDoc, records, '2026-08-24').sessionId, 'liftB', 'next Monday offers Lift B');

  // Tuesday substitution: Monday missed -> Tuesday (zone2, week 5+) offers the lift.
  const r2 = { ...records };
  delete r2['2026-08-20'];
  const tue = L.offeredSession(configDoc, r2, '2026-08-18');
  assertEq(tue.kind, 'lift', 'Tuesday substitutes missed Monday lift');
  assertEq(tue.pushedFrom, 'Monday', 'Tuesday substitution labeled');
  // Friday never offers a lift, even with Thursday missed.
  const fri = L.offeredSession(configDoc, r2, '2026-08-21');
  assertEq(fri.kind, 'cardio', 'Friday never offers a lift');
  // No history at all -> first lift day offers A.
  assertEq(L.offeredSession(configDoc, {}, '2026-07-13').sessionId, 'liftA', 'first ever lift is A');
}

// ---------- progression (§8.2, §11) ----------

const benchCfg = V3.sessions.liftA.exercises.find((e) => e.id === 'bench');

function workoutDay(date, sets) {
  return rec(date, { workout: { sessionId: 'liftA', sets, completedAt: `${date}T07:30:00` } });
}
function benchSets(weight, reps3) {
  const s = {};
  reps3.forEach((r, i) => { s[`bench:${i}`] = { weight, reps: r }; });
  return s;
}

{
  // No history -> no cue.
  assertEq(L.progression(configDoc, {}, 'bench', benchCfg, '2026-08-20').suggested, null, 'no history, no suggestion');

  // All reps hit -> +increment.
  const r1 = { '2026-08-17': workoutDay('2026-08-17', benchSets(145, [5, 5, 5])) };
  const p1 = L.progression(configDoc, r1, 'bench', benchCfg, '2026-08-20');
  assertEq(p1.suggested, 150, 'all reps hit -> +5');

  // Miss at last success -> repeat.
  const r2 = {
    '2026-08-17': workoutDay('2026-08-17', benchSets(145, [5, 5, 5])),
    '2026-08-20': workoutDay('2026-08-20', benchSets(150, [5, 5, 3])),
  };
  // 150 > lastSuccess 145: over-reach, doesn't count as miss -> repeat 150
  const p2 = L.progression(configDoc, r2, 'bench', benchCfg, '2026-08-24');
  assertEq(p2.suggested, 150, 'miss above last success -> repeat, no deload count');

  // Acceptance: exceeding the suggestion and missing must NOT increment the
  // deload counter. Two over-reach misses in a row -> still repeat, not deload.
  const r3 = {
    ...r2,
    '2026-08-24': workoutDay('2026-08-24', benchSets(155, [4, 4, 3])),
  };
  const p3 = L.progression(configDoc, r3, 'bench', benchCfg, '2026-08-27');
  assert(p3.suggested !== Math.round(145 * 0.9 / 5) * 5, 'over-reach misses never deload');
  assertEq(p3.suggested, 155, 'over-reach miss -> repeat last load');

  // Two genuine misses at the last-success load -> deload to 0.9 x lastSuccess.
  const r4 = {
    '2026-08-03': workoutDay('2026-08-03', benchSets(150, [5, 5, 5])),
    '2026-08-06': workoutDay('2026-08-06', benchSets(150, [5, 4, 3])),
    '2026-08-10': workoutDay('2026-08-10', benchSets(150, [5, 4, 4])),
  };
  const p4 = L.progression(configDoc, r4, 'bench', benchCfg, '2026-08-13');
  assertEq(p4.suggested, 135, 'two misses at last success -> deload to round(150*0.9)=135');

  // Layoff: >10 days since last session -> 0.9 x lastSuccess.
  const r5 = { '2026-08-03': workoutDay('2026-08-03', benchSets(150, [5, 5, 5])) };
  const p5 = L.progression(configDoc, r5, 'bench', benchCfg, '2026-08-20');
  assertEq(p5.suggested, 135, 'layoff -> 0.9 x last success');
  assert(p5.cue.includes('17 days'), 'layoff cue names the gap');

  // Rounding: increment rounds to nearest 5.
  const p6 = L.progression(configDoc, { '2026-08-17': workoutDay('2026-08-17', benchSets(147, [5, 5, 5])) }, 'bench', benchCfg, '2026-08-20');
  assertEq(p6.suggested % 5, 0, 'suggestions round to nearest 5');
}

// ---------- day gauge / NEXT ----------

{
  const d = '2026-08-16'; // Sunday, rest day
  const records = { [d]: rec(d, { weight: 218, sleepMinutes: 460, steps: 9500,
    meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' },
    checkin: { symptom: 'None' } }) };
  const gauge = L.dayGauge(configDoc, records, d);
  assert(gauge.every((g) => g.done), 'full rest day -> all 6 segments done');
  const measurements = [{ id: 'w1', takenAt: `${d}T07:00:00`, kind: 'waist', value: 41, schemaVersion: 1 }];
  const next = L.nextAction(configDoc, records, measurements, d, 21);
  assertEq(next.id, 'done', "everything satisfied -> day's logged");
  // Overdue backup surfaces only once the day itself is fully logged.
  assertEq(L.nextAction(configDoc, records, measurements, d, 21, true).id, 'export', 'stale export -> NEXT says export');
  assertEq(L.nextAction(configDoc, { [d]: rec(d) }, measurements, d, 7, true).id, 'weight', 'daily capture outranks export');

  // Morning, nothing logged -> weight first.
  assertEq(L.nextAction(configDoc, { [d]: rec(d) }, measurements, d, 7).id, 'weight', 'morning: weight first');
  // Waist due when no measurement in 14 days.
  assert(L.waistDue(configDoc, [], d), 'waist due with no history');
  assert(!L.waistDue(configDoc, measurements, d), 'waist not due day-of');
  assert(L.waistDue(configDoc, measurements, L.addDays(d, 14)), 'waist due after 14 days');
}

// ---------- weekly recommendation (§8.3) ----------

{
  // <14 days of data -> not enough data, regardless of anything else.
  const records = {};
  for (let i = 0; i < 5; i++) { const d = L.addDays('2026-07-13', i); records[d] = rec(d, { weight: 220 }); }
  assert(L.weeklyRecommendation(configDoc, records, '2026-07-19', '2026-07-19').startsWith('Not enough data'), 'under 14 days -> not enough data');

  // Build 4 weeks of full adherence, flat weight -> flat recommendation, then 3-week version.
  const flat = {};
  for (let i = 0; i < 28; i++) {
    const d = L.addDays('2026-07-13', i);
    flat[d] = rec(d, { weight: 220 + (i % 2 ? 0.1 : -0.1),
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' } });
  }
  const recFlat = L.weeklyRecommendation(configDoc, flat, '2026-08-09', '2026-08-09');
  assert(recFlat.startsWith('Flat for three weeks'), `3 flat weeks -> cut 150 (got: ${recFlat})`);
  assert(!recFlat.includes('cardio.') || recFlat.includes("don't add cardio"), 'never recommends adding cardio');

  // Low adherence outranks flat trend.
  const lowAdh = {};
  for (let i = 0; i < 28; i++) {
    const d = L.addDays('2026-07-13', i);
    lowAdh[d] = rec(d, { weight: 220, meals: { breakfast: 'eaten', lunch: 'skipped', snack: 'skipped', dinner: 'skipped', dessert: 'skipped' } });
  }
  assert(L.weeklyRecommendation(configDoc, lowAdh, '2026-08-09', '2026-08-09').includes('adherence is the gap'), 'adherence checked before targets');

  // Fast loss -> add calories.
  const fast = {};
  for (let i = 0; i < 28; i++) {
    const d = L.addDays('2026-07-13', i);
    fast[d] = rec(d, { weight: 222 - 0.25 * i,
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' } });
  }
  assert(L.weeklyRecommendation(configDoc, fast, '2026-08-09', '2026-08-09').startsWith('Losing faster'), 'fast loss -> add 150');

  // On track: -0.6 lb/wk.
  const good = {};
  for (let i = 0; i < 28; i++) {
    const d = L.addDays('2026-07-13', i);
    good[d] = rec(d, { weight: 221 - (0.6 / 7) * i,
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' } });
  }
  assert(L.weeklyRecommendation(configDoc, good, '2026-08-09', '2026-08-09').startsWith('On track'), 'on-track band');
}

// ---------- phase suppression x weekly review (§5.7, §7.11) ----------

{
  // Week 2 (phase 1): Fri intervals suppressed, Wed walk optional, Sun rest.
  // Planned sessions = Mon lift, Tue walk (phase override), Thu lift, Sat zone2 = 4.
  // With nothing logged, the suppressed Friday must read 'off', never 'missed'.
  const s2 = L.weekStats(configDoc, {}, '2026-07-20', '2026-07-26');
  assertEq(s2.sessionsPlanned, 4, 'week 2: suppressed Friday not counted as planned');
  assertEq(s2.strip[4].state, 'off', 'week 2: suppressed Friday renders off, not missed');
  assertEq(s2.strip[6].state, 'off', 'week 2: Sunday rest renders off');
  assertEq(s2.strip[2].state, 'off', 'week 2: optional Wednesday walk renders off');
  assertEq(s2.strip[0].state, 'missed', 'week 2: unlogged Monday lift does read missed');

  // Week 5 (no phase): Mon lift, Tue zone2, Thu lift, Fri intervals, Sat zone2 = 5.
  const s5 = L.weekStats(configDoc, {}, '2026-08-10', '2026-08-16');
  assertEq(s5.sessionsPlanned, 5, 'week 5: full schedule counts 5 planned');
  assertEq(s5.strip[4].state, 'missed', 'week 5: unlogged Friday intervals reads missed');

  // The day gauge counts a suppressed day's training as satisfied.
  const gauge = L.dayGauge(configDoc, {}, '2026-07-24'); // Friday week 2, suppressed
  assert(gauge.find((g) => g.id === 'training').done, 'gauge: suppressed day training auto-satisfied');
}

// ---------- week-three protection (§8.4) ----------

{
  const flat = {};
  for (let i = 0; i < 18; i++) {
    const d = L.addDays('2026-07-13', i);
    flat[d] = rec(d, { weight: 220 + (i % 2 ? 0.1 : -0.1) });
  }
  const day16 = L.addDays('2026-07-13', 15); // program day 16
  assert(L.weekThreeNote(configDoc, flat, day16) !== null, 'flat trend on day 16 -> note shows');
  const day10 = L.addDays('2026-07-13', 9);
  assertEq(L.weekThreeNote(configDoc, flat, day10), null, 'day 10 -> no note');
  const losing = {};
  for (let i = 0; i < 18; i++) {
    const d = L.addDays('2026-07-13', i);
    losing[d] = rec(d, { weight: 220 - 0.15 * i });
  }
  assertEq(L.weekThreeNote(configDoc, losing, day16), null, 'losing well -> no note');
}

// ---------- historical adherence uses planVersion in force (§6.3) ----------

{
  const twoVersions = {
    versions: [
      { ...V3, planVersion: 3, effectiveFrom: '2026-07-13' },
      { ...V3, planVersion: 4, effectiveFrom: '2026-08-01',
        dayTypes: { ...V3.dayTypes, rest: { calorieTarget: 2100, mealModifiers: ['halfDinnerStarch'] } },
        meals: V3.meals.slice(0, 4) }, // v4 drops dessert
    ],
  };
  // A July record (planVersion 3) still counts 5 meals; an August record counts 4.
  const july = rec('2026-07-20', { planVersion: 3, meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' } });
  const aug = rec('2026-08-03', { planVersion: 4, meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten' } });
  assertEq(L.dayNutrition(twoVersions, july).cal, 2322, 'July record valued under v3');
  assertEq(L.dayNutrition(twoVersions, aug).cal, 2322 - 85, 'August record valued under v4 (no dessert)');
  assertEq(L.configFor(twoVersions, '2026-07-31').planVersion, 3, 'config resolution by date, v3');
  assertEq(L.configFor(twoVersions, '2026-08-01').planVersion, 4, 'config resolution by date, v4');
}

// ---------- CSV round-trip (§11: export reimports to identical state) ----------

{
  const records = {
    '2026-08-17': rec('2026-08-17', {
      weight: 217.4, sleepMinutes: 462, steps: 9412,
      meals: { breakfast: 'eaten', lunch: 'modified', snack: 'skipped', dinner: 'eaten', dessert: 'eaten' },
      modifiers: { preworkoutCarb: true },
      checkin: { energy: 2, hunger: 1, soreness: 0, stress: 1, symptom: 'Mild soreness' },
      workout: { sessionId: 'liftA', minutes: 54, completedAt: '2026-08-17T07:55:00',
        sets: { 'bench:0': { weight: 150, reps: 5 }, 'bench:1': { weight: 150, reps: 5 }, 'trapbar:0': { weight: 225, reps: 5 } } },
    }),
    '2026-08-18': rec('2026-08-18', {
      weight: 217.0, cardio: { mode: 'zone2', minutes: 42, avgHr: 118, completedAt: '2026-08-18T18:00:00' },
      checkin: { symptom: 'Muscle pain', interfered: 'Somewhat' },
      meals: { breakfast: 'eaten' },
    }),
  };
  const measurements = [
    { id: 'm1', takenAt: '2026-08-16T07:00:00', kind: 'waist', value: 40.5, schemaVersion: 1 },
    { id: 'm2', takenAt: '2026-08-16T07:05:00', kind: 'bloodPressure', value: 128, value2: 82, schemaVersion: 1 },
  ];

  const daysBack = L.csvToDays(L.daysToCsv(records));
  const workoutsBack = L.csvToWorkouts(L.workoutsToCsv(records));
  for (const [date, w] of Object.entries(workoutsBack)) daysBack[date].workout = w;
  const measBack = L.csvToMeasurements(L.measurementsToCsv(measurements));

  const strip = (o) => canon(JSON.parse(JSON.stringify(o))); // drop undefined, sort keys
  assertEq(strip(daysBack), strip(records), 'days+workouts CSV round-trip identical');
  assertEq(strip(measBack), strip(measurements), 'measurements CSV round-trip identical');

  // Idempotent merge: importing twice changes nothing.
  assertEq(strip(L.mergeDays(daysBack, daysBack)), strip(records), 'day import idempotent');
  assertEq(strip(L.mergeMeasurements(measBack, measBack)), strip(measurements), 'measurement import idempotent');
}

// ---------- seeded start loads ----------

{
  const V4 = configDoc.versions.find((v) => v.planVersion === 4);
  assert(V4, 'plan carries a version 4');
  const b4 = V4.sessions.liftA.exercises.find((e) => e.id === 'bench');
  const s4 = V4.sessions.liftB.exercises.find((e) => e.id === 'squat');

  // Every exercise must carry a start load — a blank first session is the bug.
  const missing = [];
  for (const s of Object.values(V4.sessions)) {
    for (const e of s.exercises) if (e.startWeight == null) missing.push(e.id);
  }
  assertEq(missing, [], 'every v4 exercise has a startWeight');

  const p = L.progression(configDoc, {}, 'bench', b4, '2026-08-20');
  assertEq(p.suggested, 105, 'no history -> seeded start load');
  assert(p.cue && p.cue.includes('105'), 'start-load cue names the number');
  assertEq(L.progression(configDoc, {}, 'squat', s4, '2026-08-20').suggested, 155, 'squat start load 155');

  // History still wins over the seed.
  const r = { '2026-08-17': workoutDay('2026-08-17', benchSets(145, [5, 5, 5])) };
  assertEq(L.progression(configDoc, r, 'bench', b4, '2026-08-20').suggested, 150, 'history overrides the seed');
}

// ---------- set marks: hit / grindy / missed ----------

function markedDay(date, sets, marks) {
  return rec(date, { workout: { sessionId: 'liftA', sets, marks, completedAt: `${date}T07:30:00` } });
}

{
  // Hit -> increment, even though it is also inferable from reps.
  const hit = { '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 5]), { bench: 'hit' }) };
  assertEq(L.progression(configDoc, hit, 'bench', benchCfg, '2026-08-20').suggested, 150, 'hit -> +5');

  // Grindy -> repeat. All reps were completed, so reps alone would have said
  // "increment"; only the mark carries this.
  const grindy = { '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 5]), { bench: 'grindy' }) };
  const pg = L.progression(configDoc, grindy, 'bench', benchCfg, '2026-08-20');
  assertEq(pg.suggested, 145, 'grindy -> repeat the same load');
  assert(pg.cue.toLowerCase().includes('again'), 'grindy cue says run it again');

  // Missed once at the working load -> repeat, no deload yet.
  const miss1 = {
    '2026-08-13': markedDay('2026-08-13', benchSets(145, [5, 5, 5]), { bench: 'hit' }),
    '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 4]), { bench: 'miss' }),
  };
  assertEq(L.progression(configDoc, miss1, 'bench', benchCfg, '2026-08-20').suggested, 145, 'one miss -> repeat');

  // Two consecutive misses -> deload to 0.9 x last success (Noah's rule).
  const miss2 = {
    ...miss1,
    '2026-08-20': markedDay('2026-08-20', benchSets(145, [5, 4, 4]), { bench: 'miss' }),
  };
  assertEq(L.progression(configDoc, miss2, 'bench', benchCfg, '2026-08-24').suggested, 130, 'two misses -> deload to round(145*0.9)=130');

  // A grindy session between two misses breaks the streak: grinding it out is
  // not failing, so it must not accumulate toward a deload.
  const broken = {
    '2026-08-10': markedDay('2026-08-10', benchSets(145, [5, 5, 5]), { bench: 'hit' }),
    '2026-08-13': markedDay('2026-08-13', benchSets(145, [5, 5, 4]), { bench: 'miss' }),
    '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 5]), { bench: 'grindy' }),
    '2026-08-20': markedDay('2026-08-20', benchSets(145, [5, 4, 4]), { bench: 'miss' }),
  };
  assertEq(L.progression(configDoc, broken, 'bench', benchCfg, '2026-08-24').suggested, 145,
    'grindy breaks the miss streak -> repeat, not deload');

  // An explicit mark overrides what the reps imply, in both directions.
  const repsSayHit = { '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 5]), { bench: 'miss' }) };
  assert(L.progression(configDoc, repsSayHit, 'bench', benchCfg, '2026-08-20').suggested !== 150,
    'explicit miss overrides all-reps-completed');
  const repsSayMiss = { '2026-08-17': markedDay('2026-08-17', benchSets(145, [5, 5, 2]), { bench: 'hit' }) };
  assertEq(L.progression(configDoc, repsSayMiss, 'bench', benchCfg, '2026-08-20').suggested, 150,
    'explicit hit overrides a short set');

  // Unmarked history keeps behaving exactly as before marks existed.
  const unmarked = { '2026-08-17': workoutDay('2026-08-17', benchSets(145, [5, 5, 5])) };
  assertEq(L.progression(configDoc, unmarked, 'bench', benchCfg, '2026-08-20').suggested, 150,
    'unmarked sessions still infer from reps');

  // Marks survive a backup round-trip.
  const back = L.csvToWorkouts(L.workoutsToCsv(miss2));
  assertEq(back['2026-08-20'].marks, { bench: 'miss' }, 'marks round-trip through CSV');
  const noMarks = L.csvToWorkouts(L.workoutsToCsv(unmarked));
  assertEq(noMarks['2026-08-17'].marks, undefined, 'a workout with no marks gains no marks key');
}

// ---------- off-plan meals ----------

{
  const V4 = configDoc.versions.find((v) => v.planVersion === 4);
  const planned = L.mealTotal(V4.meals.find((m) => m.id === 'lunch'));

  const eaten = { date: '2026-08-17', planVersion: 4, meals: { lunch: 'eaten' }, modifiers: {} };
  const offplan = { date: '2026-08-17', planVersion: 4, meals: { lunch: 'offplan' }, modifiers: {} };
  const skipped = { date: '2026-08-17', planVersion: 4, meals: { lunch: 'skipped' }, modifiers: {} };

  assertEq(L.dayNutrition(configDoc, offplan).cal, planned.cal, 'off-plan counts the meal calories');
  assertEq(L.dayNutrition(configDoc, offplan), L.dayNutrition(configDoc, eaten), 'off-plan counts like eaten for totals');
  assertEq(L.dayNutrition(configDoc, skipped).cal, 0, 'skipped counts nothing');

  // The whole point: it breaks adherence, which is what drives the weekly
  // recommendation to say "fix the meals before changing any number".
  const mealIds = V4.meals.map((m) => m.id);
  const allOf = (state) => Object.fromEntries(mealIds.map((id) => [id, state]));
  const day = '2026-08-17'; // Monday
  const recsEaten = { [day]: rec(day, { planVersion: 4, meals: allOf('eaten') }) };
  const recsOff = { [day]: rec(day, { planVersion: 4, meals: allOf('offplan') }) };
  assertEq(L.weekStats(configDoc, recsEaten, day, day).mealAdherence, 1, 'all planned -> 100% adherence');
  assertEq(L.weekStats(configDoc, recsOff, day, day).mealAdherence, 0, 'all off-plan -> 0% adherence');

  // And it is still a logged meal, so the day gauge counts it as answered.
  const gauge = L.dayGauge(configDoc, recsOff, day).find((g) => g.id === 'meals');
  assertEq(gauge.done, true, 'off-plan still marks the meal as logged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
