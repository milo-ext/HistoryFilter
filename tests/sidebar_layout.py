"""Focused sidebar layout QA in disposable Chrome or Firefox profiles.

Examples:
    python3 tests/sidebar_layout.py --browser chrome
    python3 tests/sidebar_layout.py --browser firefox

Pass `--extension <unpacked-dir-or-Firefox-ZIP>` to inspect a packaged build.

Only synthetic rules are stored. This script does not read or change history.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from browser_tools import add_firefox_arguments, firefox_tool_paths


ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "release" / "qa_screenshots_current"
RULES = [{"id": f"sidebar-{index}", "name": f"Synthetic rule {index:02d}",
          "enabled": True, "matchType": "domain", "pattern": f"rule-{index}.qa.invalid",
          "action": "block"} for index in range(60)]
METRICS = """(() => {
  const box = selector => { const r = document.querySelector(selector).getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,height:r.height}; };
  const aside = document.querySelector('.sidebar');
  return {width:innerWidth,height:innerHeight,scrollY,documentHeight:document.documentElement.scrollHeight,
    documentWidth:document.documentElement.scrollWidth,aside:box('.sidebar'),nav:box('.nav'),
    footer:box('.side-note'),topbar:box('.topbar'),asideScrollHeight:aside.scrollHeight,
    asideClientHeight:aside.clientHeight};
})()"""


def check_desktop(data, label):
    assert data["documentHeight"] > 2 * data["height"], (label, data)
    assert -2 <= data["aside"]["top"] <= 2, (label, data)
    assert data["aside"]["bottom"] <= data["height"] + 2, (label, data)
    assert data["nav"]["top"] >= 0 and data["nav"]["bottom"] <= data["height"], (label, data)
    assert data["footer"]["top"] >= 0 and data["footer"]["bottom"] <= data["height"], (label, data)


def run_chrome(extension_dir: Path):
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory(prefix="historyfilter-sidebar-chrome-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile, executable_path=playwright.chromium.executable_path,
                headless=True, args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=10000)
                page = context.new_page()
                page.set_viewport_size({"width": 1280, "height": 800})
                page.goto(worker.url.split("/src/", 1)[0] + "/src/options/options.html")
                page.evaluate("rules => chrome.storage.local.set({history_rules:rules,options_locale:'en'})", RULES)
                page.reload()
                page.locator(".rule-card").first.wait_for()
                assert page.locator(".rule-card").count() == len(RULES)
                CAPTURES.mkdir(parents=True, exist_ok=True)
                for name, ratio in (("start", 0), ("middle", 0.5), ("end", 1)):
                    page.evaluate("ratio => scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*ratio)", ratio)
                    metrics = page.evaluate(METRICS)
                    check_desktop(metrics, name)
                    page.screenshot(path=str(CAPTURES / f"sidebar-chrome-{name}.png"))
                    print("Chrome", name, json.dumps(metrics, ensure_ascii=False))

                page.set_viewport_size({"width": 1280, "height": 500})
                page.evaluate("scrollTo(0,0)")
                short = page.evaluate(METRICS)
                assert short["aside"]["bottom"] <= short["height"] + 2
                assert short["nav"]["bottom"] <= short["height"]
                page.evaluate("document.querySelector('.sidebar').scrollTop=99999")
                short_footer = page.evaluate(METRICS)
                assert short_footer["footer"]["top"] >= 0 and short_footer["footer"]["bottom"] <= short_footer["height"]
                print("Chrome short", json.dumps(short_footer, ensure_ascii=False))

                page.set_viewport_size({"width": 390, "height": 844})
                page.evaluate("scrollTo(0,0)")
                mobile = page.evaluate(METRICS)
                assert mobile["documentWidth"] <= mobile["width"]
                assert mobile["nav"]["height"] <= 100
                assert mobile["aside"]["bottom"] <= mobile["topbar"]["top"] + 2
                page.screenshot(path=str(CAPTURES / "sidebar-chrome-mobile.png"))
                print("Chrome mobile", json.dumps(mobile, ensure_ascii=False))
            finally:
                context.close()


def run_firefox(extension_path: Path, geckodriver: Path, firefox_binary: Path):
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.firefox.service import Service
    from selenium.webdriver.common.by import By
    from firefox_release import api, eventually, install_extension

    opts = Options()
    opts.binary_location = str(firefox_binary)
    opts.add_argument("-headless")
    driver = webdriver.Firefox(
        service=Service(str(geckodriver), service_args=["--allow-system-access"]), options=opts,
    )
    try:
        addon_id = install_extension(driver, extension_path)
        driver.set_context("chrome")
        uuids = json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
        driver.set_context("content")
        driver.get(f"moz-extension://{uuids[addon_id]}/src/options/options.html")
        api(driver, "return browser.storage.local.set({history_rules:arguments[0],options_locale:'en'});", RULES)
        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) == len(RULES), "Firefox synthetic rules")
        CAPTURES.mkdir(parents=True, exist_ok=True)
        handle = driver.current_window_handle
        driver.set_window_size(1280, 800)
        driver.switch_to.window(handle)
        eventually(lambda: driver.execute_script("return innerWidth") == 1280, "Firefox desktop resize")
        for name, ratio in (("start", 0), ("middle", 0.5), ("end", 1)):
            driver.execute_script("scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*arguments[0]);", ratio)
            metrics = driver.execute_script("return " + METRICS)
            check_desktop(metrics, name)
            driver.save_screenshot(str(CAPTURES / f"sidebar-firefox-{name}.png"))
            print("Firefox", name, json.dumps(metrics, ensure_ascii=False))

        driver.set_window_size(1280, 500)
        driver.switch_to.window(handle)
        eventually(lambda: driver.execute_script("return innerHeight") < 500, "Firefox short resize")
        driver.execute_script("scrollTo(0,0);document.querySelector('.sidebar').scrollTop=99999;")
        short = driver.execute_script("return " + METRICS)
        assert short["aside"]["bottom"] <= short["height"] + 2
        assert short["footer"]["top"] >= 0 and short["footer"]["bottom"] <= short["height"]
        print("Firefox short", json.dumps(short, ensure_ascii=False))

        driver.set_window_size(390, 844)
        driver.switch_to.window(handle)
        eventually(lambda: driver.execute_script("return innerWidth<=500 && innerHeight>=700"), "Firefox narrow resize")
        driver.execute_script("scrollTo(0,0)")
        mobile = driver.execute_script("return " + METRICS)
        print("Firefox requested 390px narrow, actual window", driver.get_window_rect(), json.dumps(mobile, ensure_ascii=False))
        assert mobile["documentWidth"] <= mobile["width"]
        assert mobile["nav"]["height"] <= 100
        assert mobile["aside"]["bottom"] <= mobile["topbar"]["top"] + 2
        driver.save_screenshot(str(CAPTURES / "sidebar-firefox-mobile.png"))
        print("Firefox mobile", json.dumps(mobile, ensure_ascii=False))
    finally:
        driver.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("chrome", "firefox"), required=True)
    parser.add_argument("--extension", type=Path, default=ROOT,
                        help="Chrome unpacked directory or Firefox source directory/ZIP")
    add_firefox_arguments(parser)
    args = parser.parse_args()
    if args.browser == "chrome":
        run_chrome(args.extension.resolve())
    else:
        run_firefox(args.extension.resolve(), *firefox_tool_paths(args, parser))
