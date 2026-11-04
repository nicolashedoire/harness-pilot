#!/usr/bin/env python3
"""Tiny protocol demonstration, not evidence of general neural-model improvement."""
import json
from pathlib import Path
import sys

request = json.loads(Path(sys.argv[1]).read_text())
source = json.loads(Path(request['baseline']).read_text())
# Analytic correction from two calibration pairs. No optimizer or gradient steps.
calibration = [(1., 2.), (2., 4.)]
weight = sum(x * y for x, y in calibration) / sum(x * x for x, _ in calibration)
reserved = [(3., 6.), (4., 8.)]
error = lambda w: sum((w * x - y) ** 2 for x, y in reserved) / len(reserved)
output = Path(request['output_dir'])
(output / 'candidate.json').write_text(json.dumps({'weight': weight}))
(output / 'result.json').write_text(json.dumps({
    'candidate': 'candidate.json',
    'metrics': [{'name': 'task_error', 'before': error(source['weight']), 'after': error(weight), 'split': 'reserved synthetic pairs'},
                {'name': 'zero_input_error', 'before': 0., 'after': 0., 'split': 'old task: zero input'}],
    'checks': {'separate_evaluation': True, 'baseline_unchanged': True},
    'training': {'gradient_steps': 0, 'optimizer_steps': 0},
    'summary': 'Analytic correction of a single scalar coefficient; reserved synthetic error decreases.',
    'limitations': ['One-parameter synthetic example, not a neural model benchmark.', 'Adapter checks are reported evidence; the runner separately hashes original and copied inputs.']
}))
