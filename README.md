# Day 4 Protocol Timer

A browser-based lab timer for Day 4 cycling power protocols. No participant file is preloaded or published with the app.

## Use the hosted webpage

The repository includes a GitHub Pages workflow. Each push to `main` builds and publishes the timer automatically, using the same static-web-app pattern as the Core + Push Up timer.

On the hosted page:

1. Enter the participant ID.
2. Select that participant's `P# Day 4.csv` file when prompted.
3. Use the timer normally.

The installed webpage can be added to a tablet or phone home screen and is cached for offline use after a successful online load. Participant CSV files remain on the device and are never included in the webpage build.

## Load a participant

1. Start the app locally.
2. Type a participant ID such as `P6` or `P12`.
3. Click **Load protocol**.

When running locally on the lab computer, the app looks for this exact naming pattern:

```text
Day 4/Zwift Files/P# Day 4.csv
```

For example, entering `P6` loads `Day 4/Zwift Files/P6 Day 4.csv`. Files added to the Zwift folder become available automatically; the app does not need to be edited or rebuilt for each participant.

The direct folder lookup is intentionally local because a hosted browser page cannot silently access a folder on your computer. On the hosted page, entering an ID opens the file picker; drag-and-drop and **Choose CSV** are also available.

## What it shows

- Time remaining at the current power
- Current target power and inferred protocol phase
- The current Tabata effort number, such as `Tabata effort 3 of 8`
- Next power and next interval duration
- Total workout time remaining and overall progress
- A color-coded power-over-time line graph with a live position marker
- The compressed interval schedule from the loaded CSV

The timer is anchored to the computer's wall clock when **Start** or **Resume** is pressed. It saves the loaded protocol, current interval, and absolute interval deadline on this device. If the browser closes or the computer loses power, reopening the timer restores the protocol at the position the wall clock says it should have reached. A deliberately paused timer stays paused after a restart. It also requests a screen wake lock while running when the browser supports it.

## Extra warmup

Use **Add 5:00 at 50 W** before the participant-specific main set.

- If the current interval is already 50 W, its remaining time is extended by exactly five minutes.
- Otherwise, a new five-minute 50 W interval is placed immediately after the current interval.
- The button can be used repeatedly.
- **Remove added warmup** restores the originally loaded protocol.

## CSV format

Each file must contain:

```csv
time_s,power_W
0,100
1,100
2,100
```

`time_s` must be whole seconds running continuously from zero.

## Run locally

For normal use, double-click:

```text
Start Day 4 Timer.bat
```

The launcher opens the browser automatically. Keep its command window open while using the timer, then press `Ctrl+C` when finished.

For manual startup, use Node.js 22.13 or newer and pnpm:

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Keep the app inside the `Day 4/Day4ProtocolTimer` folder so its relative reference to `Day 4/Zwift Files` stays valid.
