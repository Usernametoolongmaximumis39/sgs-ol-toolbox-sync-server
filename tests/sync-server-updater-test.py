import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

path = Path(__file__).resolve().parents[1] / "tools/sync-admin/distribution/update-server.py"
if not path.is_file():
    path = Path(__file__).resolve().parents[1] / "distribution/update-server.py"
spec = importlib.util.spec_from_file_location("updater", path)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def bundle(path, entries):
    with tarfile.open(path, "w:gz") as archive:
        for name, data in entries.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))


class ServerUpdaterTest(unittest.TestCase):
    def test_extracts_named_version_without_accepting_traversal(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            archive = root / "update.tar.gz"
            entries = {"server-version.json": b'{"version":"0.2.0"}', "tools/appearance-sync.mjs": b""}
            bundle(archive, entries)
            updater.extract(archive, root / "new", "v0.2.0")
            self.assertEqual(updater.installed_version(root / "new"), "v0.2.0")
            with self.assertRaises(ValueError):
                updater.extract(archive, root / "wrong-version", "v0.2.1")
            bundle(archive, {"../outside": b"test", **entries})
            with self.assertRaises(ValueError):
                updater.extract(archive, root / "unsafe", "v0.2.0")
            self.assertFalse((root / "outside").exists())

    def test_only_installs_the_requested_newer_version(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            args = SimpleNamespace(control=root, root=root)
            release = Mock()
            with (patch.object(updater, "installed_version", return_value="v0.1.0"),
                  patch.object(updater, "latest", return_value=("v0.2.0", release)),
                  patch.object(updater, "take_request") as request,
                  patch.object(updater, "install") as install):
                request.return_value = {"action": "install", "version": "0.1.1"}
                updater.run(args)
                self.assertEqual(json.loads((root / "status.json").read_text())["phase"], "available")
                install.assert_not_called()
                request.return_value = {"action": "install", "version": "0.2.0"}
                updater.run(args)
                install.assert_called_once_with(args, "v0.2.0", release)

    @unittest.skipUnless(sys.platform.startswith("linux"), "systemd update and symlink replacement require Linux")
    def test_failed_health_check_restores_the_previous_version(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            releases = root / "releases"
            old = releases / "old"
            old.mkdir(parents=True)
            try:
                (root / "current").symlink_to(old, target_is_directory=True)
            except OSError:
                self.skipTest("Directory symlinks unavailable")
            args = SimpleNamespace(root=root, service="test.service", admin_port=17430)
            asset = {"digest": "sha256:" + "a" * 64}

            def build_release(_asset, target):
                bundle(target, {"server-version.json": b'{"version":"0.2.0"}', "tools/appearance-sync.mjs": b""})

            with (patch.object(updater, "download", side_effect=build_release),
                  patch.object(updater, "health", side_effect=[RuntimeError("unhealthy"), None]),
                  patch.object(updater.subprocess, "run") as restart):
                with self.assertRaisesRegex(RuntimeError, "已恢复上一版"):
                    updater.install(args, "v0.2.0", asset)
                self.assertEqual((root / "current").resolve(), old)
                self.assertEqual(restart.call_count, 2)


if __name__ == "__main__":
    unittest.main()
