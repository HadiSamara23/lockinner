# lockInner

Lock in on your own tasks. Add a task with a deadline, and a slightly rude coach checks in at random times until it's done: politely at first, less politely if you keep saying "not yet".

Plain HTML/CSS/JS. No build step, no framework, no backend. Your data stays in your browser's localStorage. Push notifications go through [ntfy](https://ntfy.sh).

## Setup on iPhone (about 3 minutes)

1. Open the lockInner URL in **Safari** and bookmark it.
   Don't use "Add to Home Screen". iOS gives home-screen web apps separate storage, and links from notifications open in Safari, so your tasks need to live in Safari.
2. Install **ntfy** from the App Store (free, no account).
3. In lockInner, tap **Phone off** (top right) → copy your private topic.
4. In ntfy tap **＋**, paste the topic, leave "Use another server" off, and subscribe. Allow notifications when iOS asks.
5. Back in lockInner, tap **Send test ping**. When your phone buzzes, tap **It buzzed, turn on**.

Done. Check-ins now arrive with lockInner closed.

## How it works

- **Scheduling.** Each task gets random check-ins between 09:00 and 22:00, 1–3 / 2–4 / 3–6 per day for Mild / Spicy / Unhinged. The original v1 algorithm is kept, except each day is split into slots so check-ins don't bunch up. One extra "deadline passed" check-in fires 15 min after the deadline.
- **Delivery.** lockInner pre-schedules check-ins on ntfy.sh using delayed delivery, looking up to ~70h ahead (ntfy.sh allows 3 days max). Each check-in has a sequence ID, so marking a task done, blocking it or removing it deletes its queued pushes. When a task runs longer than the window, a final "Nag supply low" push reminds you to open the app so it can queue more.
- **Notification buttons:**
  - **Done ✓** opens lockInner and marks the task done (with the celebration).
  - **Snooze 1h** re-posts the nudge to ntfy with a 1h delay. It works without opening lockInner.
  - **On it 💪** posts to your `<topic>-ctl` channel. lockInner picks it up the next time it opens.
  - **Tapping the notification** opens lockInner on that task's check-in sheet.
- **Adaptive replies:**
  - **On it** clears nudges for the next 90 min, schedules a follow-up, cools the coach down one step and adds to the 🔥 streak.
  - **Not yet** / **Snooze** schedule a sooner check-in (~1h) and heat the coach up one step.
  - **Blocked** pauses all nudges, remembers what's blocking you, and pokes you about it once, ~3h later during waking hours.
  - Follow-ups never land between 22:00 and 09:00; they move to the next morning.

## Deploying (GitHub Pages)

```bash
git init && git add . && git commit -m "lockInner"
gh repo create lockinner --public --source . --push
gh api -X POST repos/{owner}/lockinner/pages -f "source[branch]=main" -f "source[path]=/"
```

The app is served at `https://<user>.github.io/lockinner/`. The notification links point at whatever URL you used when turning phone alerts on.

Run locally: `python3 -m http.server 5174`, then open http://localhost:5174.

## Data & privacy

- Tasks, the log and settings are stored in localStorage (`lockinner_tasks_v2`, `lockinner_log_v2`, `lockinner_settings_v2`).
- v1 data (`lockinner_tasks_v1`, `lockinner_log_v1`) is migrated automatically on first load, and the v1 keys are left untouched as a backup.
- Task names and check-in text pass through ntfy.sh. Your random topic works like a password: anyone who knows it can read your nudges. To avoid ntfy.sh entirely, self-host ntfy and change the server under **More settings**.
- **Export / Import** under More settings backs up and restores everything as JSON.

## Known limitations

- Phone replies ("On it", "Snooze") are applied the next time lockInner opens, and only if that's within 12h (ntfy.sh's cache window). "Done" always works because it opens the app.
- If you don't open lockInner for ~3 days, pre-scheduled nudges run out. You'll get a "Nag supply low" push when that happens.
- Check-in text is written when a check-in is scheduled. It's rewritten when you reply or change attitude, but it can't react to things that happen while the app is closed.
- A snoozed nudge can't be cancelled from the app. If you mark a task done within the hour, one last snooze message may still arrive.
- ntfy.sh anonymous rate limits are around 60 requests in a burst, then 1 every 5s. lockInner batches up to 40 per sync and retries after a minute if it's throttled.
