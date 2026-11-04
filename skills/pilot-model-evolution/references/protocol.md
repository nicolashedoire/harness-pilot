# External model adapter protocol v1

The runner is standard-library Python. It does not import a model framework. An adapter is a trusted local executable in its own environment. This is process isolation and input copying, not a sandbox against hostile code. Time, output-file and log limits are monitored; GPU memory, network and writes outside the job are not OS-enforced.

An experiment spec is JSON:

```json
{
  "version": 1,
  "model_id": "example-model",
  "name": "Repair the measured task failure",
  "operation": "adapt",
  "method": "low_rank_adaptation",
  "baseline": "/absolute/path/to/checkpoint-or-bundle",
  "command": ["/absolute/path/to/python", "/absolute/path/to/adapter.py"],
  "budget": {"seconds": 180, "bytes": 268435456},
  "criteria": [{"metric": "task_error", "goal": "minimize", "min_gain": 0.05}, {"metric": "old_task_error", "goal": "minimize", "max_after": 0.1}],
  "required_checks": ["separate_evaluation", "baseline_unchanged"],
  "parameters": {"seed": 7}
}
```

`operation` is `evaluate`, `adapt` or `design`. `method` names the declared procedure, not a platform implementation. `baseline` can be null for new-model design. Paths are absolute. Only a spec file supplied by an operator is executed; the web page accepts a local spec path rather than arbitrary shell commands. The command is an argv array, with no shell interpolation. The runner appends one argument: the absolute path of `request.json`. The model's interpreter and libraries remain external.

The request contains the frozen spec, `baseline` (private copied input, or null), and `output_dir`. The adapter writes candidate files below `output_dir`, and writes `result.json` there:

```json
{
  "candidate": "candidate.json",
  "metrics": [{"name": "task_error", "before": 1.0, "after": 0.1, "split": "reserved synthetic validation"}, {"name": "old_task_error", "before": 0.08, "after": 0.08, "split": "regression"}],
  "checks": {"separate_evaluation": true, "baseline_unchanged": true},
  "training": {"gradient_steps": 100, "optimizer_steps": 100},
  "summary": "Measured result and remaining limitations.",
  "limitations": ["Validation is synthetic; independent real-data evaluation is still needed."]
}
```

Metric names are unique; numbers are finite and comparable. `goal` is minimize/maximize. `min_gain` is a minimum relative gain and requires a nonzero `before`; `max_after`/`min_after` are absolute bounds. Rules are fixed before execution. All criteria and required checks must pass for approval. For `direct_edit`, reported gradient and optimizer steps must both equal zero. Measurements and checks are adapter-reported evidence, not an independent audit by the platform. Reports, source/adapter hashes and actual input/candidate hashes are retained.

Candidate files may be a directory; no symlinks are allowed. A candidate must differ from the copied baseline and reside in the output directory. The runner detects modifications to the original input and copied input. User approval binds to the report and artifact fingerprint and is invalid if files change. A local selection pointer is separate from approval; it neither deploys the model nor changes an arbitrary external application. Serving adapters can consume `selection.json` after checking hashes and defining their own reload/rollback behavior.

Model construction uses the same contract with `operation: design`, an optional baseline and architecture/hyperparameter choices in `parameters`. The companion prepares alternatives; the runner does not invent an architecture or guarantee a gain.
