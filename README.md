# Tracker

Single-plan training and nutrition tracker. One user, one pre-written plan. The app's job is to make executing the plan easy and to say when the numbers show it needs adjusting.

Built from `tracker-app-brief-v1.1`. No framework, no build step: vanilla JS, static files, GitHub Pages.

## Use it on your phone

1. Open the GitHub Pages URL in Safari.
2. Share → **Add to Home Screen**. It installs as a standalone app and works fully offline.
3. Data lives on the phone (localStorage), never on a server. Autosaves on every tap.

`?demo` on the URL shows the app with three weeks of sample data without touching your real data.

## Back up your data

Settings → **Export backup** downloads `days.csv`, `workouts.csv`, `measurements.csv`, and the active plan config. Import the same files on a new phone; import is idempotent, so re-importing changes nothing. Do this before replacing your phone; there is no cloud copy.

## Edit the plan

Everything about the plan lives in **`config/plan.json`**: meals and components, calorie/protein targets, the weekly schedule, lift sessions, progression parameters, ramp-in phases. No plan value appears in application code.

To revise the plan:

1. Copy the current version object inside `versions`, append it as a new entry.
2. Bump `planVersion`, set a new `effectiveFrom` date, edit values.
3. **Leave the old version object in place.** History is valued against the version in force when it was logged.
4. Commit and push. The service worker picks up the change on the next open (or the one after, on a slow connection).

A portion change is one line in a meal's `components`; totals are derived.

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

## Tests

```
node tests/logic.test.mjs
```

Covers the brief's acceptance criteria that are computable: trend slope vs independent least squares, A/B alternation after a missed Monday, miss attribution (over-reach never triggers deload), CSV export/import round-trip, per-`planVersion` history valuation, phase overrides, the recommendation ladder.

## Not in this build (web platform limits)

- HealthKit (steps/sleep auto-fill): a web app can't read Apple Health. Steps and sleep are two-tap manual entries; everything in the brief's §9.1 fallback path works.
- Scheduled notifications: iOS home-screen web apps support push only with a server, which would break local-only data. The NEXT bar covers sequencing while the app is open.

Everything else in the brief through Phase 3 is implemented.
