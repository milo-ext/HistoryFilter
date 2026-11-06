"""Checks browser-specific manifests and identical shared runtime payloads."""

import json
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from pathlib import Path

from release import build_package


class BuildPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.chrome = build_package.build("chrome", self.work / "chrome.zip")
        self.firefox = build_package.build("firefox", self.work / "firefox.zip")

    def test_root_manifest_supports_direct_development_load_in_both_browsers(self):
        manifest, _ = build_package.base_manifest()
        background = manifest["background"]
        self.assertEqual(background["type"], "module")
        self.assertEqual(background["scripts"], [background["service_worker"]])
        self.assertTrue((build_package.ROOT / background["service_worker"]).is_file())
        gecko = manifest["browser_specific_settings"]["gecko"]
        self.assertEqual(gecko["id"], "@historyfilter.milo")
        self.assertEqual(gecko["strict_min_version"], "140.0")
        self.assertEqual(gecko["data_collection_permissions"], {"required": ["none"]})

    def test_manifests_have_platform_background_and_minimal_permissions(self):
        with zipfile.ZipFile(self.chrome) as archive:
            chrome = json.loads(archive.read("manifest.json"))
        with zipfile.ZipFile(self.firefox) as archive:
            firefox = json.loads(archive.read("manifest.json"))
        self.assertEqual(chrome["manifest_version"], 3)
        self.assertEqual(firefox["manifest_version"], 3)
        for manifest in (chrome, firefox):
            self.assertEqual(manifest["action"]["default_icon"], {
                "16": "assets/icons/icon16.png", "32": "assets/icons/icon32.png"})
        self.assertEqual(set(chrome["permissions"]), {"history", "storage"})
        self.assertEqual(chrome["permissions"], firefox["permissions"])
        self.assertNotIn("host_permissions", chrome)
        self.assertNotIn("host_permissions", firefox)
        self.assertEqual(chrome["background"], {
            "service_worker": "src/background/service-worker.js", "type": "module"})
        self.assertNotIn("browser_specific_settings", chrome)
        self.assertEqual(chrome["minimum_chrome_version"], "121")
        self.assertNotIn("minimum_chrome_version", firefox)
        self.assertEqual(firefox["background"], {
            "scripts": ["src/background/service-worker.js"], "type": "module"})
        gecko = firefox["browser_specific_settings"]["gecko"]
        self.assertEqual(gecko["id"], build_package.FIREFOX_ADDON_ID)
        self.assertEqual(gecko["strict_min_version"], "140.0")
        self.assertEqual(gecko["data_collection_permissions"], {"required": ["none"]})

    def test_common_runtime_bytes_and_allowlist(self):
        with zipfile.ZipFile(self.chrome) as chrome, zipfile.ZipFile(self.firefox) as firefox:
            chrome_names = set(chrome.namelist())
            firefox_names = set(firefox.namelist())
            self.assertEqual(chrome_names, firefox_names)
            self.assertIn("manifest.json", chrome_names)
            for name in chrome_names - {"manifest.json"}:
                self.assertTrue(name.startswith(("src/", "assets/icons/", "_locales/")))
                self.assertEqual(chrome.read(name), firefox.read(name))
                self.assertEqual(chrome.read(name), (build_package.ROOT / name).read_bytes())
            for browser, archive in (("chrome", chrome), ("firefox", firefox)):
                manifest = json.loads(archive.read("manifest.json"))
                self.assertTrue(build_package.manifest_references(manifest).issubset(set(archive.namelist())))
                self.assertIsNone(archive.testzip(), browser)

    def test_manifest_text_is_localized(self):
        with zipfile.ZipFile(self.chrome) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["default_locale"], "en")
            for locale in ("en", "zh_CN"):
                messages = json.loads(archive.read(f"_locales/{locale}/messages.json"))
                for key in ("extName", "extDescription", "actionTitle"):
                    self.assertTrue(messages[key]["message"])
                self.assertLessEqual(len(messages["extDescription"]["message"]), 132)

    def test_reproducible_bytes(self):
        for browser, original in (("chrome", self.chrome), ("firefox", self.firefox)):
            again = build_package.build(browser, self.work / f"{browser}-again.zip")
            self.assertEqual(original.read_bytes(), again.read_bytes())

    def test_mismatched_or_missing_package_version_fails_before_output(self):
        payload = build_package.package_files()
        source = self.work / "source"
        source.mkdir()
        (source / "manifest.json").write_bytes((build_package.ROOT / "manifest.json").read_bytes())
        for version in ("9.9.9", None):
            with self.subTest(version=version):
                package = {} if version is None else {"version": version}
                (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
                for browser in build_package.BROWSERS:
                    output = self.work / f"mismatch-{browser}.zip"
                    with patch.object(build_package, "ROOT", source), patch.object(build_package, "package_files", return_value=payload):
                        with self.assertRaisesRegex(ValueError, "version.*match"):
                            build_package.build(browser, output)
                    self.assertFalse(output.exists())

    def test_package_and_manifest_versions_match(self):
        package = json.loads((build_package.ROOT / "package.json").read_text())
        for path in (self.chrome, self.firefox):
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(json.loads(archive.read("manifest.json"))["version"], package["version"])


if __name__ == "__main__":
    unittest.main()
