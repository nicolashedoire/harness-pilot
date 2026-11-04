"""The optional connection must work without the platform or npm installed in it."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.connection = self.root / 'connection.json'
        self.env = {k: v for k, v in os.environ.items() if k not in ('REA_BIN', 'REA_CONNECTION_FILE')}
        self.env['REA_CONNECTION_FILE'] = str(self.connection)
        self.env['PATH'] = str(self.root)  # no accidental fallback to a globally installed REA

    def run_script(self, script, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / script), *args], env=self.env,
                              text=True, capture_output=True, timeout=15)

    def executable(self):
        path = self.root / 'external tool' / 'rea'
        path.parent.mkdir()
        path.write_text(f'#!{sys.executable}\nimport json,sys\n'
                        'print(json.dumps({"version":"6.8.0","runtime":{"version":"24.22.2"}}) '
                        'if sys.argv[1:]==["--version","--json"] else json.dumps(sys.argv[1:]))\n')
        path.chmod(0o700)
        return path

    def test_unconfigured_tool_is_optional_and_cannot_launch(self):
        status = self.run_script('status.py')
        self.assertEqual(status.returncode, 0)
        self.assertEqual(json.loads(status.stdout)['reason'], 'not_installed')
        launch = self.run_script('rea.py', '--version')
        self.assertEqual(launch.returncode, 127)
        self.assertIn('not_installed', launch.stderr)

    def test_paths_and_arguments_are_forwarded_without_shell_interpretation(self):
        executable = self.executable()
        self.connection.write_text(json.dumps({'executable': str(executable)}))
        marker = self.root / 'unwanted'
        args = ['analyze-javascript-application', '/target with spaces', f'$(touch {marker})', 'a;b']
        launch = self.run_script('rea.py', *args)
        self.assertEqual(launch.returncode, 0, launch.stderr)
        self.assertEqual(json.loads(launch.stdout), args)
        self.assertFalse(marker.exists())
        status = json.loads(self.run_script('status.py').stdout)
        self.assertEqual(status['version'], '6.8.0')
        self.assertEqual(status['node_version'], '24.22.2')
        self.assertFalse(status['providers_verified'])

    def test_invalid_configuration_fails_without_fallback(self):
        for data in ('{bad json', '[]', '{"executable":"relative/path"}'):
            with self.subTest(data=data):
                self.connection.write_text(data)
                status = json.loads(self.run_script('status.py').stdout)
                self.assertEqual(status['reason'], 'invalid_connection')
                self.assertFalse(status['installed'])
                self.assertEqual(self.run_script('rea.py').returncode, 127)

    def test_explicit_executable_overrides_invalid_configuration(self):
        executable = self.executable()
        self.connection.write_text('{bad json')
        self.env['REA_BIN'] = str(executable)
        status = json.loads(self.run_script('status.py').stdout)
        self.assertIsNone(status['reason'])
        self.assertEqual(status['executable'], str(executable))


if __name__ == '__main__':
    unittest.main()
