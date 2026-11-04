# External REA connection and evidence

Sources checked: the official [repository](https://github.com/morluto/rea), [CLI guide](https://github.com/morluto/rea/blob/main/docs/cli.md) and [installation guide](https://github.com/morluto/rea/blob/main/docs/installation.md).

REA exposes application and binary analysis through MCP and CLI. JavaScript/Electron static inspection can work without a native disassembler; native analysis depends on a configured provider such as Hopper, Ghidra, IDA or Kuna. Check the installed version's help and current runtime requirements; the companion definition does not install these tools.

For an existing CLI, a documented static workflow is:

```sh
rea analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
```

For a large saved report, the documented evidence-view request can be written to `view.json`:

```json
{"source":{"kind":"evidence-file","path":"/absolute/path/app-evidence.json"},"view":{"kind":"summary"}}
```

Then run `rea inspect-analysis-view view.json`. Keep the original evidence and its limitations. REA's installer can preview registration changes with `setup --dry-run`; use the official instructions for the selected agent and review the target paths. Do not silently edit every agent's configuration to enable a single companion. This integration provides the role and workflow, not a bundled REA engine or neural-weight editor.
