# Terrier Timing

Trackside stopwatch for St. Francis Prep. Runs in a phone browser (add it to the home screen); no server needed.

## Files
`index.html`, `app.mjs`, `engine.mjs`, `style.css`, `logo.png`, `icon-180.png` are the app. For GitHub Pages, upload those to the top level of the repo.
`standalone.html` is the same app as a single file. Rebuild it after any change with `node build.mjs`.
Run the engine checks with `node --test tests/engine.test.mjs`.

## What it does
- Planned workouts from plain text: `3200 tempo`, `4min rest`, `400-600-400-200 2min rest`, `5x150 90s rest`, `2 sets of 4x400 1min rest, 6min between sets`.
- Mid-run splits: add `split 400` or `splits every 200` to a line, then tap the flag beside a runner (or Split all).
- The written workout runs across the top with the current line highlighted; the timer's Next row shows as many upcoming runs as fit.
- Reset: stop or restart a rest, or clear the current rep and start over.
- Per-runner changes: a different distance or planned skips, set ahead of time or mid-workout (runner menu > Change this runner's workout).
- Timing packs: group runners to start, split, or finish together. Drag the grip to reorder or move runners between packs.
- Finished runners can drop to the bottom of the list (toggle in the Runners options).
- Slide a runner to the right to delete. Tap the active group tab again for group options, including delete.
- Export: CSV matches the Results screen (runners down, reps across). Detailed CSV has one row per time, in seconds.
