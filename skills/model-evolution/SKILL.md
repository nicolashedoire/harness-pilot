---
name: model-evolution
description: Design or improve a local AI model through bounded experiments, targeted parameter adaptation, regression evaluation and a user-reviewed candidate. Use when model files and an external adapter are available, regardless of framework or task.
---

# Model evolution

Use this method to investigate a model's measured failures and propose an improved version. The optional Model Lab extension presents experiments and records user decisions. The platform owns orchestration and review; model code, weights, datasets, runtimes and framework dependencies belong to an external adapter.

## Choose an intervention from evidence

Identify the failing behavior, the actual model producing it, its input/output contract and a measurable objective. Inspect outputs and activations where available; do not assign semantic meaning to individual weights without causal evidence. Separate model behavior from rendering, planning, data preprocessing and postprocessing.

Choose a bounded hypothesis:
- direct parameter edit: no optimizer or gradient steps; include a comparable random or no-change control;
- learned low-rank or residual adaptation: freeze the appropriate baseline, learn corrections, optionally merge them into a new artifact;
- architecture design: propose a new architecture or adapter, then compare candidates against an explicit baseline or absolute acceptance criteria.

These are distinct methods. Successful targeted adaptation is evidence for that experiment, not proof that arbitrary models can be improved without training. A failed candidate is a useful result and must remain rejected.

## Execute through the external adapter contract

Read [the protocol](references/protocol.md) before creating an adapter or experiment spec. Adapt the model's own tools to the protocol rather than adding its framework to the platform. Use an already trusted local interpreter and adapter; do not download models or install dependencies unless authorized for the task.

Record source artifact hashes, adapter version, data splits, seeds, constraints and compute/storage budgets before the trial. Keep originals intact. Reserve evaluation data and regression tasks; record repeated use of validation data. Compare native model outputs before physical or visual corrections, then test the complete application separately.

Run a single bounded trial with:

```sh
python <skill>/scripts/lab.py start --state <lab-state> --spec <experiment.json>
python <skill>/scripts/lab.py list --state <lab-state>
```

A spec may be evaluated by a non-LLM adapter or prepared by any coding companion. If the companion sandbox cannot write the host extension state, prepare the spec in its own working directory and let the Model Lab page launch it; keep the existing sandbox permissions. Read the run result, logs, metrics, checks and artifact hashes. Fix execution errors separately from testing a new hypothesis. Do not retry indefinitely or weaken acceptance criteria after seeing the result. A new hypothesis or changed protocol gets a new experiment.

## Propose a version

Present the measured gains, regressions, compute used and unverified claims. Use the Model Lab page to let the user approve or reject a candidate. The helper exposes no approval or activation CLI command to the companion. An approved candidate can be selected in the lab; an external serving adapter must explicitly consume that selection. Never overwrite the source weights or silently change the production runtime.

Keep large weights outside Git. When code or recipe changes need a PR, use an English title and description and include the experiment's artifact manifest and validation summary. Apply the user's existing Git and approval workflow. For continued progress, propose another bounded experiment; retained and rejected versions remain traceable.
