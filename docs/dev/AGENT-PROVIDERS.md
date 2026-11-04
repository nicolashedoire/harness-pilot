# Agent provider plugins

A companion's persistent role and its execution engine are separate. The profile stores a provider
id; changing it affects new experiments, while earlier sessions retain their original provider.
Claude Code and Codex are built-in adapters. Additional engines live outside the product checkout
under `<workspace>/extensions/<id>/` and can be disabled or removed independently.

## External executable contract (v1)

Create a trusted extension directory containing `manifest.json` and its adapter executable:

```json
{
  "id": "local-engine",
  "name": {"en": "Local engine", "fr": "Moteur local"},
  "version": "1.0.0",
  "api": 1,
  "type": "agent",
  "agent": {
    "protocol": "pilot-jsonl-v1",
    "command": ["./adapter"],
    "capabilities": ["text", "source-edit", "plan"]
  }
}
```

An executable containing `/` is resolved relative to its extension directory; a bare command is
resolved through PATH. Remaining arguments are literal (no shell expansion) and should use absolute
paths where needed. The executable must exist and be executable. No `api.py` is imported for agent
extensions, and discovery does not invoke the program. Settings → Extensions shows manifest errors
and controls whether the engine is enabled. `GET /api/agent-providers` returns the usable catalog,
without executable paths. Native discussions/debates and mixed teams currently retain their
Claude/Codex orchestration; an external engine can run in a single session or a resident experiment.

The process starts in the session topic or the companion's disposable source copy. Stdin receives
one JSON object followed by a newline:

```json
{
  "protocol": "pilot-jsonl-v1",
  "session_id": "uuid",
  "cwd": "/absolute/working/directory",
  "model": "optional-model-id",
  "permission_mode": "default",
  "prompt": "current request",
  "context": "available shared instructions and memory",
  "history": [{"role": "assistant", "text": "previous answer"}],
  "attachments": []
}
```

History is bounded to eight text messages and a 256 KiB log tail; the prompt is supplied separately.
A provider needing native thread state must manage that state itself. No platform credential vault
is included in the request. The process inherits the normal runner environment; credential handling
and any required environment isolation remain the adapter owner's responsibility.

Stdout emits JSON Lines. Text events appear live in the normal conversation, followed by exactly one
terminal result:

```json
{"type":"message","text":"The answer"}
{"type":"result","ok":true,"usage":{"input_tokens":100,"output_tokens":20}}
```

For errors use `{"type":"result","ok":false,"error":"explanation"}` and a nonzero exit code.
Exiting without a result is an error. Usage counters must be non-overlapping numeric categories;
optional `cache_read_input_tokens` and `cache_creation_input_tokens` use the same vocabulary as the
native session counters. They are attributed to `plugin:<id>` and shown in statistics. No billing
price is inferred for a plugin. Other stdout event types are ignored; they cannot create platform
control events, approval decisions, authentication state or execute server tools. Stderr is retained
as a bounded error tail. The existing process-group stop and timeout machinery applies.

Capabilities are declarations by the adapter author, not independently verified claims. `text` is
required. `source-edit` enables use in a resident coding role; `plan` promises that the adapter
honors read-only plan requests; `attachments` promises it accepts supplied paths. The server rejects
unsupported capabilities before starting a new session. Native compaction/handoff controls are not
available for generic engines. The adapter must implement any model-specific tools and safeguards.

## Trust and lifecycle

External adapters are trusted installed programs with the local user's OS privileges. A separate
source directory protects the live checkout from ordinary edits; it is **not an OS sandbox**. The
adapter must apply its engine's sandbox/approval controls. Do not install untrusted executables.
Disabling/removing an extension prevents new turns and runs; an already running process is stopped
through its session's Stop control. A missing provider produces an explicit error, never a fallback
to another engine. Old histories and reviewed proposals remain accessible.

Companions still need explicit owner approval of the current fingerprint before PR publication.
Installing an engine does not grant it merge authority or approve its output.
