---
section: Using harness-pilot
---
# Notifications

The notifications feed collects what happens around you - finished sessions, cron jobs, sales, orders,
deployments, important e-mails, any script's result - in one place instead of chat messages, in your language.

## Where you see it

- **Notifications** in the sidebar (a tile in the menu on a phone), with the unread count: it opens the
  notifications centre. **To handle** on top - the warnings and errors you have not read and that are not solved
  yet, with their buttons (*Run again*, *Resume*, *Add the secret*...) - then the activity by day.
- **See all notifications** (page `/notifications`): the last 30 days, filters by type (*Sessions*, *Crons*,
  *System*, *Webhooks*), *Unread only*, *Mark all as read*. Open an event to see its details and, for a folded row,
  each occurrence.
- **Dashboard**: a **To handle** card appears only when something needs you.
- **In a session**: a discussion paused by its limit shows a banner with the time it paused, **Change limits** and
  **Resume**.
- **In this browser**: a short sound per level (choose the sounds and the volume, or none) and, when the app is in
  the background, a system notification.
- **Push notifications** (optional): allow them on a phone or a computer and the important events arrive even when
  the app is closed - per type of event, with or without sound.
- **Telegram** (optional): the bot posts in the thread **Notifications** by itself - no Claude, instant.
  Under each message, **Ask harness-pilot** opens a session about it, and **Open** follows its link.

Click an event to mark it read and open its link (the cron job's history, the Stripe payment, the
GitHub run…). Its **…** menu marks it read or deletes it. Repeated events fold into one row
(*Cron jobs succeeded ×12*, *Cron failed: Backup ×3*) until you read it.

A problem leaves **To handle** by itself when it is solved: the cron job's next run succeeds, the discussion
resumes, the webhook gets its signing secret, the health issue goes away, the site is back up. You can also mark it
read, or solved.

## What arrives by itself

| Source | Events |
|---|---|
| **Sessions** | a session finished or failed (folded per session); a Claude Code + Codex discussion paused because it reached its number of replies or its duration (**Resume** right from the notification) |
| **Cron jobs** | every run: failures folded per job (with the latest error, **Run again**), successes folded into one row |
| **harness-pilot** | an update is available or needs attention, Claude Code updated (or could not), a server health issue (disk full, Claude signed out, old backup...), vulnerable dependencies, a [task reminder](tasks) |
| **Sign-ins** | sign-ins (folded), several wrong passwords, a webhook refused for lack of its signing secret |

## Connect a service (webhooks)

Settings -> **Notifications** -> **Add a webhook**, choose the service, give it a name, paste its
signing secret if you have it, **Create**: copy the URL into the service. The dialog says where.

| Service | What you get |
|---|---|
| **Stripe** | sales (*Sale: 49.00 EUR*), payments, refunds, failed payments, disputes, subscriptions |
| **Shopify** | new / paid / cancelled orders, refunds, stock updates (out of stock as a warning) |
| **GitHub** | pushes, pull requests, issues, failed / passed workflows, releases |
| **Generic JSON** | anything: POST `{"title", "body", "level", "url", "id"}` |

- Webhooks need the server **reachable from the Internet with HTTPS** (domain mode). With Tailscale only,
  use a script (below).
- Set the **signing secret** the service gives you. Stripe, Shopify and GitHub sources **refuse every event
  until the secret is set** (a warning appears in the feed); with Stripe you get the secret only after adding
  the URL there, so create the source, add the URL in Stripe, then paste the secret. A *Generic JSON* source
  works without a secret, but then anyone who learns the URL could send fake events. The source's **…** menu: *Send a test event*, *Set the signing secret*, *New URL* (the old one
  stops working), *Delete*.
- A delivery sent twice (services retry) appears once, even when both copies arrive at the same moment. For Shopify
  and GitHub, a signed event replayed by someone who captured it also appears only once. Up to 120 deliveries per minute per source.

## From any script

```bash
pilot feed post "Invoice from ACME: 39 EUR due Friday" --source mail --level warning \
  --body "From billing@acme.example" --dedupe "msg-1234"
```

`--level` info | success | warning | error · `--source` short name · `--url` link · `--dedupe KEY`
(the same key twice is ignored) · `--group KEY` (fold repeats) · `--quiet` (in the feed only: no Telegram message,
no push notification, no sound or notice in the app) ·
`--kind NAME` (your own type of event, e.g. `backup.offsite`: it gets its own row in the Telegram and push settings) ·
`--param NAME=VALUE` (details kept with the event) · `--link "Label=https://..."` (a button under the event, up to 4;
an address starting with `https://` or a page of the app such as `/files?path=...`).
`pilot feed list` (`--pending`: what needs attention), `pilot feed read-all`. Run the script with a cron job.

Just ask Claude: *"notify me when an e-mail from my accountant arrives"*, *"tell me when the site is
down"*, *"connect my Shopify orders"* - it writes the script and the job, or sets up the webhook.

## What goes to Telegram

Settings -> Notifications, per type of event (or for a whole source):

| Rule | Effect |
|---|---|
| **Auto (by level)** (default) | errors ring, warnings are silent, info / success stay in the app |
| **Not in Telegram** | the app only |
| **Telegram, silent** | posted without a sound |
| **Telegram, rings** | posted with a sound (e.g. your sales) |

Cron jobs, updates and sign-ins already report in their own threads (*Crons*, *Alerts*), and sessions are already
in their topic threads: they are not repeated in *Notifications* unless you choose so. A choice made for one type of
event (e.g. *Cron failed: rings*) wins over the choice of its source. The switch at the top turns the Telegram
thread off.

## Push notifications

Settings -> Notifications -> **On this device** -> **Receive even when the app is closed**: turn it on in each browser
(phone or computer) where you want them; on an iPhone, add harness-pilot to the home screen first. **Send a test**
checks that they arrive. By default warnings and errors are pushed; in **What and where**, the *Browser* and *Sound*
columns choose per type of event whether it reaches this browser and whether it makes a sound (e.g. *Session
finished: browser, silent*). A webhook or a script is pushed with all its events while its *Browser* box is ticked
(sales ring by default), and not at all once you untick it. Push needs HTTPS (domain mode, or Tailscale with HTTPS); a browser that unsubscribes is
forgotten by itself.

## Good to know

- Events are kept 30 days. They live on your server (`/var/lib/claude-maxxing/feed.db`).
- A webhook's content comes from outside: *Ask harness-pilot* treats it as data, never as instructions, and opens the
  session in plan mode (Claude explains, it changes nothing until you approve a plan).
