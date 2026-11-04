---
section: Using harness-pilot
---
# Resident companions

A companion has a permanent name and role. Its execution engine is a separate choice.
Open Settings → Companions, choose an existing role or create one, select its engine,
and save the profile before starting an experiment. Claude Code and Codex use their
respective local CLI accounts. External engines appear when installed as agent extensions.
Changing a role's engine affects new experiments; earlier runs keep their original engine.

Select a project topic to keep the conversation, describe the mission and start the experiment.
The companion works on a disposable copy of committed platform source. Follow the session to
see its work and use Stop whenever needed. The resulting proposal and its verification evidence
can be reviewed in Companions. The companion checks functionality, user experience, appearance
and accessibility when the available tools allow it, and must distinguish checks it performed
from checks it could not perform.

Approving records your decision for the reviewed change fingerprint. It does not apply, publish
or merge the code. After approval you can create a GitHub draft pull request. If the proposal
changes, it must be reviewed again. Notification sound follows Settings → Notifications and
browser playback permissions.

For another engine, install a trusted adapter under the workspace's extensions directory and
manage it through Settings → Extensions. The engine must declare coding support to be used by
a resident role. A missing or disabled engine produces an error; another engine is never chosen
silently. Text-only engines do not accept attachments, and plan mode appears only when supported.
Native thread compaction and handoff remain adapter-specific. External engines currently run in
single-agent sessions or resident experiments; the existing native mixed-team and discussion modes
use Claude Code and Codex.

Extensions are local trusted programs. A disposable source copy is not an operating-system sandbox;
each adapter must enforce its own model and tool permissions. See the developer
[adapter contract](../dev/AGENT-PROVIDERS.md) when implementing an engine.

**Sandbox** (Settings → Companions, off by default): Claude companions run their commands in Claude Code's own
sandbox (macOS, or Linux with bubblewrap). Their commands can then write only in the disposable copy and temporary
folders and cannot reach the network; a turn fails rather than run unsandboxed. It grants no new permission. Codex
companions already run in Codex's workspace-write sandbox; external engines are not covered. Claude's file tools
still follow its permission rules, and reading files elsewhere stays possible.
