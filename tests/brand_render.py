"""Focused brand/header render check in disposable Chrome and Firefox profiles.

Examples:
    python3 tests/brand_render.py --browser chrome
    python3 tests/brand_render.py --browser firefox

Use `--extension <unpacked-directory-or-Firefox-ZIP>` to render a package.

This check uses default rules only and never reads or changes personal history.
"""

from __future__ import annotations

import argparse
import json
import struct
import tempfile
from pathlib import Path
from browser_tools import add_firefox_arguments, firefox_tool_paths


ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "release" / "qa_screenshots_current"


def png_size(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", data[16:24])


def check_assets():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for size in (16, 32, 48, 128):
        path = ROOT / manifest["icons"][str(size)]
        assert path.is_file() and png_size(path) == (size, size), path
        print("icon", size, path)
    promo = ROOT / "release" / "promo-440x280.png"
    for asset in (promo, promo.with_suffix(".svg")):
        if not asset.exists():
            print(f"SKIP optional promotional asset: {asset.relative_to(ROOT)} (not present)")
            continue
        assert asset.is_file(), asset
        if asset.suffix == ".png":
            assert png_size(asset) == (440, 280), asset
        print("promo", asset)


def chrome(extension_dir: Path):
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory(prefix="historyfilter-brand-chrome-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile, executable_path=playwright.chromium.executable_path,
                headless=True, args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=10000)
                page = context.new_page()
                page.goto(worker.url.split("/src/", 1)[0] + "/src/options/options.html")
                CAPTURES.mkdir(parents=True, exist_ok=True)
                for locale in ("en", "zh-CN"):
                    page.evaluate("locale => chrome.storage.local.set({options_locale:locale})", locale)
                    page.reload()
                    page.locator(".brand strong").wait_for()
                    page.wait_for_function("locale => document.documentElement.lang === locale", arg=locale)
                    assert page.locator("html").get_attribute("lang") == locale
                    assert page.locator(".brand").inner_text().strip() == "HistoryFilter"
                    assert page.locator(".brand small").count() == 0
                    for label, viewport in (("desktop", {"width": 1280, "height": 800}),
                                            ("narrow", {"width": 390, "height": 844})):
                        page.set_viewport_size(viewport)
                        metrics = page.evaluate("""() => {
                          const box = s => {const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
                          return {width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,
                            brand:box('.brand'),mark:box('.mark'),nav:box('.nav'),sidebar:box('.sidebar')};
                        }""")
                        assert metrics["brand"]["height"] <= 42, metrics
                        assert metrics["mark"]["height"] == 34, metrics
                        assert metrics["docWidth"] <= metrics["width"], metrics
                        if label == "narrow":
                            assert metrics["nav"]["height"] <= 100, metrics
                        page.screenshot(path=str(CAPTURES / f"brand-chrome-{locale}-{label}.png"))
                        print("Chrome", locale, label, metrics)
            finally:
                context.close()


def firefox(extension_path: Path, driver_path: Path, binary: Path):
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.firefox.service import Service
    from firefox_release import api, eventually, install_extension

    opts = Options()
    opts.binary_location = str(binary)
    opts.add_argument("-headless")
    driver = webdriver.Firefox(
        service=Service(str(driver_path), service_args=["--allow-system-access"]), options=opts,
    )
    try:
        addon_id = install_extension(driver, extension_path)
        driver.set_context("chrome")
        mapping = json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
        driver.set_context("content")
        driver.get(f"moz-extension://{mapping[addon_id]}/src/options/options.html")
        CAPTURES.mkdir(parents=True, exist_ok=True)
        handle = driver.current_window_handle
        for locale in ("en", "zh-CN"):
            api(driver, "return browser.storage.local.set({options_locale:arguments[0]});", locale)
            driver.refresh()
            eventually(lambda: driver.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == locale, "Firefox locale")
            assert driver.find_element(By.CSS_SELECTOR, ".brand").text.strip() == "HistoryFilter"
            assert driver.find_elements(By.CSS_SELECTOR, ".brand small") == []
            for label, size in (("desktop", (1280, 800)), ("narrow", (390, 844))):
                driver.set_window_size(*size)
                driver.switch_to.window(handle)
                target_width = 1280 if label == "desktop" else 500  # Firefox headless minimum.
                eventually(lambda: driver.execute_script("return innerWidth") == target_width, "Firefox resize")
                metrics = driver.execute_script("""return (() => {
                  const box = s => {const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
                  return {width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,
                    brand:box('.brand'),mark:box('.mark'),nav:box('.nav'),sidebar:box('.sidebar')};
                })();""")
                assert metrics["brand"]["height"] <= 42, metrics
                assert metrics["mark"]["height"] == 34, metrics
                assert metrics["docWidth"] <= metrics["width"], metrics
                if label == "narrow":
                    assert metrics["nav"]["height"] <= 100, metrics
                driver.save_screenshot(str(CAPTURES / f"brand-firefox-{locale}-{label}.png"))
                print("Firefox", locale, label, metrics)
    finally:
        driver.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("chrome", "firefox"), required=True)
    parser.add_argument("--extension", type=Path, default=ROOT,
                        help="Chrome unpacked directory or Firefox source directory/ZIP")
    add_firefox_arguments(parser)
    args = parser.parse_args()
    check_assets()
    if args.browser == "chrome":
        chrome(args.extension.resolve())
    else:
        firefox(args.extension.resolve(), *firefox_tool_paths(args, parser))
