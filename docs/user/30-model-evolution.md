---
section: Extending
---
# Model evolution plugin

Model Lab is an optional page extension plus the `model-evolution` companion skill. It orchestrates experiments and user review. Model implementations, weights, datasets and frameworks stay in external adapters. Removing the extension removes the page without changing the host or the source model.

## Install in a workspace

From the repository, copy `skills/model-evolution/` into `<workspace>/.claude/skills/model-evolution/` for Claude Code or `<workspace>/.agents/skills/model-evolution/` for Codex. Install both for a shared workspace. Copy `examples/extensions/model-lab/` into `<workspace>/extensions/model-lab/`. The page bridge discovers the skill in either location.

Reload extensions in Settings → Extensions, then open `/x/model-lab`. The page can be pinned using the existing extension controls. No model framework is installed in the host. The runner uses Python's standard library; each adapter uses its own already configured interpreter.

Ask a companion to use `model-evolution` to investigate a local model's failing task or propose a new model architecture. It prepares an adapter and an experiment spec with input artifacts, a method, fixed acceptance criteria and explicit budgets. The page's companion button opens that request in a normal session. The companion can start the trial through the skill runner; the page can also launch an operator-supplied local spec.

## Review a candidate

The page shows model/version identity, method, before/after measurements, evaluation-data descriptions, limitations and the proposal fingerprint. Adapter-reported results must meet the predeclared criteria and checks before approval is available. A rejected hypothesis remains in the history.

Approval records a user decision on those exact artifact bytes. Files changed since the review require a new experiment. Selecting an approved candidate changes only the lab's `selection.json` pointer. An external serving adapter must implement loading and rollback for its model; arbitrary applications are not silently switched. Source checkpoints are hashed and copied, and never intentionally overwritten by the runner.

The runner can notify the host's existing notification feed when run with its `MAXXING_STATE` environment; sounds follow browser and user preferences. Standalone execution has no dependency on the host. Weights and reports remain in local extension state; they are not automatically included in the memory backup or uploaded to GitHub.

## Methods and evidence

Direct weight editing, learned low-rank adaptation, residual correction and architecture design use the same external contract. They are different experiments: learned adaptation includes training. Source inspection or a graph alone does not establish what a weight means. Compare native model outputs separately from rendering, planning and physical corrections. Preserve prior skills in regression trials.

The supplied `examples/model-adapters/linear_calibration.py` is a tiny analytic protocol demonstration, not proof of general neural-model improvement. A real-model adapter should use its existing training/evaluation tools, data lineage and appropriate budgets. The StykAnimate work informed the workflow; the plugin contains no StykAnimate dependency or personal paths.

Read the skill's `references/protocol.md` for schemas and the adapter interface. `operation: design` allows a new architecture without an existing checkpoint, using absolute acceptance criteria. Companions may propose several architectures and run separate trials; the plugin does not guarantee a useful architecture or a performance gain.

## Execution limits

Adapters are trusted local programs. The runner passes an argv array without shell interpolation, keeps copied inputs and outputs per experiment, monitors adapter time, output size and log size, and terminates its child process group on stop or timeout. These are soft monitored limits, not an OS sandbox: GPU memory, network and writes outside the job are not enforced. Model/framework-specific isolation can be added by an adapter using an appropriate container or worker service.

State lives at `<application state>/extensions/model-lab/`. Keep experiment specs and weights out of public Git history. Code or recipe PRs should reference artifact hashes and test evidence, while model storage and licensing follow the model's own requirements.
