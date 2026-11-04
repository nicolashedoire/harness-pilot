# Consistency audit — 4 November 2026

This audit lists the gaps observed in the local interface and in the code. It is a working inventory, not a certification of every feature. Fixes are ticked after verification. Last reviewed against `CHANGELOG.md` and the pull requests merged up to #75.

## Priority 1 — misleading information or destinations

- [x] **License and welcome**: the License page presents the MIT license and the welcome flow no longer asks for an enterprise key. The historical notices are kept.
- [ ] **Installation and update**: `install.sh` is disabled until its Linux path and its inherited destinations are adapted and validated. The local installation documented in the README uses `scripts/dev-local.sh`; the other paths have not yet been validated for this project. The tools page and the Settings page now say so (#69).
- [x] **Profile and feedback**: the inherited registration form was removed, user feedback opens the issues of this repository, and the original registration service is disabled by default, including for an older configuration.
- [x] **Donations**: the button opens the PayPal link configured by the owner. The recipient was verified on PayPal; the link can be changed or removed in Settings → Support.

## Priority 2 — Claude and Codex

- [x] **Statistics**: the quota shown concerns Claude only. On macOS, the message now distinguishes a sign-in that may go through the keychain from the quota being unreadable.
- [x] **Usage**: new turns are broken down by agent; older turns or turns without data stay unattributed. Codex turn events carry tokens only, neither a cost nor plan limits: Settings → Stats says so and estimates nothing. The cost shown is Claude Code's own estimate, for Claude only.
- [x] **Claude amounts**: the amounts shown are marked as indicative and no longer claim to determine billing. Usage credits can lead to extra charges; the real invoice is to be checked with Anthropic. Codex is not included in this amount.
- [x] **Codex counting**: turns before the fix counted cached tokens twice. They are recalculated once from each session's log when the statistics are opened, and Settings → Stats says how many.
- [x] **Connections and settings**: a Codex page shows the status of the CLI and the current limits; the connection was verified on the computer.
- [x] **Agent health**: when Codex is signed in, a missing Claude sign-in is information rather than a general failure; Claude is still needed to use it and for two-agent discussions.
- [x] **Conversation summary**: a session's menu offers a summary, the decisions and actions to select before any task is created. The real test was done with Codex; the cost of this call is not yet included in the statistics.
- [x] **Shared memory**: from the summary, the text can be reread and edited before it is explicitly added to the topic's memory. Codex reads it at its next turn; Claude loads it normally when a new thread starts. Writes refuse symbolic links and a memory too large for Codex.
- [x] **Session connections**: conversations use short requests; compatible tabs share one update connection and take over if it closes. Tested locally with several tabs; browsers without coordination keep one connection per tab.
- [x] **Uneven features**: several pages and hints assume Claude; check for each path whether Codex, the discussion and Telegram are really supported, and state the limits. Progress: companion roles choose their engine and external engines appear in single-agent sessions, with unsupported plan or file features refused clearly (#44); the new session form explains each mode and turns off attachments, with the reason, for modes that take text only (#64). The Claude Code-only features (side questions, MCP servers, scheduled prompts, Claude swarm, context gauge and automatic compactions, Protect the secrets, usage quota, new sessions from Telegram) were checked in the code and are listed in the Sessions guide ("What works with Codex") and in Settings → Codex; Summary and actions needs Codex.
- [ ] **Computer browser**: no agent binary is published in the manifest; its inherited URL points to the original project. The code builds for this Mac and its Go tests pass; real pairing and control remain to be verified before offering its installation.

## Priority 3 — general consistency and documentation

- [x] **Recovery after an interruption on macOS**: without `/proc`, the identity of an orphaned task process is checked with its start date read by `ps` (in UTC). The next run of the task stops it only when it is still the same process; a process number reused by another program is never killed. Tested for real on this Mac: `tests/test_cron_orphans.py`.
