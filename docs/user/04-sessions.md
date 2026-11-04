---
section: Using harness-pilot
---
# Sessions

A **session** runs in a topic folder and can use Claude Code, Codex, or both in an automatic discussion. Sessions are persistent:
close the browser, restart the server, come back next month – the conversation continues where it
stopped.

## Claude subagent team

Choose **Claude swarm** under **Several agents** when creating a session and request two to six subagents. Claude acts as coordinator and is instructed to split suitable work into independent tasks, use its native subagents in parallel, and combine their results. This is a request to Claude, not a guarantee of the number of agents or a hard concurrency limit. Each agent's work consumes the relevant account's usage allowance and follows the session's permissions.

Open **Agent map** from the session menu to inspect agent calls present in the loaded conversation, their status and their reported result. Load earlier messages to include older calls. Claude's internal subagent transcripts are not always available. Subagents cannot be stopped one by one: they run inside Claude's current turn, and Claude Code does not stop a single one of them on request. Stop the session to interrupt the coordinator and all its subagents; verify the displayed statuses and resulting files afterward.

## Mixed Claude and Codex team

Choose **Mixed team** under **Several agents** and send a written mission, with files or images if needed. Claude examines the approach and steps while Codex independently examines risks, alternatives and verification. The two analyses run in separate sessions; after they finish, the coordinator synthesizes the available reports in its session. Those are the default roles: change either one in the form before sending (**Default roles** puts them back). Choose the **Coordinator** too: Claude Code by default, or Codex; it writes the synthesis in the session you are in, with the topic permissions. The **Claude model** and **Codex model** fields apply to each agent of that kind, coordinator included (empty: its default model). Each agent receives its role with the mission, the team panel shows it, and the coordinator names both in its synthesis. The team does not split a mission into arbitrary subtasks. The two providers must be available and signed in; their normal usage allowances apply.

While the team works, its panel above the message box shows the steps (**Starting**, **Agents working**, **Synthesis**, **Done**) and, for each agent, how long it has worked, its last actions (files read, searches, commands, what it says) and, once it has finished, the start of its report. The panel folds to one line when the team is over; click it to open it again. Use **Open session** to inspect a worker's live activity and full result. **Stop agent** interrupts that worker without stopping its peer; **Stop team** interrupts both and the coordinator. A stopped or failed report is identified as missing in the synthesis. Worker sessions remain in the session list and can be reopened. If the web server restarts, orchestration resumes when it is available again. The analysis workers are requested not to edit files or take external actions and use the providers' plan/read-only modes; those settings are not a complete operating-system isolation boundary. The coordinator uses the topic's configured permissions and may act on the mission. Files and images attached to the mission go to both agents and to the coordinator: Claude opens them itself, Codex receives the images directly (PNG, GIF, WebP or JPEG up to 3.5 MB) and the location of every other file. Each agent reads them with its own subscription. The mission is written: the microphone dictates it into the text instead of sending a voice message.

## Claude Code and Codex together

When creating a session, choose **Debate** under **Several agents**, then select a collaborative discussion or a debate. Each agent retains its own conversation and receives the other agent's latest answer. The session header shows how far it went (**Reply 6 of 20 · 14 min of 30**), each agent answers with its mark and its name in its own colour, a line on the left of its replies, and your own messages sent during the exchange are labelled **Your intervention**. **Pause after this reply** and **Stop** sit in the message box while the agents talk. Optional reply-count and duration limits pause the discussion after the current reply. A banner above the conversation then shows when it paused and which limit it reached (*Paused at 03:12 · limit of 20 replies*), with **Change limits** and **Resume**; the same pause is marked in the thread. Resuming after a limit starts a new period with the same limits; to let the agents go further in the same period, choose **Change limits** (in the banner, or in the session's **…** menu at any time), raise the limit (or empty the field: no limit), then **Save and resume**. The pause button lets the current response finish, and the resume button continues the exchange. Sending a message during a turn interrupts that turn so the agent can take your intervention into account. Stop ends the automatic exchange. Each turn uses the corresponding agent's connected account.

You can assign a different role to each agent, choose a built-in pair of roles, and save named configurations for later sessions. Roles are included in the instructions sent to the corresponding agent on every turn. Saved configurations live in the server's local state.

The new-session form also accepts separate Claude and Codex models. The Codex model is an optional identifier; leave it empty to use the CLI default, or enter a model available to your account. In a joint conversation, the Claude model is not sent to Codex.

From a session's **More actions** menu, **Summary and actions** asks Codex (or Claude Code when Codex is not signed in) to summarize a snapshot of the conversation, separate explicit decisions from proposed actions, and show them for review; the dialog says which agent wrote it. Select the actions you want before creating tasks; no tasks are created automatically. Long conversations may be summarized from the most recent portion only, and the interface indicates when that happens. The request uses that agent's account; its tokens (and Claude's indicative amount) are added to the session's statistics, without counting as a turn.

You may also review and edit the summary before saving it to the topic's `memory.md`. Saving requires an explicit click and appends the approved text without replacing existing memory. Codex reads it on its next turn; Claude normally loads topic memory when starting a new thread. If the topic memory exceeds Codex's 32 KiB context-file limit, compact it before saving more.

## What works with Codex

A Codex session shares the topic's instructions and memory (`CLAUDE.md`, `memory.md`), takes attachments (images
are sent to Codex directly), supports [Plan mode](#plan-mode) (a read-only turn, then **Approve and run**), **Compact**,
**Hand off** ([Compact vs hand off](#compact-vs-hand-off)) and side questions. It has no permission prompts: in **Ask (strict)** and in Plan mode it runs read-only, in **Accept file
edits** and **Full access** it may write in the session's folder (its workspace sandbox); it is never given
unrestricted access to the computer.

These features are for Claude Code only for now:

- **MCP sign-ins and connectors**: Codex gets the MCP servers of Settings → MCP (see [MCP servers](28-mcp.md#codex);
  outside Full access, only their read-only tools), but not Claude's sign-ins, the claude.ai connectors nor the
  Browser of my PC.
- **Claude swarm** and the **Agent map**.
- The **context gauge** and the automatic compactions (when the context gets large, and after a long pause): Codex
  does not report its context size. Compact it yourself from the session menu.
- **Protect the secrets** (Settings → Claude) and the other rules of Claude's permission settings: Codex only
  follows its own sandbox, which still lets it read those files.
- The **usage quota** and the indicative dollar amount: Codex turns count tokens only.
- **New sessions started from Telegram** use Claude Code.

**Summary and actions** works with either agent: Codex when it is signed in, otherwise Claude Code.

## Layout

- **Left pane**: the project / topic tree under a **Sessions** title row that holds the page's buttons: fold the
  list, **Tabs**, the grid (two sessions or more), **+** (new session, Alt+N). Badges show running sessions and unread
  answers; a Codex session or a discussion shows the agents' marks under its name. On the Sessions page the app's
  sidebar becomes a slim **icon rail** so conversations get the width; unfold it with the button at its bottom
  (or ⌘\ / Ctrl+\), it stays unfolded there until you fold it again.
- **One header per session**: where it lives (*project › # topic*, click to move it), its name (click to rename),
  the agent and model that answer (hover for the session's total cost), the context used, **…** and close.
- **Main area**: one or more **columns**, one session each. Open several sessions side by side,
  resize and reorder the columns, or detach one into its own window.
- **Grid**: with two sessions or more, the grid button at the top right stacks them two per column (four sessions
  = 2x2). You can also drop a column on the lower part of another (it goes under it) or on its upper part (it goes above it), or pick **Put under the column on the left** in
  its **…** menu; a column holds up to three sessions (three stacked share the height evenly). Two stacked sessions
  both keep their message box; in a stack of three, only the session you clicked shows its full message box and the
  others show a slim **Write…** bar - click it to write there. Drag the line
  between two stacked sessions to share the height (double-click: half and half). The same button, or **Give it its
  own column**, puts them back side by side. A stacked session shorter than about 560 px keeps a one-line header
  (title, context, **…**, close): plan mode and Telegram notifications move into its **…** menu (their icon stays
  while they are on), the project / topic line and the cost are hidden.
- **Widening a session to read**: drag the right edge of a column, up to 2000 px (never wider than the screen leaves
  room for, the other columns keep their minimum width). A widened column's conversation and message box use its
  whole width; otherwise the text stays at a comfortable 740 px reading column. Double-click the edge to undo.
- **Scrolling sideways** (trackpad swipe, the mouse wheel between sessions or over a session's title bar, or Shift + wheel anywhere) moves the columns; the strip
  stays exactly where you leave it (it never locks onto a session).
- **Ready-made layouts**: hold the mouse button down on a session's grip (the dots left of its title): small
  layouts appear, click the zone where it should go (the others fill the rest). Or drag the session by its grip: a
  layouts bar slides down at the top of the sessions, drop it on a zone. Rest the pointer on the grid button to
  arrange every open session at once. With the keyboard: **…** menu > **Layouts…**. From four sessions, the
  **Half left / Half right** layouts give one session half the screen and put the others beside it, two or three
  per column: when they do not all fit, the strip scrolls as usual (the half moves with it, nothing slides under
  it). While a half is shown the widths are fixed (no resize handle).
  **Grid of 3** stacks three per column.
- **Tabs view**: the **Tabs** button (window icon) in the sessions list's title row (Alt+T) shows one session at a time,
  full width, with every open session as a chip above it. A chip shows whether its session is working, finished
  with an unread answer or stopped on an error; click it to show that session, or use the arrows on the left and
  right edges (Alt+← / Alt+→). Its cross closes the session. **Waiting** jumps to the next session that finished and
  waits for your answer. Click the **Tabs** button again: your columns come back exactly as they were. On a phone,
  **Tabs** is in the session's **…** menu; the chips show under the top bar, and a sideways swipe on the session
  shows the previous or next one.
- Fold the sidebar with the button at its bottom; fold the session tree with the button at its top left
  (a slim rail stays to unfold it).
- On a phone or a tablet (the *touch layout*), one session fills the screen and the app opens on the last one.
  **☰** at the top left opens all your sessions: a search field, **New session** (in the topic of the session on
  screen), the **All / Running / Unread** chips, then your projects and topics. **Press and hold** a session, a
  topic or a project for its menu (rename, favorite, archive, delete...). The session's top bar shows its name, where
  it lives and the model on one line; **Plan mode** is in the message box, and the session's **…** menu holds
  *Telegram notifications* and **Tabs**. **⊞** at the
  top right opens the rest of the app (see [Settings](11-settings-and-keys.md#on-a-phone-or-a-tablet)).

## Move a session to another topic

Under the session's title, its **project / topic** is a button: click it, type to search, pick another topic.
Or drag the session in the session list and drop it on another topic (or on any session of that topic) -
it is the same move. A session that is working cannot move until it finishes; inside its own topic the order
follows the list's sort, so dropping there changes nothing.
The session moves there (the list updates) and Claude continues the same conversation, now working in the
new topic's folder with that topic's context. Possible once Claude has finished (not during a turn or while
messages wait). Its Telegram thread is renamed. Files it created stay where they are.

The project and the topic of a session show as two badges under its title. Hover one to see what it is (its
description, what a project or a topic means for harness-pilot, its folder); click them to move the session to
another topic.

## The sessions list

On a computer, drag the right edge of the app's sidebar to widen or narrow it (double-click: normal width).

The top of the list is the same on a computer and on a phone:

- **Filter** (always visible): type to narrow the list (projects, topics, titles, the last message, archived
  sessions included); **Esc** or **×** clears it. On a phone a **New session** button sits next to it (in the
  topic of the session on screen); on a computer the button on its left hides the list.
- **All / Running / Unread**: the chips show every session, or only those working right now, or only the
  answers you have not read yet (unfolded, with their count). On a computer, **Open all** opens them next to
  the columns already open.
- **Display** (the sliders icon at the end of the chips): every display choice in one menu.
  - **Group by**: **Projects and topics** (the default: the tree) or **Sessions only**: every session in one
    list, whatever its project, sorted as you choose (**most used** first by default: the sessions you talk to
    the most lately come first; then recent activity, A → Z, creation date). One line each: the title and its
    `# topic` on the right; hover it for `project › topic`.
  - **Show projects as**: **Tree** (projects, topics, sessions, each folds; drag a project or a topic within its
    project to reorder, drag a session onto another topic to move it) or **One level at a time** (the projects;
    click one for its topics, a topic for its sessions; the small arrow at the top goes back one level).
    **Fold all folders** / **Unfold all folders** (tree only).
  - **Blocks on top**: tick **Favorites** and **Recent** to show them at the top of the list, and how many
    recent sessions to show (3, 5, 10 or 20). The Favorites block only shows once you have a favorite.
  - **New project**.

With a mouse, the **+** (new session in this topic) and **…** of a row show when you hover it, in place of its
counters; on a touch screen **+** stays visible and a long press opens the menu.

- **Project emoji**: the **…** menu of a project -> *Set an emoji…* (a list of common ones, or type / paste any emoji). It shows before the project in the list and labels, and its Telegram threads (`🛒 acme/blog · Launch plan`). It is saved with the project folder (kept by renames, the trash and the backup).
- **Favorites**: add a session with its **…** menu (or a right-click) -> **Add to favorites**; same menu to
  remove it. A star marks favorite sessions. Favorites are saved on the server: the same on your computer,
  your phone and the installed app, and a continued session (*cont.*) stays a favorite.
- **Recent**: the most recently active sessions (a favorite is not repeated there while Favorites is shown).
- The view, the layout, the sort and the blocks are remembered by this browser. Searching shows every match,
  whatever the view.

## Starting a session

Pick a topic, click **New session**, write your message. The session runs in the topic folder, so
Claude automatically loads the workspace, project and topic memory (see [Memory](memory)).

**Choose how it works** with the cards under **One agent** (Claude Code, Codex, or an agent engine added by an
extension) and **Several agents** (Claude swarm, Debate, Mixed team). Each card says in one line what it does; the
**What will happen** panel beside them (under them on a phone or a narrow column) details the chosen mode: its steps,
what it never does, the subscriptions it uses, and what it cannot take. The settings of the chosen mode (model, number
of subagents, debate limits and roles, plan mode) follow the cards; an extension engine's optional model is passed to
that engine as is. A mode that takes written messages only (Mixed team,
an engine without file support) turns the paperclip off and says why; voice is then dictated into the text.

**Its title** is short: the start of the message shows at once, then a shortened title replaces it (greetings and
"can you…" removed, cut on a word): "Tu vas me créer une session d'automatisation de E-ink" becomes *Créer une
session d'automatisation*. With **Titles written by Claude** on (Settings -> Claude, off by default: one quick call
to the smallest model per new session, counted in your Claude plan), the title names the subject instead -
*Automatisation E-ink* - a few seconds later (if the call fails, the message is shortened). The same goes for a session started from Telegram (its thread is renamed too) and for an empty session
on its first message. A title you typed, a Telegram thread you named, or a rename made meanwhile, is never replaced. Turn it off in Settings -> Claude
(**Short session titles**): the title is then the start of the first message.

## The composer

- **Enter** sends, **Shift+Enter** adds a new line.
- **Attachments**: drag and drop files, paste an image, or use the paperclip. Files are saved in
  `<topic>/attachments/YYYY-MM/` and their paths are given to Claude. With many files, they sit in a small
  strip of two rows that scrolls (the newest in view), so the conversation keeps its room.
- **Pasting data**: a paste that is data rather than a message - JSON, XML / HTML, CSV, a log, cookies or keys,
  any very long text that is not prose - becomes an attachment (`pasted-2026-10-29-143205.json`) instead of filling
  the composer. A prompt stays text, even a long one with commas or links. The notice that shows has **Paste as text** to undo it, and
  Ctrl+Shift+V (⌘⇧V) always pastes as text.
- **Queue**: you can send while Claude is still working. Messages wait in a card above the
  composer, with their full text, and are sent one after the other; its **×** clears them. The card shows every
  waiting message, also after a reload or on another device; one that came from Telegram, a scheduled job or
  harness-pilot itself says so in front of its text.
- **Stop** interrupts the running turn.

**Steer while Claude works.** A message sent during a turn waits in the queue above the composer.
Click **Steer** (in the waiting-messages card) to use it immediately: the current turn is interrupted, Claude keeps everything
it has done so far (same conversation) and continues the task taking your new message into account.
Several queued messages are sent together. **Edit** puts the waiting messages back into the composer at once
(attachments included) so you can change them before sending again; if one of them started meanwhile, only the
others stay in the composer. The **×** of the card empties the queue at once too (it comes back if the server
refuses). **Stop** still cancels the turn
and the queue.

**Ask without interrupting.** **Question** (in the same card) asks the waiting messages on the side:
the session's agent - Claude Code or Codex; in a discussion or a debate, the one that answered last - answers
about the session - where it is at, why it did something, what is left - without stopping its task. The answer
opens in a larger panel above the composer, with the name of the agent that answered; close it with its **×**. It
is not added to the conversation and the agent's work is not affected (it answers from a copy of the
conversation, read-only). Not available for agent plugin sessions.

**Quote part of an answer.** Select text in one of Claude's replies (or in a side-question answer) and
click **Quote** above the selection (below it on a phone). The text goes into a **Quote** card above the
composer; quote several passages if you like, and remove one with its **×** (or all with the card's **×**).
When you send, the quotes go first, as Markdown blockquotes (`> …`), followed by what you typed - you can
also send the quotes alone. Quotes are kept with the draft and shown as quote blocks in your message.

**Nothing typed is lost on a reload.** What you type in a session's message box, its quotes and its attached
files stay saved in the browser: they are still there after a page reload, an update of harness-pilot or a
server restart. A message being sent at the moment the page reloads comes back in the box (a notice says so)
unless the server had received it. Messages waiting in the queue are kept by the server. After an update the
page switches to the new version only once nothing is being sent or uploaded.

**Drag from one session into another.** With several sessions side by side (mouse), drag content of one session
onto another session's column: it lands in that session's **Quote** card, the message box gets the focus, and
nothing is sent until you send it. You can drag:
- a whole message: hover it and drag its grip (⋮⋮ at the top right of a reply, next to the time of your message,
  at the top right of a tool card's output);
- a piece of text: select it, then drag the selection;
- a file: a picture or video thumbnail, an attachment, a file path in an answer or a quoted file - it is added as
  one line with its path, like **Quote** in the file's menu.

While you drag, the other sessions show where to drop; the session the content comes from takes nothing. Dropped
into another app, the content arrives as plain text (a file as its path).

## What you see

- Your messages are bubbles on the right, with their time. Each answer starts with the agent's mark, its name and
  the time; while it works the header says **working…** with the time it has been at it.
- **Activity**: what the agent did between two pieces of text (thinking, reading files, running commands,
  editing) is folded into one line - *Thought, read 2 files, ran 1 command · 8 s*. While it works, the line says
  what it is doing now (*Editing steps.tsx…*). Click it for the list: one row per step with the file or command,
  **+/−** lines for edits, and **View diff**, **View output** or **View error** to open the details. A failed step
  turns the line red (*1 failed*).
- Answers use a reading layout (15 px text, modest headings, framed tables). Files the agent wrote show as cards
  under the answer: **Open** shows them in the file viewer. When the agent keeps a task list, its checklist shows
  under its activity (*2 of 4*).
- Under each answer: **Copy**, **New session from this reply**, and the time and cost of the turn; hover the
  figures for the model, the tokens and the cache share.
- **A turn that stopped on an error** ends with a card that says so: **Retry** sends your last message again,
  **Details** shows the full error. **A question with choices** from the agent ends with its options: one click
  answers, **Another answer…** goes to the message box.
- A summary made to continue a long conversation (compact, hand off) shows as a separator line;
  **View the request** opens what was asked.
- **Agents and background commands**: when Claude hands work to a sub-agent, or runs a command in the background,
  its row keeps spinning, with the time it has been running, until that work really ends (✓ done, ✗ failed, ⊘
  stopped or interrupted). Expand it for where it is: its last action, the tools and tokens used so far, then the
  agent's report once it is done. While some still run, a pill above the composer says so (**2 agents running**):
  click it to list them, click one to open its row. All of it comes back as it was after a reload or a lost
  connection.
- **Diagrams**: to explain how something works, Claude can draw a small diagram (a flowchart, a sequence, the
  states of something...) right in the answer. Click it to open it in the file viewer like a picture (zoom,
  fullscreen, ← / → with the other files of the conversation, **Source** for its code); hover it for **Show the
  code** and **Copy**. On Telegram it arrives as its code.
- **Git graphs**: when Claude talks about a repository, it shows the real graph of its branches and commits (read
  live); click a commit for its files. See [Git & GitHub](26-git.md).
- **Pictures and videos** named in an answer show as thumbnails under it (click to open), and **audio files** as a
  small player you can play right there (its name opens the file viewer); audio you send plays the same way. It
  keeps playing when you scroll away, switch session or open another page; come back to the message to pause it.
  **GIFs** move in the thread (up to 8 MB; a bigger one shows a still, marked GIF).
  Thumbnails follow the files: when Claude rewrites a picture under the same name, the new version shows as soon as
  the tool has run (also in the viewer and the HUD).
- **Right click** a picture, a video, an attachment or a file path (long press on Android): **Open**, **Download**,
  **Quote** (adds the file to your next message as one line with its path - Claude reads it only if needed, the
  picture does not fill the context) and **Copy path**.
- File paths are clickable and open the **file viewer**: ← / → go through every file of the conversation (see [Files](06-files.md#the-file-viewer)).
- The header shows the **model that actually answered** and a **context gauge** (how full Claude's context window
  is, in %, measured against the real window of the model in use - it follows when you switch model); the session's
  total **cost** is in the tooltip of the agent and model.
- The line under each answer shows the time it took and its **cost**; hover (or tap) them for the model, the tokens
  (input → output) and the share of input served from cache.
- **About the amount**: Claude Code reports an indicative dollar amount; the display does not establish the actual bill and does not include Codex. Billing depends on your account, plan and credits. For example, [Anthropic's usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) can incur additional charges after included usage is exhausted. Check your provider account for actual charges.
- **Choose what the line shows**: click the ⚙ at its end (it appears on hover; always there on a touch screen),
  or **Settings → General → Line under each answer**. The choice applies to every device; hiding the cost also
  hides the session total.

## Plan mode

With plan mode on, Claude **changes nothing before you agree**. It reads and explores what it needs, then
answers with a plan: goal, steps, files concerned, risks and open questions. It cannot write files or run
commands that modify anything in this mode.

- Turn it on with the **Plan mode** box in the message box, or tick **Plan mode** when you start a new session
  (untick it to leave).
- Once the turn is over, a **Proposed plan** card ends the conversation - *nothing changes before you approve*:
  - **Edit** (or just write): say what should change - Claude sends the updated plan. Repeat as often as
    you like.
  - **Approve and run**: posts *Plan validated - go ahead.*, plan mode goes off and Claude carries out the latest
    version of the plan.
  - **Reject**: leave plan mode without running the plan.
- The HUD shows the plan as the answer and has a **Validate the plan** button.
- Plan mode applies to every message of the session, Telegram included; validate the plan from the web
  app or the HUD. Compact and hand off still work normally.
- **In a Claude Code and Codex discussion** (tick **Plan mode** when you start it, or use the box later), both
  agents only read and work the plan out together, each reply giving the whole plan as it stands. Pause the
  discussion (or let a reply limit pause it) to get the **Proposed plan** card. **Approve and run**: the agent
  whose turn is next carries out the latest plan, then the discussion pauses again; **Resume** lets the other
  agent review the work.

## Pilot mode

For many sessions at once: as soon as one finishes, it **comes to the front** so you type what comes next at once.

**Beta, off by default.** First enable it for the installation in **Settings -> Features -> Pilot mode (beta)**:
the switch, the bar and the shortcut below only appear then (turning it off there ends it in every browser).

- Turn it on with **⚡ Pilot** at the top right of the Sessions page (**Alt+M**), or **⚡** in a session's header
  on a phone. The setting belongs to this browser.
- The session that comes to the front **replaces the other columns** on screen: it is alone on the strip, full
  width. Your columns are not lost: turning Pilot mode off puts them back.
- A session that finishes its turn (or whose plan waits, or that stopped on an error) joins a queue. The first one
  takes the **whole width** (it slides in where the previous one was), its composer takes the focus and it
  glows briefly; on a phone it opens full screen.
- **You are never cut off**: while the session in front waits for your prompt, or while you type in any composer,
  the next ones wait. The next comes right after you send. **⏭ N waiting** shows the queue; click it to leave the
  session in front as it is and go to the next one. **⏮** (Back) brings back the session you just left (a prompt sent
  too fast: stop it or edit it there); it stays in front until you send to it again, it finishes or you move on, and
  the session that was in front goes back to the head of the queue.
- Nothing to close by hand: one session at a time, and turned off, your previous arrangement comes back (plus the
  session on screen). Drafts stay saved in their session.
- The **liquid bar** next to it (always gently moving, green to orange) is a game: over the last 10 minutes, 70 %
  the time your sessions worked rather than waited for you, 30 % how fast you answered (30 s target). Faster than that and it overflows, up to 110 %. Hover
  it for the details; it stays in this browser and starts again on reload.

## HUD mode

A small floating bar to drive one session while you work in other apps. Turn it on in
**Settings → Features → HUD mode**, then pick **Open the HUD** in the session's **…** menu.

- While Claude works, it shows your prompt and Claude's **last three steps** (tools, thinking).
  When it is done, it shows **the answer** with its images - one at a time, ‹ › to go through them;
  a click opens the file in the app. The arrow next to the send button folds it into a slim bar
  (steps only) and back.
- **Enter** sends; during a turn the message waits in the queue and **Steer** sends it right away.
  The square button stops the turn.
- **Share my screen** (the screen icon): pick a screen or a window once; from then on a capture is
  attached to every message you send from the HUD, so Claude sees what you see. When it helps, Claude
  answers with a copy of the capture annotated (arrows, boxes) to show you where to look. The capture
  usually goes straight to Claude with your message, so it sees your screen from its very first step.
  Captures are saved with the session's attachments (`<topic>/attachments/`). Click the icon again, or
  use the browser's *Stop sharing*, to stop.
- At the top: **Back to the app** brings the main window forward, **×** closes the HUD; hover the answer
  to copy it.
- In **Chrome and Edge** the bar stays on top of every app and can be moved anywhere, a second
  screen included, and it closes with the app tab. Other browsers open it in a small window of its own.
- The HUD only talks to Claude: it does not control your computer. It is not available on a phone.

## Models

Each session can use its own model (menu in the session header). Empty = the default model from
Settings -> Claude. The label always shows the model that really answered the last turn; if it
differs from your choice, a marker tells you. Each model has its own prompt cache: on a session past 50k tokens of
context, switching asks first, because the new model reads the whole conversation once without cache (Compact first
to make the switch cheap).

## Compact vs hand off

When a conversation gets long, the context fills up and answers get slower and more expensive.

| Action | Effect |
|---|---|
| **Compact** | Claude summarizes the conversation, then continues **in the same session** with a fresh context seeded by the summary. The history stays visible. |
| **Hand off** | Creates a **new session** seeded with a summary of this one; the old one is archived. Good when the work changes direction. You can write in the new session right away: your message waits for the summary, then runs with it. |

**Automatic compaction** (Settings -> Claude, 400k tokens by default): when a turn ends with more context than the
threshold, harness-pilot compacts the session by itself before your next message - a note in the conversation says so.
Long sessions then stop re-sending their whole history on every call, which roughly halves the tokens they use.
Pick a higher threshold (or Off) for a session that needs every detail of a very long exchange. A single long turn
(many tool calls in a row) is compacted along the way too, near the same threshold, instead of growing up to the
model's limit. `pilot sessions token-report` shows, on your own sessions, what each threshold would have saved.

**Discussions and debates** between Claude Code and Codex are compacted too. When a reply ends near the limit
(the automatic compaction threshold above, or 80 % of the model's context), or when an agent refuses a reply
because its conversation is full, Claude summarizes the exchanges so far, then both agents continue in fresh
conversations that start from that summary, and a refused reply is asked again. The thread shows a
*Conversation summarised to continue* separator, the summary and a note; the summary does not count as a reply.
**Compact context** in the session's **…** menu does the same on demand, also while the discussion is paused (it
stays paused). Codex does not report how full its conversation is, so on its side the summary comes when it
refuses a reply.
**Summarise & restart** works on a discussion too: a new discussion with the same objective, roles, models and
limits starts from a summary of the exchanges (shown at its top), both agents start from it, and the old one
is archived. A discussion paused before the hand-off stays paused in the new one: **Resume** asks the reply it
was waiting for. Pause a running discussion first.

**Compact when you come back** (Settings -> Claude, 200k tokens by default): Claude keeps the start of a conversation
in a cache for a few minutes (up to an hour). When you write to a session that has been quiet for longer and holds at least that
much context, the cache is gone and the whole history would be re-sent at full price - so harness-pilot summarizes the
session first (a note says "Back after 2 h: ...") and your message runs in a fresh thread seeded with the summary.
You wait for one summary turn before the reply; every turn after it is much smaller. Messages from scheduled jobs
never trigger it, nor does a session whose context is mostly what every new thread loads anyway (CLAUDE.md,
memory): summarizing it would save nothing. Pick Off to keep the full thread whatever the pause. Stop during the
summary cancels only the summary, your message stays: it runs right after, in the full thread.

**Smart resume** (Settings -> Claude, 100k tokens by default): when you come back to a session whose cache expired
with at least that much context - or after 5 minutes or more with twice as much - harness-pilot first has Claude summarize
the session **for the message you just sent**. The summary keeps exact what your message needs (the files, commands,
values, errors, the plan in progress or the question Claude asked), then your message runs in a fresh, much smaller
thread, with the note "Back after 2 h: harness-pilot summarized the session ... for your message". Measured on real
returns: 38 to 67 % fewer tokens from 100k, and details kept better than with the plain summary. Below the threshold
the full thread goes on. Off = the "Compact when you come back" rule alone.

## Edit or delete a message that got no answer

A message you stopped before Claude answered (it shows **Stopped.** under it) can be fixed or removed. Right-click
it (long press on Android), or use the buttons next to its time (always shown on a phone):
- **Edit** (pencil): its text, its quotes and its attachments come back in the message box (before what you had
  already typed), and the message leaves the conversation. Fix it and send it again.
- **Delete this message** (bin): it leaves the conversation with its "Stopped." line; **Undo** in the notice brings
  it back.

Only the conversation shown here changes: what Claude already received stays in its own memory of the session.

## Start a new session from a message

Right-click any message (long press on a phone) - yours, even answered, or a reply of Claude - and pick **New session
from this message**: a new session of the same topic opens with the message already in its box (a reply comes as a
quote). Read it, change it if you like, and send it. **Copy** is in the same menu. A selected piece of text keeps the
browser's own menu (and the **Quote** button), a file keeps its own menu (Open, Download, Quote, Copy path).

## Notify, archive, delete

- **Telegram notifications** (session **…** menu; a bell shows in the header while it is on): when a turn ends, a short message is posted in the topic's Telegram thread.
- **In the browser**: Settings -> **Notifications** -> *Notify me when a session finishes* shows a
  system notification when the tab is in the background (a small banner with **Open** otherwise),
  with an optional chime. A failed turn is notified too; scheduled jobs are not. **Test** checks that
  it works in this browser. Unread answers show a green round counter in the sidebar, on the ☰ button and
  the tree; it can pulse until you read them (*Pulsing badge*).
  Click a counter - running or finished, in the sidebar or on a project / topic of the tree -
  and the session tree shows only those sessions, unfolded (the **Running** or **Unread** chip lights up; a click on a
  project or topic still folds it, until the filter changes). **Open all** opens them next to the columns already
  open; the **All** chip brings the whole tree back (typing a search does too). The **Sessions** link
  itself brings back your last layout.
- **Archive** hides a session from the list without deleting it (see the Archived filter).
- **Delete** stops a running turn and removes the session files.

## Search

**Ctrl/⌘+K** (or the search bar at the top of the sidebar) is the one search of the app. It finds:

- **sessions**, by their title and by what you and Claude wrote;
- **memory** (`memory.md`, `CLAUDE.md`), **tasks** (title, notes, labels) and the **content** of the
  text files of the workspace (markdown, code, config…), plus file and folder **names**. Every `memory.md` /
  `CLAUDE.md` is always found; in a very big workspace each topic gets its fair share of the other files, and
  data files (`.json`, `.csv`, `.xml`, `.svg`) are left out. New files show up within 10 minutes, memory at once;
- pages, settings, topics and actions.

Type a few words in any order: each word may be the start of a word ("fact" finds "facture"),
accents do not matter, and the best matches come first with the matched words highlighted. A
message is searchable a second after it is written; edited files within half a minute.

## Sessions from Telegram and crons

Telegram conversations and Claude cron jobs create normal sessions (marked with their source).
A Telegram session can be continued from the web UI and the other way round.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl/⌘+K | command palette |
| ? | list of shortcuts |
| Ctrl/⌘+\ | show / hide the sidebar |
| Shift+P | presentation mode (hides sensitive data on screen) |
| G then D / S / F / T / C | go to Dashboard / Sessions / Files / Tasks / Crons |
| Alt+T | tabs view on / off (Sessions page) |
| Alt+M | Pilot mode on / off (Sessions page, once enabled in Settings -> Features) |

## Good to know

- Each turn runs in its own systemd unit (`maxxing-<id>`): it survives a server restart.
- Claude Code keeps transcripts for ~10 years (`cleanupPeriodDays` is set to 3650), so old
  sessions can always be resumed. If a transcript is missing, a fresh Claude context is started
  automatically and a note is shown.
- The commits and pull requests Claude makes carry no AI credit (no `Co-Authored-By` line, no
  "Generated with" signature): `attribution` is set to empty in Claude Code's `settings.json`, unless
  you already chose something there (`attribution` or `includeCoAuthoredBy`).


**Fold all / Unfold all folders** (tree layout, in the **Display** menu of the session list): folds every project and topic as soon as something is open, and unfolds everything when all is folded.
