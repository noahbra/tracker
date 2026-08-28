# Tracker

Single-plan training and nutrition tracker. One user, one pre-written plan. The app's job is to make executing the plan easy and to say when the numbers show it needs adjusting.

Built from `tracker-app-brief-v1.1`, currently running the v2.0 build spec (plan **v7**, effective Monday 8/24/2026). No framework, no build step: vanilla JS, static files, GitHub Pages.

The plan it executes now: two strength days off the barbell squat and deadlift, three cardio exposures with the hike on Saturday, a phased chin-up progression, and a daily Achilles rehab protocol with a clinician gate.

## Use it on your phone

1. Open the GitHub Pages URL in Safari.
2. Share → **Add to Home Screen**. It installs as a standalone app and works fully offline.
3. Data lives on the phone (localStorage), never on a server. Autosaves on every tap.

A new build installs in the background and the app reloads itself once to pick it up, so a fix is live the next time you open it rather than the time after. The reload is skipped while a sheet or the logger is open, so it never interrupts entry.

**Settings → Build** shows which cached build is actually running (`tracker-vN`), read from the service worker's own cache rather than from what was last deployed. If it lags the latest version, close the app fully and reopen it. Do not clear website data to force an update: that is where your log lives, and clearing it erases everything not exported.

`?demo` on the URL shows the app with three weeks of sample data without touching your real data.

## Back up your data

Settings → **Export backup** hands `days.csv`, `workouts.csv`, `measurements.csv`, `clinician.csv`, and the active plan config to the **iOS share sheet**, so the files land in Files or iCloud rather than in the app's own sandbox — which is the storage the backup is insurance against. Where no share sheet exists (desktop browsers), it falls back to plain downloads. Import the same files on a new phone; import is idempotent, so re-importing changes nothing.

`clinician.csv` is the timeline to hand someone: every day the Achilles was rehabbed or reported on, the load used, and every muscle-symptom day.

There is no cloud copy, and iOS can evict web storage for apps unused for extended periods (home-screen apps are treated more gently, and the app requests persistent storage, but neither is a guarantee — and PWA storage is not in iCloud device backups). So the app watches for you: when the last export is more than four weeks old, an **Export a backup** prompt appears on the This week screen and stays until you export. Save the files to iCloud Drive when Safari asks where to put them.

## Edit the plan

Everything about the plan lives in **`config/plan.json`**: meals and components, calorie/protein targets, the weekly schedule, lift sessions, per-exercise `startWeight`, progression parameters, ramp-in phases. No plan value appears in application code.

To revise the plan:

1. Copy the current version object inside `versions`, append it as a new entry.
2. Bump `planVersion`, set a new `effectiveFrom` date, edit values.
3. **Leave the old version object in place.** History is valued against the version in force when it was logged.
4. Commit and push. The service worker picks up the change on the next open (or the one after, on a slow connection).

A portion change is one line in a meal's `components`; totals are derived.

### Starting or restarting the program

Day 1 is the top-level **`programStart`** date, outside `versions`. Move that one date and the whole program restarts: the day and week counters, the earliest day you can step back to, the week screen, and the loads. Old versions keep the `effectiveFrom` dates on which they were really in force, so a restart never rewrites history.

Sessions logged before `programStart` stay on the record and still export, but they no longer set today's load: a restart resumes from each exercise's `startWeight`, not from where the last block left off.

`programStart` may be in the future. Until it arrives the header reads *Starts Monday, Aug 24* rather than counting down from day zero, while the current `effectiveFrom` version already governs what you eat — so a new menu can take effect the evening before the block it belongs to.

### Meals that change by weekday

`meals` holds the blocks eaten every day. **`weekdays`** overrides them by day number (`"1"` = Monday), and carries that day's `calorieTarget`, `proteinTarget`, and any day-specific `mealModifiers`:

- `"dinner": { "add": [ ... ] }` puts the day's own items at the front of the block, ahead of the fixed sides.
- `"dinner": { "components": [ ... ] }` replaces the block outright, for a restaurant meal where the fixed sides are not eaten at all. Add `"estimate": true` and the app labels it as approximate.

Meal **ids** are the five CSV columns and must stay `breakfast, lunch, snack, dinner, dessert`; the `name` shown on screen is free to change. Each meal's `hour` is when the app starts prompting for it.

Protein has two numbers, and they are not the same: `targets.proteinWeeklyAvg` is the goal (a **weekly average**, judged on the This week screen) and each weekday's `proteinTarget` is what that day is actually built to deliver. No single day is expected to hit the weekly number.

### Progression per exercise

Beyond `increment`, an exercise may set `taperAbove` + `taperIncrement` (climb in big jumps until the bar gets heavy, then smaller ones) and its own `roundToNearest`, which is what makes a 2.5 lb press increment survive instead of rounding back into a 5. `goal`, `goalWeeks`, `startLabel`, `goalLabel`, `rest`, and `scheme` are description only; they render on the Reference tab and never affect a suggestion.

Every exercise also names a **`progressionKey`**, and `progressionRules` in the same version says what that key does. There is no scripting language here and there is not going to be one — five shapes cover the plan:

| `type` | What it does | Used by |
|---|---|---|
| `load` | Add the increment on a clean session. `cleanSessionsBeforeAdvance: 2` holds the load until it has been carried cleanly twice. | bench, press, rows, leg curl |
| `repsThenLoad` | Reps first (`repFrom` → `repTo`), then the increment and back to `repFrom`. | split squat, cable pull-through, leg extension |
| `repsThenVariation` | Reps to a ceiling, then offer the next entry in `variations`. Never more reps past the ceiling. | push-ups |
| `repLadder` | A fixed `ladder` of rep targets, then `thenLoad` if the rule sets one. Regresses a rung on a miss. | back extension, farmer's carry |
| `subjective` | Hold the load and state the gate; a session marked **Hit** is you saying the gate was cleared. | suitcase carry, side plank, Pallof press |

An exercise with `"entry": "reps"` or `"entry": "seconds"` carries no load at all, and the logger shows one box instead of two. A bodyweight set reads **BW**, not 0.

A **carry** is the one place the second box is not reps. The farmer's carry sets `"repsAre": "yards"` and progresses on a `repLadder` of distances (40 → 50 → 60 → 70) with the load held at 60 / hand, because the dumbbell rack ran out before the grip did. Log it as `60 × 40`, meaning 60 lb per hand for 40 yards. The suitcase carry on Strength A has not hit that ceiling and still progresses by load.

### The chin-up, which is a phase and not a load

`chinup.phases` holds three: build the pulldown, cross the gap with negatives or a band, then accumulate reps to 3 × 8. Phase 1's gate is two numbers, not one: `target: 160` and `orBodyweightPct: 0.75`, and it opens on whichever arrives first. A chin-up is a strength-to-bodyweight ratio, so a target fixed at one weight gets stricter every pound down; the ratio gate reads the 7-day rolling average and can only lower the bar, never raise it above the plan's own number. The app works out which phase you are in, shows **only that one**, and tracks how close its trigger is. Meeting a trigger **prompts**; the phase moves when you accept it, and accepting is what writes `chinPhase` onto that day's workout. Each phase names its own real exercises (`pulldown`, `chinbar`, `chinup`), so history survives the change.

### The Achilles protocol

`rehab.achilles` is its own daily card on Today, deliberately outside the strength days: it has to happen whether or not there was a session. It logs the load, not the reps, because that is how it progresses. The **morning reading** (better / same / worse) lives in the evening check-in, because the next morning is what judges the exercise. A `worse` reading pulls back in the order the plan sets — hike, then the split squat, then cardio off the feet — and the rehab load comes down last, since it is the thing rebuilding the tendon.

The clinician flag on that card is a gate, not a notice: bilateral and spontaneous is the presentation that wants a look first. It comes down only by recording that a clinician has actually looked, and there is no dismiss.

### Steps

`9,000` is a movement floor for the day, not a number on top of the walking sessions, and `63,000` is the week. The step gauge clears on **either** the daily target or the week being on pace, so a 14k hike banks against an 8.2k recovery day. Nothing ever converts cardio minutes into steps: a bike session satisfies the cardio prescription and leaves the step count exactly where it was.

## Structure

```
index.html              shell
css/style.css           design system (tokens in :root)
js/logic.js             all business logic — pure functions, no DOM
js/app.js               rendering, storage, sheets
config/plan.json        the plan (versioned; append, never overwrite)
sw.js                   offline cache (bump VERSION on breaking changes)
tests/logic.test.mjs    run: node tests/logic.test.mjs
tests/*.browser.mjs     run against a real Chrome; see each file's header
```

## What's next

The bar under the header walks the day in one fixed order:

**weight → sleep → workout → coffee → midday meal → afternoon snack → Achilles heel raises → walk → dinner → dessert → evening check-in.**

On a Sunday the blood-pressure reading slots in ahead of the coffee, because caffeine lifts the number for a couple of hours and a reading taken after it is not comparable to the ones before it. Taking it and waving it off for the week both count as resolving it: a skippable prompt that cannot be skipped would hold the bar until midnight.

The heel raises come before the walk, not after the day's meals. They are the loaded work of a rest day and the walk is the easy thing that follows them, so the order is snack, rehab, walk, dinner. Each step carries the hour it comes due (the meals use their own hours from `plan.json`; the heel raises at 3pm, the walk at 4pm), so the bar waits for a block rather than asking about dinner at breakfast. It never reorders the list around the clock: the first unsatisfied step whose hour has arrived is what it shows, and if nothing is due yet it names the earliest thing still unmarked. A due waist measurement slots in after the day's own steps, and an overdue backup only surfaces once the day is fully logged.

The add-ons under the meals (creatine, the pre-training carb, the weekend shake) stay off the chain. Creatine goes in the coffee, so the coffee step already carries it, and a modifier has no "skipped" state: one you were never going to take would hold the bar for the rest of the day.

## Fill in a missed day

The date in the Today header is a control. Step back with `‹`, or tap any day in the **This week** strip, and the whole screen points at that date: weight, meals, steps, check-in, and the lift logger all read and write that day. A brass line under the header says you are filling in a past day and takes you back to today.

You cannot step past today, or back before day 1 of the program. Sessions logged on a past day carry that day's date, so they feed the A/B alternation and progression history exactly as if they had been logged live.

## How the set felt

Every exercise in the logger has **Hit · Grindy · Missed**. This is what the app uses to pick next session's load:

| Mark | Next time |
|------|-----------|
| Hit | Add the increment |
| Grindy | Repeat the same weight |
| Missed | Repeat; two consecutive misses deload to 90% of the last good load |

Grindy exists because it cannot be inferred. All the reps were completed, so the logged numbers are indistinguishable from a clean set. It counts as a success (it never contributes to a deload) but it does not advance the load. A session left unmarked falls back to inferring hit-or-miss from the reps, which is how every session logged before marks existed is still read correctly.

## Starting weights

Each exercise in `config/plan.json` carries a `startWeight`. It is what the logger prefills the first time that lift appears, before there is any history to progress from. After the first session, history wins and the seed is ignored — history from the current program, that is: a session logged before `programStart` belongs to a previous block and does not carry into this one.

## Measurements

Waist every 14 days is the measurement the plan runs on, and blood pressure is the Sunday one, taken before the day's coffee. Resting heart rate and grip were dropped: neither changed a decision, and a reading nobody acts on is a prompt with no payoff.

Readings taken before they were dropped stay on the record, still export, and still render with their names on the Reference tab. Ending the tracking is not the same as deleting the history.

## Meals

Four states: **ate the planned meal**, **ate something similar**, **ate off-plan**, **skipped**. Off-plan means food that was eaten but departed from the plan (low protein, heavy carbs, restaurant). It counts toward the day's calories and protein, because a meal was eaten, but it does not count toward meal adherence, which is the number the weekly recommendation acts on.

Dinner changes by weekday, so the Today screen shows the day's own dinner and the day's own calorie and protein targets. Add-ons under the meals (creatine, the pre-training carb on lift days, the weekend whey shake) are ticked on the days you take them; a zero-calorie one is tracked for adherence only.

## Tests

```
node tests/logic.test.mjs
```

Covers the brief's acceptance criteria that are computable: trend slope vs independent least squares, A/B alternation after a missed Monday, which lift a day is on once a workout has been started on it, miss attribution (over-reach never triggers deload), CSV export/import round-trip, per-`planVersion` history valuation, phase overrides, the recommendation ladder, the set marks (including that a grindy session breaks a miss streak), seeded start loads, and off-plan meals counting calories without counting adherence.

The engine cases run against the plan shape they were written for; the live `config/plan.json` gets its own section, which checks the shipped plan rather than the code: that eating the plan produces the day totals the plan document itself prints, that the week averages to the numbers it claims, that the weekend shake is offered Friday to Sunday only, that every exercise carries a start load and a goal, and that walking each lift week by week from its start load actually arrives at its goal in roughly the stated number of weeks. That last one is a check on the plan's arithmetic, not the app's: an increment that can never reach its target fails here.

```
node tests/rehab.browser.mjs
```

That second browser test covers the medical gates, which are the one part of this app where a rendering bug is worse than a crash: that the clinician flag shows with exactly one control (record it cleared, never dismiss it), that the dark-urine notice has no control at all, that ticking the rehab card writes the load, that a `worse` morning names the hike first and takes a loaded rehab down a step, and that Export actually produces all five files.

There is also a browser-level test for the things no pure-logic test can show: that a day logged while viewing a past date is written to that date rather than today, that a logged workout stays reachable on a day the calendar does not offer a lift, and that the training button opens the lift it names. It needs Chrome and a local server; see the header of the file for the exact commands. It pins the page clock (`TRACKER_FAKE_NOW`) so it does not depend on today being a convenient day of the program, and bypasses the service worker so it always grades the code on disk rather than a cached build.

```
node tests/backfill.browser.mjs
node tests/measurements.browser.mjs
```

## Not in this build (web platform limits)

- HealthKit (steps/sleep auto-fill): a web app can't read Apple Health. Steps and sleep are two-tap manual entries; everything in the brief's §9.1 fallback path works.
- Scheduled notifications: iOS home-screen web apps support push only with a server, which would break local-only data. The NEXT bar covers sequencing while the app is open, and the movement-break habit is one silenceable line on Today (Settings → Movement breaks) rather than a notification it cannot actually deliver. **Do not "fix" this by claiming background scheduling works.** To get an actual buzz, create repeating iOS Reminders:
  - 6:30am daily — "Good morning. Weight and sleep."
  - Your usual session time — "Training today."
  - Every 45 min while at the desk — "Stand and walk."
  - 3pm daily — "Heel raises, then the walk."
  - Sunday morning — "Blood pressure, before the coffee."
  - 8:30pm daily — "Check-in: one tap, plus the Achilles."

Everything else in the build spec through Phase 3 is implemented.
