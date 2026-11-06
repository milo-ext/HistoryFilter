"""Build reproducible Chrome and Firefox Manifest V3 ZIPs from one source tree."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SUFFIXES = {".js", ".html", ".css"}
ICON_NAMES = {f"icon{size}.png" for size in (16, 32, 48, 128)}
FIREFOX_ADDON_ID = "@historyfilter.milo"
FIREFOX_MIN_VERSION = "140.0"
BROWSERS = ("chrome", "firefox")


def package_files() -> dict[str, bytes]:
    """Return only runtime source, icons and locale messages; manifests are added per browser."""
    paths = [path for path in (ROOT / "src").rglob("*")
             if path.is_file() and path.suffix in RUNTIME_SUFFIXES]
    paths.extend(ROOT / "assets" / "icons" / name for name in sorted(ICON_NAMES))
    paths.extend(sorted((ROOT / "_locales").glob("*/messages.json")))
    files: dict[str, bytes] = {}
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Required runtime file missing or symlinked: {path}")
        relative = path.relative_to(ROOT).as_posix()
        files[relative] = path.read_bytes()
    if not files or not ICON_NAMES.issubset({Path(name).name for name in files}):
        raise ValueError("Runtime sources or required icons are missing")
    return files


def base_manifest() -> tuple[dict, bytes]:
    raw = (ROOT / "manifest.json").read_bytes()
    manifest = json.loads(raw)
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected a Manifest V3 extension")
    if not re.fullmatch(r"\d+(?:\.\d+){1,3}", manifest.get("version", "")):
        raise ValueError("Invalid extension version")
    package = json.loads((ROOT / "package.json").read_bytes())
    if package.get("version") != manifest["version"]:
        raise ValueError("package.json version must match manifest.json version")
    if set(manifest.get("permissions", [])) != {"history", "storage"}:
        raise ValueError("Expected only history and storage permissions")
    if manifest.get("host_permissions"):
        raise ValueError("Unexpected host permissions")
    if manifest.get("background", {}).get("type") != "module":
        raise ValueError("Expected a module background")
    worker = manifest.get("background", {}).get("service_worker")
    if not isinstance(worker, str) or not worker:
        raise ValueError("Development manifest must name a service worker")
    if manifest["background"].get("scripts") != [worker]:
        raise ValueError("Development manifest must name the same module as background.scripts")
    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    if gecko.get("id") != FIREFOX_ADDON_ID or gecko.get("strict_min_version") != FIREFOX_MIN_VERSION:
        raise ValueError("Development manifest has incorrect Firefox add-on metadata")
    if gecko.get("data_collection_permissions") != {"required": ["none"]}:
        raise ValueError("Development manifest must declare no data collection")
    return manifest, raw


def browser_manifest(browser: str, base: dict, raw: bytes) -> tuple[dict, bytes]:
    if browser not in BROWSERS:
        raise ValueError(f"Unsupported browser: {browser}")
    if browser == "chrome":
        chrome = copy.deepcopy(base)
        chrome["minimum_chrome_version"] = "121"
        chrome["background"].pop("scripts", None)
        chrome.pop("browser_specific_settings", None)
        return chrome, (json.dumps(chrome, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    firefox = copy.deepcopy(base)
    firefox["background"].pop("service_worker", None)
    return firefox, (json.dumps(firefox, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def manifest_references(manifest: dict) -> set[str]:
    references: set[str] = set()
    background = manifest.get("background", {})
    if background.get("service_worker"):
        references.add(background["service_worker"])
    references.update(background.get("scripts", []))
    options = manifest.get("options_ui", {}).get("page")
    if options:
        references.add(options)
    references.update(manifest.get("icons", {}).values())
    if manifest.get("default_locale"):
        references.add(f"_locales/{manifest['default_locale']}/messages.json")
    action_icons = manifest.get("action", {}).get("default_icon", {})
    if isinstance(action_icons, str):
        references.add(action_icons)
    elif isinstance(action_icons, dict):
        references.update(action_icons.values())
    if not references or any(not isinstance(value, str) or not value for value in references):
        raise ValueError("Manifest has invalid runtime references")
    return references


def validate_manifest(browser: str, manifest: dict, payload: dict[str, bytes]) -> None:
    background = manifest["background"]
    if browser == "chrome":
        if not background.get("service_worker") or "scripts" in background or "browser_specific_settings" in manifest:
            raise ValueError("Chrome manifest must use only a module service worker")
    else:
        gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
        if background.get("scripts") != ["src/background/service-worker.js"] or "service_worker" in background:
            raise ValueError("Firefox manifest must use module background scripts")
        if gecko.get("id") != FIREFOX_ADDON_ID or gecko.get("strict_min_version") != FIREFOX_MIN_VERSION:
            raise ValueError("Firefox add-on ID or minimum version is incorrect")
        if gecko.get("data_collection_permissions") != {"required": ["none"]}:
            raise ValueError("Firefox no-data collection declaration is missing")
    missing = manifest_references(manifest) - payload.keys()
    if missing:
        raise ValueError(f"Manifest references absent runtime files: {sorted(missing)}")


def default_output(browser: str, version: str) -> Path:
    return ROOT / "release" / "dist" / f"HistoryFilter-v{version}-{browser}.zip"


def build(browser: str, output: Path | None = None) -> Path:
    base, raw = base_manifest()
    manifest, manifest_bytes = browser_manifest(browser, base, raw)
    payload = package_files()
    validate_manifest(browser, manifest, payload)
    payload["manifest.json"] = manifest_bytes
    destination = output or default_output(browser, base["version"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9, strict_timestamps=True) as archive:
        for name in sorted(payload):
            metadata = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            metadata.create_system = 3
            metadata.compress_type = zipfile.ZIP_DEFLATED
            metadata.external_attr = 0o644 << 16
            archive.writestr(metadata, payload[name], compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)
    with zipfile.ZipFile(destination) as archive:
        if set(archive.namelist()) != set(payload) or archive.testzip() is not None:
            raise ValueError(f"ZIP integrity check failed: {destination}")
        for name, contents in payload.items():
            if archive.read(name) != contents:
                raise ValueError(f"ZIP bytes differ from source: {name}")
    print(f"Built {destination} ({len(payload)} runtime files, {browser})")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=(*BROWSERS, "all"), default="all",
                        help="Package one browser or both (default: all)")
    parser.add_argument("--output", type=Path, help="ZIP path when packaging one browser")
    args = parser.parse_args()
    if args.browser == "all" and args.output:
        parser.error("--output requires --browser chrome or --browser firefox")
    selected = BROWSERS if args.browser == "all" else (args.browser,)
    outputs = [build(browser, args.output) for browser in selected]
    if args.browser == "all":
        checksums = "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in outputs)
        (outputs[0].parent / "SHA256SUMS").write_text(checksums, encoding="utf-8")


if __name__ == "__main__":
    main()
