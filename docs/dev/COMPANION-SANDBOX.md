# Companion sandbox (macOS)

Resident companions and mission steps work in a disposable clone (`<state>/companions/runs/<id>/repo`, the
session's working directory). The clone keeps ordinary edits away from the running app; it is not an
operating-system boundary. This page records what each engine can enforce on macOS, what the
`companion_sandbox` option does, and its limits. Checked on macOS 15.1 with Claude Code 2.1.173 and Codex 0.150.1.

## What confines what today

| Engine | Experiment turn | OS-level write limit |
|---|---|---|
| Codex | `codex exec --sandbox workspace-write` (acceptEdits), or the same sandbox as the `protected` permission profile with Protect the secrets (INTERNALS.md `maxxing.sessions.codex`) | yes: Codex's Seatbelt profile, writes limited to the working directory and temporary folders, network off by default; with Protect the secrets, secrets.json and `~/.ssh` cannot be read either |
| Codex | planner: `--sandbox read-only` (or the read-only `protected` profile) | yes: no writes |
| Claude Code | `--permission-mode acceptEdits` | no: file tools stay in the working directory (edits outside it need an approval that a headless turn cannot get), but a Bash command that is allowed (user or project allow rules) can write anywhere the user can |
| External adapter | `permission_mode` in the request | whatever the adapter enforces; harness-pilot cannot check it |

## Options considered

1. **`sandbox-exec` around the agent process.** Present on macOS 15 although deprecated, and a profile such as
   `(allow default) (deny file-write*) (allow file-write* (subpath <clone>) (subpath <tmp>))` does refuse writes
   outside the clone. Rejected as the default mechanism: a sandboxed process cannot apply another sandbox
   (`sandbox_apply: Operation not permitted`), and both Codex and Claude Code apply their own Seatbelt profile per
   command, so wrapping them breaks their sandbox. The agents also write to their own state (`~/.codex`,
   `~/.claude`), which would need maintained exceptions. Apple can remove the tool or change the profile language
   without notice.
2. **The agents' own sandboxes.** Codex already runs companions in `workspace-write`. Claude Code has an OS sandbox
   for its Bash tool (Seatbelt on macOS, bubblewrap on Linux) configured through settings: `sandbox.enabled`,
   `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands`, `sandbox.autoAllowBashIfSandboxed`,
   `sandbox.filesystem.*`, `sandbox.network.*`. Writes are limited to the working directory (and the paths of
   `Edit(...)` allow rules) and network access to allowed domains. This is the chosen mechanism.
3. **A dedicated macOS user or a VM/container per experiment.** The strongest isolation, but it needs
   administrator setup, separate agent logins and file sharing; out of scope for an opt-in setting.

## The `companion_sandbox` option

Off by default (config `companion_sandbox`, Settings → Companions). When on, every Claude Code turn of a
companion session (experiments and mission steps; `meta.companion` set) adds to its `--settings`:

```json
{"sandbox": {"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
             "autoAllowBashIfSandboxed": false}}
```

- `failIfUnavailable`: the turn fails instead of running unsandboxed when the sandbox cannot start.
- `allowUnsandboxedCommands: false`: the model cannot ask to leave the sandbox (`dangerouslyDisableSandbox`).
- `autoAllowBashIfSandboxed: false`: the option grants no new permission; it only confines the commands that the
  existing rules already allow.

Codex turns are unchanged (already sandboxed). External adapters are unchanged.

## Limits

- Claude's sandbox covers Bash commands and their child processes. File tools (Read, Edit, Write) follow
  permission rules, not the sandbox; reads are not limited except by `Read(...)` deny rules (secrets.json,
  `~/.ssh` and the agents' sign-in files with Protect the secrets).
- Sandboxed commands lose network access to domains that are not allowed: installing dependencies or calling an
  API from a test fails. Companions should not install dependencies anyway.
- On Linux, Claude's sandbox needs bubblewrap and socat; without them the turn fails (`failIfUnavailable`).
- Not verified against a live model in this change: the unit tests check the arguments given to Claude Code, the
  setting names come from the Claude Code 2.1.173 settings schema, and `sandbox-exec`'s nesting refusal was
  reproduced locally.
- External adapters still need their own sandbox; wrapping them in `sandbox-exec` is possible only for adapters
  that do not sandbox their own commands, and is left for a later, per-extension option.
