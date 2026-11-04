import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('rea_codex_launcher', SCRIPTS / 'codex.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class McpLauncherTests(unittest.TestCase):
    def test_only_matching_resident_role_is_enabled(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            repo = state / 'companions/runs/run-1/repo'
            repo.mkdir(parents=True)
            sessions = state / 'sessions'
            sessions.mkdir()
            session = sessions / 'session.json'
            for role, run, expected in [('observer', 'run-1', False),
                                        ('reverse-engineer', 'other-run', False),
                                        ('reverse-engineer', 'run-1', True)]:
                session.write_text(json.dumps({'companion': {'id': role, 'run_id': run}}))
                self.assertEqual(launcher.reverse_run(state, repo), expected)
            self.assertFalse(launcher.reverse_run(state, state / 'ordinary-workspace'))
            self.assertFalse(launcher.reverse_run(None, repo))

    def test_pass_through_when_not_enabled_or_not_an_execution(self):
        for args, executable, enabled in [(['exec', '--json'], '/external/rea', False),
                                          (['login', 'status'], '/external/rea', True),
                                          (['exec', '--json'], None, True)]:
            self.assertEqual(launcher.arguments(args, executable, enabled), args)

    def test_mcp_configuration_preserves_sandbox_and_limits_tools(self):
        original = ['exec', '--json', '--ignore-user-config', '--sandbox', 'workspace-write', '-']
        result = launcher.arguments(original, '/external tool/rea', True)
        pairs = result[1:-len(original[1:])]
        settings = {pairs[i + 1].split('=', 1)[0]: json.loads(pairs[i + 1].split('=', 1)[1])
                    for i in range(0, len(pairs), 2)}
        self.assertEqual(result[-len(original[1:]):], original[1:])
        self.assertEqual(settings['mcp_servers.rea.command'], '/external tool/rea')
        self.assertEqual(settings['mcp_servers.rea.args'], ['mcp'])
        self.assertEqual(settings['mcp_servers.rea.enabled_tools'],
                         ['analyze_javascript_application', 'inspect_analysis_view'])
        self.assertFalse(any('sandbox' in key or key.startswith('approval_policy') for key in settings))
        self.assertEqual({key for key in settings if 'approval' in key}, {
            'mcp_servers.rea.tools.analyze_javascript_application.approval_mode',
            'mcp_servers.rea.tools.inspect_analysis_view.approval_mode'})


if __name__ == '__main__':
    unittest.main()
