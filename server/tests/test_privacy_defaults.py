"""App-owned telemetry stays off even when the parent environment opts into OTLP."""
import pytest

from maxxing import config
from maxxing.sessions import codex, spawn


def test_app_does_not_enable_fastapi_export_from_parent_environment(mx,monkeypatch):
    runtime=pytest.importorskip('fastapi.telemetry._runtime',reason='Older FastAPI has no native telemetry/exporter')
    monkeypatch.setenv('FASTAPI_OTEL_AUTO_CONFIGURE','true')
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT','https://collector.example.invalid')
    observed=[]
    original=runtime._configure_from_environment
    def checked(settings):
        observed.append(dict(settings))
        assert settings['auto_configure'] is False
        assert not any(settings[k] for k in ('tracing','metrics','logs','operation_spans'))
        return original(settings)
    monkeypatch.setattr(runtime,'_configure_from_environment',checked)
    from fastapi.testclient import TestClient
    from maxxing.app import create_app
    with TestClient(create_app()) as client:
        assert client.get('/api/auth/state').status_code==200
    assert observed


def test_codex_turn_and_resume_explicitly_disable_all_exporters():
    for thread,mode in [('', 'default'),('retained-thread','acceptEdits')]:
        args=codex.command(thread,mode)
        settings=dict(args[i+1].split('=',1) for i,a in enumerate(args[:-1]) if a=='-c')
        assert settings['analytics.enabled']=='false'
        assert all(settings[key]=='"none"' for key in ('otel.exporter','otel.metrics_exporter','otel.trace_exporter'))
        assert settings['otel.log_user_prompt']==settings['otel.log_agent_responses']=='false'
        assert '--dangerously-bypass-approvals-and-sandbox' not in args
        assert args[args.index('--sandbox')+1]==('read-only' if mode=='default' else 'workspace-write')


def test_claude_default_disables_nonessential_traffic_without_changing_user_settings(mx,monkeypatch):
    monkeypatch.delenv(spawn.QUIET_START_ENV,raising=False)
    assert spawn.base_env()[spawn.QUIET_START_ENV]=='1'
    assert spawn.claude_env()[spawn.QUIET_START_ENV]=='1'
    assert config.load_config()['claude_quiet_start'] is True


def test_claude_update_subprocesses_never_receive_the_quiet_start_variable(mx,monkeypatch,tmp_path):
    """An update the server was asked to install must not be skipped by Claude Code's update opt-out."""
    from maxxing import claude_update
    monkeypatch.delenv(spawn.QUIET_START_ENV,raising=False)
    binary=tmp_path/'claude';binary.write_text('');binary.chmod(0o755)
    monkeypatch.setattr(claude_update,'_bin',lambda:str(binary))
    monkeypatch.setattr(claude_update,'install_method',lambda:('native',[str(binary),'install']))
    envs=[]
    class Done:
        returncode=0;stdout='2.1.0 (Claude Code)';stderr=''
    def run(args,**kwargs):
        envs.append((args,kwargs['env']));return Done()
    monkeypatch.setattr(claude_update.subprocess,'run',run)
    assert claude_update.installed_version()=='2.1.0'
    assert claude_update.run_update('2.1.1')[0] is True
    assert [args[1:] for args,_ in envs]==[['--version'],['install','2.1.1']]
    assert all(spawn.QUIET_START_ENV not in env and env.get('HOME') for _,env in envs)
    # Elsewhere (turns, status probes, summaries, cron jobs) the quiet start stays on.
    assert spawn.base_env()[spawn.QUIET_START_ENV]=='1' and spawn.claude_env()[spawn.QUIET_START_ENV]=='1'
