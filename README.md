# Tracker

Single-plan training and nutrition tracker. One user, one pre-written plan. The app's job is to make executing the plan easy and to say when the numbers show it needs adjusting.

Built from `tracker-app-brief-v1.1`. No framework, no build step: vanilla JS, static files, GitHub Pages.

## Use it on your phone

1. Open the GitHub Pages URL in Safari.
2. Share → **Add to Home Screen**. It installs as a standalone app and works fully offline.
3. Data lives on the phone (localStorage), never on a server. Autosaves on every tap.

A new build installs in the background and the app reloads itself once to pick it up, so a fix is live the next time you open it rather than the time after. The reload is skipped while a sheet or the logger is open, so it never interrupts entry.

**Settings → Build** shows which cached build is actually running (`tracker-vN`), read from the service worker's own cache rather than from what was last deployed. If it lags the latest version, close the app fully and reopen it. Do not clear website data to force an update: that is where your log lives, and clearing it erases everything not exported.

`?demo` on the URL shows the app with three weeks of sample data without touching your real data.

## Back up your data

Settings → **Export backup** downloads `days.csv`, `workouts.csv`, `measurements.csv`, and the active plan config. Import the same files on a new phone; import is idempotent, so re-importing changes nothing.

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

`programStart` may be in the future. Until it arrives the header reads *Starts Monday, Aug 10* rather than counting down from day zero, while the current `effectiveFrom` version already governs what you eat — so a new menu can take effect the evening before the block it belongs to.

### Meals that change by weekday

`meals` holds the blocks eaten every day. **`weekdays`** overrides them by day number (`"1"` = Monday), and carries that day's `calorieTarget`, `proteinTarget`, and any day-specific `mealModifiers`:

- `"dinner": { "add": [ ... ] }` puts the day's own items at the front of the block, ahead of the fixed sides.
- `"dinner": { "components": [ ... ] }` replaces the block outright, for a restaurant meal where the fixed sides are not eaten at all. Add `"estimate": true` and the app labels it as approximate.

Meal **ids** are the five CSV columns and must stay `breakfast, lunch, snack, dinner, dessert`; the `name` shown on screen is free to change. Each meal's `hour` is when the app starts prompting for it.

Protein has two numbers, and they are not the same: `targets.proteinWeeklyAvg` is the goal (a **weekly average**, judged on the This week screen) and each weekday's `proteinTarget` is what that day is actually built to deliver. No single day is expected to hit the weekly number.

### Progression per exercise

Beyond `increment`, an exercise may set `taperAbove` + `taperIncrement` (climb in big jumps until the bar gets heavy, then smaller ones) and its own `roundToNearest`, which is what makes a 2.5 lb press increment survive instead of rounding back into a 5. `goal`, `goalWeeks`, `startLabel`, `goalLabel`, `rest`, and `scheme` are description only; they render on the Reference tab and never affect a suggestion.

## Structure

```
index.html              shell
css/style.css           design system (tokens in :root)
js/logic.js             all business logic — pure functions, no DOM
js/app.js               rendering, storage, sheets
config/plan.json        the plan (versioned; append, never overwrite)
sw.js                   offline cache (bump VERSION on breaking changes)
tests/logic.test.mjs    run: node tests/logic.test.mjs
```

## What's next

The bar under the header walks the day in one fixed order:

**weight → sleep → workout → coffee → midday meal → afternoon snack → walk → dinner → dessert → evening check-in.**

Each step carries the hour it comes due (the meals use their own hours from `plan.json`; the walk comes due at 4pm), so the bar waits for a block rather than asking about dinner at breakfast. It never reorders the list around the clock: the first unsatisfied step whose hour has arrived is what it shows, and if nothing is due yet it names the earliest thing still unmarked. A due waist measurement slots in after the day's own steps, and an overdue backup only surfaces once the day is fully logged.

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

## Meals

Four states: **ate the planned meal**, **ate something similar**, **ate off-plan**, **skipped**. Off-plan means food that was eaten but departed from the plan (low protein, heavy carbs, restaurant). It counts toward the day's calories and protein, because a meal was eaten, but it does not count toward meal adherence, which is the number the weekly recommendation acts on.

Dinner changes by weekday, so the Today screen shows the day's own dinner and the day's own calorie and protein targets. Add-ons under the meals (creatine, the pre-training carb on lift days, the weekend whey shake) are ticked on the days you take them; a zero-calorie one is tracked for adherence only.

## Tests

```
node tests/logic.test.mjs
```

Covers the brief's acceptance criteria that are computable: trend slope vs independent least squares, A/B alternation after a missed Monday, which lift a day is on once a workout has been started on it, miss attribution (over-reach never triggers deload), CSV export/import round-trip, per-`planVersion` history valuation, phase overrides, the recommendation ladder, the set marks (including that a grindy session breaks a miss streak), seeded start loads, and off-plan meals counting calories without counting adherence.

The engine cases run against the plan shape they were written for; the live `config/plan.json` gets its own section, which checks the shipped plan rather than the code: that eating the plan produces the day totals the plan document itself prints, that the week averages to the numbers it claims, that the weekend shake is offered Friday to Sunday only, that every exercise carries a start load and a goal, and that walking each lift week by week from its start load actually arrives at its goal in roughly the stated number of weeks. That last one is a check on the plan's arithmetic, not the app's: an increment that can never reach its target fails here.

There is also a browser-level test for the things no pure-logic test can show: that a day logged while viewing a past date is written to that date rather than today, that a logged workout stays reachable on a day the calendar does not offer a lift, and that the training button opens the lift it names. It needs Chrome and a local server; see the header of the file for the exact commands. It pins the page clock (`TRACKER_FAKE_NOW`) so it does not depend on today being a convenient day of the program, and bypasses the service worker so it always grades the code on disk rather than a cached build.

```
node tests/backfill.browser.mjs
```

## Not in this build (web platform limits)

- HealthKit (steps/sleep auto-fill): a web app can't read Apple Health. Steps and sleep are two-tap manual entries; everything in the brief's §9.1 fallback path works.
- Scheduled notifications: iOS home-screen web apps support push only with a server, which would break local-only data. The NEXT bar covers sequencing while the app is open. To replicate the brief's §9.2 schedule, create three repeating iOS Reminders (they cost nothing and match the spec's copy):
  - 6:30am daily — "Good morning. Weight and sleep."
  - Your usual session time — "Training today."
  - 8:30pm daily — "Check-in: one tap."

Everything else in the brief through Phase 3 is implemented.
