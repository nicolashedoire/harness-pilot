# External REA connection and evidence

Sources checked: the official [repository](https://github.com/morluto/rea), [CLI guide](https://github.com/morluto/rea/blob/main/docs/cli.md) and [installation guide](https://github.com/morluto/rea/blob/main/docs/installation.md).

REA exposes application and binary analysis through MCP and CLI. JavaScript/Electron static inspection can work without a native disassembler; native analysis depends on a configured provider such as Hopper, Ghidra, IDA or Kuna. Check the installed version's help and current runtime requirements; the companion definition does not install these tools.

## Connect an independent installation

Install a pinned official `rea-agents` package outside this repository, with a Node version supported by that release. A launcher may select a dedicated Node runtime without changing the system Node. No REA package belongs in the platform's Python or frontend dependency manifests. Native providers are separate optional installations.

Set `REA_BIN` to the executable, or create `$XDG_CONFIG_HOME/harness-pilot/rea.json` (default `~/.config/harness-pilot/rea.json`):

```json
{"executable":"/absolute/path/to/external/rea"}
```

`REA_CONNECTION_FILE` can select a different connection file. Explicit `status.py --rea` and `REA_BIN` take precedence over the file. A configured file must name an absolute executable path. Paths containing spaces are supported; do not add shell quotes inside the JSON value.

Run `python <skill>/scripts/status.py`, then `python <skill>/scripts/rea.py --help`. The status probes the selected executable's own version and runtime; it does not certify providers. Use the launcher in place of `rea` in the examples below. This only connects the companion workflow, not global Codex or Claude MCP settings. Removing the connection file disconnects it; the platform still starts without REA.

On macOS, REA may compile its process-ownership helper before static JavaScript analysis. If the companion cannot write to the default compiler cache, select a task-writable cache using REA's `REA_DARWIN_MODULE_CACHE_PATH` setting in the external launcher. Keep the agent's sandbox permissions unchanged. Protected `.git` directories may also be unwritable inside an agent sandbox; use a private temporary evidence directory instead and retain its path. A failed command's structured partial observation is incomplete evidence, not a successful full analysis.

## Optional resident MCP connection

If REA's process inspection is unavailable inside the agent's shell sandbox, use REA as a separate MCP tool process instead of disabling that sandbox. The optional executable `scripts/codex.py` delegates to the installed Codex CLI and adds per-process MCP configuration only when its working directory matches a reverse-engineering resident run recorded in the selected application state. Ordinary sessions, other roles and authentication commands pass through unchanged. Only `analyze_javascript_application` and `inspect_analysis_view` are exposed. Enabling this launcher also preapproves these two analysis tools for that resident's noninteractive execution; enable it only when the user has authorized this external analysis workflow. The global approval policy is unchanged. No user configuration file is edited.

Start the local application with `MAXXING_CODEX_BIN` pointing to the absolute `scripts/codex.py` path, `PILOT_REA_CODEX_BIN` pointing to the real Codex executable, and `PILOT_REA_STATE` pointing to that instance's state directory (the same value as `MAXXING_STATE`). The script must be executable. This opt-in connection relies on the direct-spawn local workflow; a service manager must explicitly forward these instance environment settings. It does not install REA, alter the shell sandbox, grant access to other services, or expose an HTTP port. The MCP tool itself can read local artifacts using the account running it; enable it only for a trusted installation and authorized investigation targets.

Discover the live tool schemas before use. Select `detail: summary` to retain the large Evidence in the REA process and return a bounded summary, then use `inspect_analysis_view` for selected views. The MCP server lifetime follows the companion's Codex process. A timeout or cleanup error is a failed invocation even when it carries a usable partial observation; preserve that distinction.

## Retain evidence

For an existing CLI, a documented static workflow is:

```sh
rea analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
```

For a large saved report, the documented evidence-view request can be written to `view.json`:

```json
{"source":{"kind":"evidence-file","path":"/absolute/path/app-evidence.json"},"view":{"kind":"summary"}}
```

Then run `rea inspect-analysis-view view.json`. Keep the original evidence and its limitations. REA's installer can preview registration changes with `setup --dry-run`; use the official instructions for the selected agent and review the target paths. Do not silently edit every agent's configuration to enable a single companion. This integration provides the role and workflow, not a bundled REA engine or neural-weight editor.
