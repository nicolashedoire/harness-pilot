"""The optional plugin runs external adapters and binds decisions to artifact bytes."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / 'skills/model-evolution/scripts/lab.py'
spec = importlib.util.spec_from_file_location('test_model_lab', ENGINE)
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def experiment(tmp_path, **changes):
    source = tmp_path / 'baseline.json'
    source.write_text('{"weight":1}')
    value = {'version': 1, 'model_id': 'test-model', 'name': 'Calibrate a local model', 'operation': 'adapt', 'method': 'direct_edit',
             'baseline': str(source), 'command': [sys.executable, str(ROOT / 'examples/model-adapters/linear_calibration.py')],
             'budget': {'seconds': 10, 'bytes': 1024*1024},
             'criteria': [{'metric':'task_error','goal':'minimize','min_gain':.5}, {'metric':'zero_input_error','goal':'minimize','max_after':0}],
             'required_checks': ['separate_evaluation', 'baseline_unchanged']}
    value.update(changes)
    path = tmp_path / 'experiment.json'
    path.write_text(json.dumps(value))
    return path, source


def wait(state, ident):
    until = time.monotonic() + 15
    while time.monotonic() < until:
        job = lab.get(state, ident)
        if job['status'] not in ('queued', 'preparing', 'running'):
            return job
        time.sleep(.05)
    raise AssertionError('Experiment did not finish')


def test_external_adapter_review_selection_and_tamper(tmp_path, monkeypatch):
    monkeypatch.delenv('MAXXING_STATE', raising=False)
    config, source = experiment(tmp_path)
    state = tmp_path / 'state'
    job = wait(state, lab.start(state, config)['id'])
    assert job['status'] == 'awaiting_review', job
    assert job['proposal']['result']['metrics'][0]['after'] == 0
    assert source.read_text() == '{"weight":1}'
    ident, fingerprint = job['id'], job['fingerprint']
    with pytest.raises(ValueError):
        lab.select(state, ident, fingerprint)
    lab.decide(state, ident, fingerprint, 'rejected')
    with pytest.raises(ValueError):
        lab.select(state, ident, fingerprint)
    lab.decide(state, ident, fingerprint, 'approved')
    assert lab.select(state, ident, fingerprint)['test-model']['run'] == ident
    lab.decide(state, ident, fingerprint, 'rejected')
    assert lab.read(state / 'selection.json') == {}
    lab.decide(state, ident, fingerprint, 'approved')
    lab.select(state, ident, fingerprint)
    Path(job['proposal']['candidate_path']).write_text('{"weight":999}')
    with pytest.raises(ValueError, match='changed'):
        lab.decide(state, ident, fingerprint, 'approved')
    with pytest.raises(ValueError, match='changed'):
        lab.select(state, ident, fingerprint)


def test_failed_gate_cannot_be_approved(tmp_path, monkeypatch):
    monkeypatch.delenv('MAXXING_STATE', raising=False)
    config, source = experiment(tmp_path, criteria=[{'metric':'task_error','goal':'minimize','max_after':-1}])
    state = tmp_path / 'state'
    job = wait(state, lab.start(state, config)['id'])
    assert job['status'] == 'failed_checks'
    with pytest.raises(ValueError, match='failed'):
        lab.decide(state, job['id'], job['fingerprint'], 'approved')
    assert lab.decide(state, job['id'], job['fingerprint'], 'rejected')['decision']['value'] == 'rejected'
    assert source.read_text() == '{"weight":1}'


def test_budget_stops_adapter(tmp_path, monkeypatch):
    monkeypatch.delenv('MAXXING_STATE', raising=False)
    adapter = tmp_path / 'slow.py'
    adapter.write_text('import time\ntime.sleep(30)\n')
    config, _ = experiment(tmp_path, command=[sys.executable, str(adapter)], budget={'seconds':1,'bytes':1048576})
    state = tmp_path / 'state'
    job = wait(state, lab.start(state, config)['id'])
    assert job['status'] == 'error' and 'budget' in job['error']


def test_extension_is_optional_and_uses_existing_host_contract(client, mx):
    for source, target in [(ROOT/'skills/model-evolution', mx['ws']/'.claude/skills/model-evolution'),
                           (ROOT/'examples/extensions/model-lab', mx['ws']/'extensions/model-lab')]:
        shutil.copytree(source, target)
    result = client.get('/api/ext/model-lab/overview')
    assert result.status_code == 200, result.text
    assert result.json()['runs'] == [] and result.json()['selection'] == {}
    assert Path(result.json()['skill_path']).is_file()
    assert client.post('/api/ext/model-lab/runs', json={'spec_path':'relative.json'}).status_code == 400


def test_stop_and_source_mutation_are_detected(tmp_path, monkeypatch):
    monkeypatch.delenv('MAXXING_STATE', raising=False)
    adapter = tmp_path / 'slow.py'
    adapter.write_text('import time\ntime.sleep(30)\n')
    config, _ = experiment(tmp_path, command=[sys.executable, str(adapter)])
    state = tmp_path / 'state'
    ident = lab.start(state, config)['id']
    lab.stop(state, ident)
    assert wait(state, ident)['status'] == 'stopped'
    config, source = experiment(tmp_path)
    job = wait(state, lab.start(state, config)['id'])
    source.write_text('{"weight":3}')
    with pytest.raises(ValueError, match='baseline changed'):
        lab.decide(state, job['id'], job['fingerprint'], 'approved')


def test_direct_edit_claim_and_metric_validation(tmp_path):
    config, _ = experiment(tmp_path)
    value = lab.read(config)
    report = {'metrics':[{'name':'task_error','before':1,'after':0,'split':'validation'}, {'name':'zero_input_error','before':0,'after':0,'split':'old task'}],
              'checks': {'separate_evaluation':True,'baseline_unchanged':True}, 'training':{'gradient_steps':1,'optimizer_steps':1}}
    assert any('zero' in reason for reason in lab.assess(value, report))
    report['metrics'][0]['after'] = float('nan')
    with pytest.raises(ValueError, match='finite'):
        lab.assess(value, report)


def test_new_model_design_without_a_baseline(tmp_path, monkeypatch):
    monkeypatch.delenv('MAXXING_STATE', raising=False)
    adapter = tmp_path / 'design.py'
    adapter.write_text('''import json,sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text()); out=Path(r['output_dir'])
assert r['baseline'] is None
(out/'model.json').write_text(json.dumps({'architecture':'linear','weights':[2.,0.]}))
(out/'result.json').write_text(json.dumps({'candidate':'model.json','metrics':[{'name':'task_error','before':None,'after':0.,'split':'reserved synthetic'}], 'checks':{'separate_evaluation':True,'baseline_unchanged':True}, 'training':{'gradient_steps':0,'optimizer_steps':0}}))
''')
    config, _ = experiment(tmp_path, operation='design', method='architecture_design', baseline=None,
                           command=[sys.executable,str(adapter)], criteria=[{'metric':'task_error','goal':'minimize','max_after':.1}])
    state = tmp_path / 'state'
    job = wait(state, lab.start(state, config)['id'])
    assert job['status'] == 'awaiting_review', job
    assert job['proposal']['source_files'] == []
