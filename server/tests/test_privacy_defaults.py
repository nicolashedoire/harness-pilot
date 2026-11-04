"""App-owned telemetry stays off even when the parent environment opts into OTLP."""
import importlib
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
    assert spawn.claude_env()[spawn.QUIET_START_ENV]=='1'
    assert config.load_config()['claude_quiet_start'] is True
