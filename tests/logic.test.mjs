// Run: node tests/logic.test.mjs
// Covers the computable acceptance criteria in the brief (§11).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as L from '../js/logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const liveDoc = JSON.parse(readFileSync(join(__dirname, '../config/plan.json'), 'utf8'));
// The engine tests below hard-code dates against a Monday 2026-07-13 program
// start and against the same-menu-every-day plan shape (v3/v4). Noah's real
// start date moves whenever the program restarts, so pin the anchor here and
// run the engine against the plan versions those cases were written for. The
// live plan and its current version get their own section at the bottom.
const configDoc = {
  ...liveDoc,
  programStart: '2026-07-13',
  versions: liveDoc.versions
    .filter((v) => v.planVersion <= 4)
    .map((v, i) => (i === 0 ? { ...v, effectiveFrom: '2026-07-13' } : v)),
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

  // A day already carrying a workout is on that workout's session, so the card
  // and the logger it opens can never name different lifts. Last completed here
  // is Thursday's A, so the alternation alone would say B.
  const r3 = { ...records };
  r3['2026-08-24'] = rec('2026-08-24', { workout: { sessionId: 'liftA', sets: { 'bench:0': { weight: 105, reps: 5 } } } });
  assertEq(L.offeredSession(configDoc, r3, '2026-08-24').sessionId, 'liftA', 'a started workout owns its day');
  assertEq(L.liftIdFor(r3, '2026-08-24'), 'liftA', 'liftIdFor agrees with the offer');

  // An empty shell — logger opened, backed out of — is not a started workout
  // and must not pin the day to a session already completed elsewhere.
  const r4 = { ...records };
  r4['2026-08-24'] = rec('2026-08-24', { workout: { sessionId: 'liftA', sets: {} } });
  assertEq(L.offeredSession(configDoc, r4, '2026-08-24').sessionId, 'liftB', 'empty shell does not own the day');
  assertEq(L.liftIdFor(r4, '2026-08-24'), 'liftB', 'liftIdFor ignores an empty shell');
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

// The seeds must cover the LIVE plan from day 1, not from the day the revision
// happened to be authored. Regression: v4 was first dated the day it shipped,
// so the program's opening days resolved to a version with no startWeight and
// the logger showed blank weights on exactly the days worth backfilling.
{
  const start = L.programStart(liveDoc);
  const blanks = [];
  for (let i = 0; i < 120; i++) {
    const day = L.addDays(start, i);
    const cfg = L.configFor(liveDoc, day);
    for (const s of Object.values(cfg.sessions)) {
      for (const e of s.exercises) {
        if (e.startWeight == null) blanks.push(`${day}:${e.id}`);
        else if (L.progression(liveDoc, {}, e.id, e, day).suggested == null) blanks.push(`${day}:${e.id}:nosuggest`);
      }
    }
  }
  assertEq(blanks.slice(0, 5), [], 'live plan seeds every exercise on every day from program start');

  // Same-date revisions resolve to the higher planVersion, not to array order.
  const tie = {
    versions: [
      { planVersion: 9, effectiveFrom: '2026-07-26', sessions: {}, meals: [] },
      { planVersion: 7, effectiveFrom: '2026-07-26', sessions: {}, meals: [] },
    ],
  };
  assertEq(L.configFor(tie, '2026-07-26').planVersion, 9, 'same-date versions break the tie on planVersion');
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

// ---------- the live plan: restart, weekday dinners, weekly protein ----------
// These run against config/plan.json exactly as shipped. Every expected number
// is copied from the plan document Noah wrote, not derived from the code.

const V5 = liveDoc.versions.find((v) => v.planVersion === 5);
const MON = '2026-08-10';
const WEEK = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];

{
  assert(V5, 'plan carries a version 5');
  assertEq(L.programStart(liveDoc), MON, 'program restarts Monday Aug 10');
  assertEq(L.weekday(MON), 1, 'Aug 10 is a Monday');
  assertEq(L.programDay(liveDoc, MON), 1, 'Aug 10 is day 1');
  assertEq(L.programWeek(liveDoc, MON), 1, 'Aug 10 is week 1');
  assertEq(L.configFor(liveDoc, MON).planVersion, 5, 'day 1 resolves to v5');
  // The doc-level restart date must not be inferable from effectiveFrom alone,
  // or a restart would mean back-dating versions that were really in force.
  assert(liveDoc.versions.some((v) => v.effectiveFrom < MON), 'older versions keep their real effectiveFrom');
}

// Day totals: eating the plan must produce the plan's own printed numbers.
{
  const expected = {
    '2026-08-10': [2156, 155], '2026-08-11': [2111, 182], '2026-08-12': [2111, 182],
    '2026-08-13': [2181, 162], '2026-08-14': [2231, 164], '2026-08-15': [2431, 164],
    '2026-08-16': [2331, 149],
  };
  const records = {};
  for (const d of WEEK) {
    const weekend = [5, 6, 0].includes(L.weekday(d));
    records[d] = {
      date: d, schemaVersion: 1, planVersion: 5,
      meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten', dinner: 'eaten', dessert: 'eaten' },
      modifiers: weekend ? { weekendShake: true } : {},
    };
    const [cal, protein] = expected[d];
    assertEq(L.dayNutrition(liveDoc, records[d]), { cal, protein }, `${d} totals ${cal} cal / ${protein} g`);
    const plan = L.dayPlan(liveDoc, d);
    assertEq(plan.calorieTarget, cal, `${d} calorie target matches what the plan feeds you`);
    assertEq(plan.proteinTarget, protein, `${d} protein target matches`);
  }

  // The one rule that governs the diet: 180 g is a weekly average, and no
  // single day is expected to reach it.
  const stats = L.weekStats(liveDoc, records, MON, '2026-08-16');
  assertEq(stats.avgCalories, 2222, 'week averages 2,222 cal');
  assertEq(stats.avgProtein, 165, 'week averages 165 g protein');
  assertEq(stats.mealAdherence, 1, 'full week on plan -> 100% adherence');
  assertEq(L.dayPlan(liveDoc, MON).proteinWeeklyAvg, 180, 'weekly protein target is 180 g');
  assert(Object.values(expected).filter(([, p]) => p >= 180).length === 2,
    'only the two chicken days clear 180 g on their own');

  // A day nobody logged is missing data, not a zero-protein day.
  const partial = L.weekStats(liveDoc, { [MON]: records[MON] }, MON, '2026-08-16');
  assertEq(partial.nutritionDays, 1, 'averages count only logged days');
  assertEq(partial.avgProtein, 155, 'one logged day averages to itself');
}

// Weekday dinners: add on weekdays, replace on weekends.
{
  const monDinner = L.mealsFor(V5, '2026-08-10').find((m) => m.id === 'dinner');
  assertEq(monDinner.components.length, 3, 'Monday dinner = fixed sides + salmon');
  assert(monDinner.components.some((c) => c.name.startsWith('Salmon')), 'Monday dinner is salmon');
  assert(monDinner.components.some((c) => c.name.includes('farro')), 'weekday dinner keeps the starch');

  const satDinner = L.mealsFor(V5, '2026-08-15').find((m) => m.id === 'dinner');
  assertEq(satDinner.components.length, 1, 'restaurant dinner replaces the home sides');
  assert(!satDinner.components.some((c) => c.name.includes('farro')), 'weekend dinner drops the starch');
  assertEq(satDinner.name, 'Dinner out', 'weekend dinner is renamed');
  assert(satDinner.estimate, 'restaurant dinners are flagged as estimates');
  assertEq(satDinner.add, undefined, 'the override key never leaks into the meal');

  // Resolution must not mutate the config it reads from, or the second render
  // of a weekday would stack the protein on again.
  L.mealsFor(V5, '2026-08-10'); L.mealsFor(V5, '2026-08-10');
  assertEq(V5.meals.find((m) => m.id === 'dinner').components.length, 2, 'base dinner is never mutated');

  // The five CSV meal columns must survive any menu rewrite.
  assertEq(V5.meals.map((m) => m.id), ['breakfast', 'lunch', 'snack', 'dinner', 'dessert'], 'meal ids unchanged');

  // The weekend shake is the plan's protein insurance and belongs to Fri-Sun only.
  for (const d of WEEK) {
    const mods = L.dayPlan(liveDoc, d).mealModifiers;
    const weekend = [5, 6, 0].includes(L.weekday(d));
    assertEq(mods.includes('weekendShake'), weekend, `${d} shake offered only on the weekend`);
    assert(mods.includes('creatine'), `${d} tracks creatine`);
  }
  const creatine = V5.mealModifiers.find((m) => m.id === 'creatine');
  assertEq([creatine.cal, creatine.protein], [0, 0], 'creatine is adherence-only, zero calories');
}

// Lift A / Lift B as written, and the loads they start from.
{
  const A = V5.sessions.liftA.exercises;
  const B = V5.sessions.liftB.exercises;
  assertEq(A.map((e) => e.name),
    ['Conventional deadlift', 'Barbell bench press', 'Chest-supported row', 'Face pull', "Farmer's carry"],
    'Lift A exercises');
  assertEq(B.map((e) => e.name),
    ['Low-bar back squat', 'Overhead press', 'Chin-up or lat pulldown', 'Seated or lying leg curl', 'Suitcase carry or plank'],
    'Lift B exercises');
  assertEq(A.map((e) => [e.sets, e.reps]), [[3, 5], [3, 5], [3, 8], [2, 15], [3, 1]], 'Lift A sets x reps');
  assertEq(B.map((e) => [e.sets, e.reps]), [[3, 5], [3, 5], [3, 8], [3, 12], [3, 1]], 'Lift B sets x reps');
  assertEq(A.map((e) => e.startWeight), [185, 115, 95, 30, 60], 'Lift A start loads');
  assertEq(B.map((e) => e.startWeight), [135, 75, 90, 75, 45], 'Lift B start loads');
  assertEq(A.map((e) => e.goal), [275, 185, 155, 55, 100], 'Lift A goals');
  assertEq(B.map((e) => e.goal), [225, 115, undefined, 120, 70], 'Lift B goals');

  // Reference renders start, goal and rest for every exercise; a missing one
  // shows an em dash, which is the bug this catches.
  for (const [name, s] of Object.entries(V5.sessions)) {
    for (const e of s.exercises) {
      assert(e.startWeight != null, `${name}/${e.id} has a start load`);
      assert(e.goal != null || e.goalLabel, `${name}/${e.id} has a goal`);
      assert(e.rest, `${name}/${e.id} has a rest period`);
      assert(e.goalWeeks != null, `${name}/${e.id} has an estimate`);
    }
  }

  // Day 1 offers Lift A, seeded at the plan's start loads, with nothing logged.
  const offered = L.offeredSession(liveDoc, {}, MON);
  assertEq(offered.sessionId, 'liftA', 'day 1 offers Lift A');
  assertEq(offered.pushedFrom, null, 'day 1 is not pushed from anything');
  for (const e of A) {
    assertEq(L.progression(liveDoc, {}, e.id, e, MON).suggested, e.startWeight, `${e.id} prefills its start load`);
  }
  // Thursday is Lift B once Monday's A is done.
  const done = { [MON]: { date: MON, planVersion: 5, meals: {}, modifiers: {}, workout: { sessionId: 'liftA', sets: { 'bench:0': { weight: 115, reps: 5 } }, completedAt: `${MON}T07:00:00` } } };
  assertEq(L.offeredSession(liveDoc, done, '2026-08-13').sessionId, 'liftB', 'Thursday is Lift B');
}

// Tapering increments and per-exercise rounding.
{
  const dl = V5.sessions.liftA.exercises.find((e) => e.id === 'deadlift');
  const ohp = V5.sessions.liftB.exercises.find((e) => e.id === 'ohp');
  const hitAt = (exId, weight, reps, date) => ({
    [date]: { date, planVersion: 5, meals: {}, modifiers: {},
      workout: { sessionId: 'liftA', completedAt: `${date}T07:30:00`, marks: { [exId]: 'hit' },
        sets: { [`${exId}:0`]: { weight, reps }, [`${exId}:1`]: { weight, reps }, [`${exId}:2`]: { weight, reps } } } },
  });

  assertEq(L.progression(liveDoc, hitAt('deadlift', 225, 5, '2026-08-17'), 'deadlift', dl, '2026-08-24').suggested, 235,
    'deadlift climbs 10 while under the taper');
  assertEq(L.progression(liveDoc, hitAt('deadlift', 235, 5, '2026-08-17'), 'deadlift', dl, '2026-08-24').suggested, 240,
    'deadlift drops to 5 at the taper');
  assertEq(L.progression(liveDoc, hitAt('ohp', 75, 5, '2026-08-17'), 'ohp', ohp, '2026-08-24').suggested, 80,
    'press climbs 5 while under the taper');
  assertEq(L.progression(liveDoc, hitAt('ohp', 80, 5, '2026-08-17'), 'ohp', ohp, '2026-08-24').suggested, 82.5,
    'press drops to 2.5 at the taper, and is not rounded away to 5');
  assertEq(L.progression(liveDoc, hitAt('ohp', 82.5, 5, '2026-08-17'), 'ohp', ohp, '2026-08-24').suggested, 85,
    'press keeps climbing in 2.5s');

  // Walking each lift week by week, hitting every session, must actually reach
  // its goal in roughly the time the plan predicts. Increments that never carry
  // a lift to its target, or carry it there in a third of the time, are a
  // planning error the app would otherwise hide.
  for (const s of Object.values(V5.sessions)) {
    for (const e of s.exercises) {
      if (e.goal == null) continue;
      let load = e.startWeight, weeks = 1;
      while (load < e.goal && weeks < 60) {
        const date = L.addDays(MON, 7 * (weeks - 1));
        const next = L.addDays(MON, 7 * weeks);
        load = L.progression(liveDoc, hitAt(e.id, load, e.reps, date), e.id, e, next).suggested;
        weeks++;
      }
      // >= not ==: an increment that does not divide the gap steps past the
      // goal rather than stalling under it, which is the safe direction.
      assert(load >= e.goal, `${e.id} reaches its goal (${load} vs ${e.goal})`);
      assert(Math.abs(weeks - e.goalWeeks) <= 4, `${e.id} reaches its goal in ~${e.goalWeeks} wks (got ${weeks})`);
    }
  }
  // The two main lifts taper precisely so they land on the number, not past it.
  for (const id of ['deadlift', 'bench', 'squat', 'ohp', 'csrow', 'facepull', 'legcurl', 'farmer']) {
    const e = [...V5.sessions.liftA.exercises, ...V5.sessions.liftB.exercises].find((x) => x.id === id);
    let load = e.startWeight, weeks = 1;
    while (load < e.goal && weeks < 60) {
      load = L.progression(liveDoc, hitAt(e.id, load, e.reps, L.addDays(MON, 7 * (weeks - 1))), e.id, e, L.addDays(MON, 7 * weeks)).suggested;
      weeks++;
    }
    assertEq(load, e.goal, `${id} lands exactly on its goal`);
  }
}

// The restart: loads start over at the seed, they do not resume the old block.
{
  const bench = V5.sessions.liftA.exercises.find((e) => e.id === 'bench');
  const old = {
    '2026-08-03': { date: '2026-08-03', planVersion: 4, meals: {}, modifiers: {},
      workout: { sessionId: 'liftA', completedAt: '2026-08-03T07:30:00',
        sets: { 'bench:0': { weight: 150, reps: 5 }, 'bench:1': { weight: 150, reps: 5 }, 'bench:2': { weight: 150, reps: 5 } } } },
  };
  const p = L.progression(liveDoc, old, 'bench', bench, MON);
  assertEq(p.suggested, 115, 'a session before day 1 does not set day 1 loads');
  assert(p.cue.includes('Starting weight'), 'day 1 reads as a starting weight, not a layoff');

  // But history inside the new program still drives progression normally.
  const fresh = {
    ...old,
    [MON]: { date: MON, planVersion: 5, meals: {}, modifiers: {},
      workout: { sessionId: 'liftA', completedAt: `${MON}T07:30:00`, marks: { bench: 'hit' },
        sets: { 'bench:0': { weight: 115, reps: 5 }, 'bench:1': { weight: 115, reps: 5 }, 'bench:2': { weight: 115, reps: 5 } } } },
  };
  assertEq(L.progression(liveDoc, fresh, 'bench', bench, '2026-08-13').suggested, 120, 'in-program history still progresses');
  // The old session is still on the record and still exports.
  assertEq(Object.keys(L.csvToWorkouts(L.workoutsToCsv(fresh))).sort(), ['2026-08-03', MON], 'pre-restart sessions are kept, not deleted');
}

// Meal prompts follow the plan's own clock, not the app's assumptions.
{
  // Meal times come from the plan (coffee 10, midday 12, snack 14, dinner 18),
  // not from the app's old hard-coded map. With the waist due, the timed meal
  // branch outranks it only once that meal's hour has arrived, which is what
  // makes the configured hour observable rather than merely present.
  // Everything ahead of the meals on the chain is satisfied in these fixtures,
  // so the meal's own hour is the only thing left deciding the answer.
  const empty = { [MON]: { date: MON, planVersion: 5, meals: {}, modifiers: {},
    weight: 218, sleepMinutes: 450,
    workout: { sessionId: 'liftA', completedAt: `${MON}T07:30:00`, sets: {} } } };
  assertEq(L.nextAction(liveDoc, empty, [], MON, 9).id, 'waist', 'nothing to eat before the 10am coffee');
  assertEq(L.nextAction(liveDoc, empty, [], MON, 10).id, 'meal-breakfast', '10am -> coffee');
  const coffee = { [MON]: { ...empty[MON], meals: { breakfast: 'eaten' } } };
  assertEq(L.nextAction(liveDoc, coffee, [], MON, 11).id, 'waist', 'midday meal is not due at 11');
  assertEq(L.nextAction(liveDoc, coffee, [], MON, 12).id, 'meal-lunch', 'noon -> midday meal');
  // Sunday, so an unlogged lift does not (correctly) outrank dinner at 6pm.
  const SUN = '2026-08-16';
  const fed = { [SUN]: { date: SUN, planVersion: 5, weight: 218, sleepMinutes: 450,
    modifiers: {}, steps: 9000,
    meals: { breakfast: 'eaten', lunch: 'eaten', snack: 'eaten' } } };
  assertEq(L.nextAction(liveDoc, fed, [], SUN, 17).id, 'waist', 'dinner is not due at 5pm');
  assertEq(L.nextAction(liveDoc, fed, [], SUN, 18).id, 'meal-dinner', '6pm -> dinner');
}

// The day runs in one order and the NEXT bar walks it in that order.
{
  const MON = '2026-08-10';                        // lift day
  const blank = { [MON]: { date: MON, planVersion: 5, meals: {}, modifiers: {} } };
  assertEq(
    L.nextChain(liveDoc, blank, MON).map((s) => s.id),
    ['weight', 'sleep', 'training', 'meal-breakfast', 'meal-lunch',
     'meal-snack', 'steps', 'meal-dinner', 'meal-dessert', 'checkin'],
    'chain order: weight, sleep, workout, coffee, midday, snack, walk, dinner, evening log'
  );
  // The walk sits between the afternoon snack and dinner, not after dessert.
  const chain = L.nextChain(liveDoc, blank, MON);
  const at = (id) => chain.findIndex((s) => s.id === id);
  assert(at('steps') > at('meal-snack') && at('steps') < at('meal-dinner'), 'walk falls between snack and dinner');
  assert(at('checkin') === chain.length - 1, 'evening check-in is last');

  // Walked through in order: each step, once satisfied, hands off to the next.
  const day = { date: MON, planVersion: 5, meals: {}, modifiers: {} };
  const late = 23;                                  // every step is due by now
  const measured = [{ id: 'w1', takenAt: `${MON}T07:00:00`, kind: 'waist', value: 41, schemaVersion: 1 }];
  const seen = [];
  const satisfy = {
    weight: () => { day.weight = 218; },
    sleep: () => { day.sleepMinutes = 450; },
    training: () => { day.workout = { sessionId: 'liftA', completedAt: `${MON}T07:30:00`, sets: {} }; },
    steps: () => { day.steps = 9000; },
    checkin: () => { day.checkin = { symptom: 'None' }; },
  };
  for (let i = 0; i < 20; i++) {
    const n = L.nextAction(liveDoc, { [MON]: day }, measured, MON, late);
    if (n.id === 'done') break;
    seen.push(n.id);
    if (n.id.startsWith('meal-')) day.meals[n.id.slice(5)] = 'eaten';
    else satisfy[n.id]();
  }
  assertEq(
    seen,
    ['weight', 'sleep', 'training', 'meal-breakfast', 'meal-lunch',
     'meal-snack', 'steps', 'meal-dinner', 'meal-dessert', 'checkin'],
    'NEXT bar advances through the chain in order and then reports the day logged'
  );

  // Add-ons stay off the chain: creatine goes in the coffee, and a modifier the
  // day never takes has no way to resolve itself.
  const FRI = '2026-08-14';                         // weekend shake day
  const friIds = L.nextChain(liveDoc, { [FRI]: { date: FRI, planVersion: 5, meals: {}, modifiers: {} } }, FRI)
    .map((s) => s.id);
  assert(!friIds.some((id) => id.startsWith('mod-')), 'no modifier is on the chain');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
