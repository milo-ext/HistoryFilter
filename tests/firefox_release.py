"""Real Firefox acceptance for an unsigned package or source directory.

Tools are installed outside this repository. Example:
    python3 tests/firefox_release.py --zip release/dist/HistoryFilter-v1.0.0-firefox.zip \
      --geckodriver /path/to/geckodriver --firefox /path/to/firefox

Use `--extension .` to load the repository directory through Firefox's
AddonManager, matching about:debugging's temporary source-install path.

Selenium/geckodriver creates a disposable Firefox profile. Only synthetic
`.invalid` history entries are created. Nothing touches a personal profile.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from browser_tools import add_firefox_arguments, firefox_tool_paths

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service


ROOT = Path(__file__).resolve().parents[1]


def eventually(predicate, label, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {label}")


def api(driver, body, *args):
    script = (
        "const done = arguments[arguments.length - 1];"
        "Promise.resolve().then(async () => {" + body + "})"
        ".then(value => done({ok:true,value}), error => done({ok:false,error:String(error)}));"
    )
    result = driver.execute_async_script(script, *args)
    if not result["ok"]:
        raise AssertionError(f"Firefox extension API failed: {result['error']}")
    return result.get("value")


def history(driver, text):
    return api(driver, "return browser.history.search({text:arguments[0],startTime:1,maxResults:1000});", text)


def rules(driver, items):
    api(driver, "return browser.storage.local.set({history_rules:arguments[0]});", items)


def add_url(driver, url):
    api(driver, "return browser.history.addUrl({url:arguments[0]});", url)


def message(driver, action, **fields):
    return api(driver, "return browser.runtime.sendMessage(arguments[0]);", {"action": action, **fields})


def rule(name, domain, action="block", **extras):
    return {"id": f"firefox-{name}", "name": name, "enabled": True,
            "matchType": "domain", "pattern": domain, "action": action, **extras}


def click(driver, selector):
    element = driver.find_element(By.CSS_SELECTOR, selector)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
    element.click()


def fill(driver, selector, value):
    element = driver.find_element(By.CSS_SELECTOR, selector)
    element.clear()
    element.send_keys(value)


def install_extension(driver, path: Path):
    if path.is_file():
        return driver.install_addon(str(path), temporary=True)
    # AddonManager's directory path is the same source-loading mechanism used
    # by about:debugging. Selenium.install_addon(directory) would zip .git and
    # release artifacts, which would test a different workflow.
    driver.set_context("chrome")
    result = driver.execute_async_script(
        "const done=arguments[arguments.length-1];"
        "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');"
        "const file=Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);"
        "file.initWithPath(arguments[0]);"
        "AddonManager.installTemporaryAddon(file).then(addon=>done({id:addon.id}),error=>done({error:String(error)}));",
        str(path),
    )
    driver.set_context("content")
    if "error" in result:
        raise AssertionError(f"Firefox directory install failed: {result['error']}")
    return result["id"]


def main(extension_path: Path, geckodriver: Path, firefox_binary: Path, idle_seconds: int):
    opts = Options()
    opts.binary_location = str(firefox_binary)
    opts.add_argument("-headless")
    driver = webdriver.Firefox(
        service=Service(str(geckodriver), service_args=["--allow-system-access"]),
        options=opts,
    )
    driver.set_script_timeout(90)
    try:
        profile = driver.capabilities.get("moz:profile", "")
        assert "rust_mozprofile" in profile, profile
        addon_id = install_extension(driver, extension_path)
        driver.set_context("chrome")
        uuids = json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
        extension_uuid = uuids[addon_id]
        driver.set_context("content")
        options_url = f"moz-extension://{extension_uuid}/src/options/options.html"
        driver.get(options_url)
        assert driver.title.startswith("HistoryFilter")
        manifest = driver.execute_script("return browser.runtime.getManifest()")
        assert manifest["manifest_version"] == 3
        assert manifest["background"]["scripts"]
        assert manifest["browser_specific_settings"]["gecko"]["id"] == addon_id
        initial = api(driver, "return browser.storage.local.get('history_rules');")["history_rules"]
        assert len(initial) == 1 and initial[0]["enabled"] is False
        api(driver, "return browser.storage.local.set({options_locale:'en'});")
        driver.refresh()
        eventually(lambda: driver.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == "en", "English options")
        screenshot_dir = ROOT / "release" / "qa_screenshots_current"
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        driver.set_window_size(1280, 800)
        driver.save_screenshot(str(screenshot_dir / "firefox-rules-en.png"))
        print(f"PASS Firefox {driver.capabilities['browserVersion']} disposable temporary install, module background, options, disabled default rule")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [rule("repeat", "repeat.firefox.qa.invalid")])
        target = "https://repeat.firefox.qa.invalid/private?token=synthetic"
        add_url(driver, target)
        eventually(lambda: not history(driver, "repeat.firefox.qa.invalid"), "first block")
        add_url(driver, target)
        eventually(lambda: not history(driver, "repeat.firefox.qa.invalid"), "repeat block")
        logs = api(driver, "return browser.storage.local.get('history_logs');").get("history_logs", [])
        assert all("token" not in str(entry) and "url" not in entry for entry in logs)
        print("PASS Firefox real-time first/repeat block and URL-free logs")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [
            rule("normalize", "order.firefox.qa.invalid", "normalize", normalizeOptions={"keepOriginOnly": True}),
            rule("later-block", "order.firefox.qa.invalid"),
        ])
        add_url(driver, "https://order.firefox.qa.invalid/path?q=synthetic")
        eventually(lambda: any(item["url"] == "https://order.firefox.qa.invalid/" for item in history(driver, "order.firefox.qa.invalid")), "normalized target")
        time.sleep(5.2)  # Firefox onVisited for the generated target must stay ignored.
        assert all("?q=" not in item["url"] for item in history(driver, "order.firefox.qa.invalid"))
        assert any(item["url"] == "https://order.firefox.qa.invalid/" for item in history(driver, "order.firefox.qa.invalid"))
        normalize_logs = api(driver, "return browser.storage.local.get('history_logs');")["history_logs"]
        assert sum(entry["action"] == "normalize" for entry in normalize_logs) == 1, normalize_logs
        api(driver, "return browser.history.deleteAll();")
        rules(driver, [
            {**rule("off", "path.firefox.qa.invalid"), "enabled": False},
            rule("private", "path.firefox.qa.invalid", pathPattern="/private", pathMatchType="prefix"),
        ])
        add_url(driver, "https://path.firefox.qa.invalid/public")
        add_url(driver, "https://path.firefox.qa.invalid/private/one")
        eventually(lambda: len(history(driver, "path.firefox.qa.invalid")) == 1, "path rule")
        assert history(driver, "path.firefox.qa.invalid")[0]["url"] == "https://path.firefox.qa.invalid/public"
        print("PASS Firefox normalize priority, disabled rule, and path matching")

        rules(driver, initial)
        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) >= 1, "rules UI")
        click(driver, ".rule-enabled + span")
        eventually(lambda: api(driver, "return browser.storage.local.get('history_rules');")["history_rules"][0]["enabled"], "opt-in Google rule")
        before_tester = history(driver, "translate.google.com")
        fill(driver, "#test-url", "https://translate.google.com/?text=synthetic")
        click(driver, "#test-rule-btn")
        assert "translate.google.com/" in driver.find_element(By.CSS_SELECTOR, "#test-result").text
        assert history(driver, "translate.google.com") == before_tester
        click(driver, "#language-toggle")
        first_language = driver.find_element(By.CSS_SELECTOR, "html").get_attribute("lang")
        assert first_language == "zh-CN"
        driver.save_screenshot(str(screenshot_dir / "firefox-rules-zh.png"))
        click(driver, "#language-toggle")
        assert driver.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == "en"
        click(driver, "#add-rule-btn")
        fill(driver, "#rule-name", "Firefox UI QA")
        fill(driver, "#rule-pattern", "ui.firefox.qa.invalid")
        click(driver, "#save-rule-btn")
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) == len(initial) + 1, "UI rule add")
        click(driver, ".rule-card:last-child .move-up")
        eventually(lambda: "Firefox UI QA" in driver.find_element(By.CSS_SELECTOR, ".rule-card:first-child").text, "UI reorder")
        click(driver, ".rule-card:first-child .edit")
        fill(driver, "#rule-name", "Firefox UI edited")
        click(driver, "#save-rule-btn")
        eventually(lambda: "Firefox UI edited" in driver.find_element(By.CSS_SELECTOR, ".rule-card:first-child").text, "UI edit")
        click(driver, ".rule-card:first-child .switch")
        eventually(lambda: api(driver, "return browser.storage.local.get('history_rules');")["history_rules"][0]["enabled"] is False, "UI disable")
        click(driver, ".rule-card:first-child .delete")
        click(driver, "#delete-confirm-btn")
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) == len(initial), "UI delete")
        click(driver, "#add-rule-btn")
        fill(driver, "#rule-name", "Invalid")
        fill(driver, "#rule-pattern", "bad..domain")
        click(driver, "#save-rule-btn")
        assert driver.find_element(By.CSS_SELECTOR, "#form-error").text.strip()
        click(driver, "#cancel-btn")
        print("PASS Firefox read-only rule tester, language, add/edit/disable/reorder/delete, inline validation")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [])
        old = "https://manual.firefox.qa.invalid/private?token=synthetic"
        add_url(driver, old)
        eventually(lambda: len(history(driver, "manual.firefox.qa.invalid")) == 1, "seeded old URL")
        rules(driver, [rule("manual", "manual.firefox.qa.invalid")])
        preview = message(driver, "manualCleanupPreview", days=30)
        assert preview["blockedCount"] == 1 and "expiresAt" not in preview, preview
        assert len(history(driver, "manual.firefox.qa.invalid")) == 1
        plan = api(driver, "return browser.storage.session.get('manual_cleanup_plan');")["manual_cleanup_plan"]
        assert plan["planId"] == preview["planId"] and "expiresAt" not in plan
        if idle_seconds:
            driver.switch_to.new_window("tab")
            idle_handle = driver.current_window_handle
            driver.get("about:blank")
            for handle in list(driver.window_handles):
                if handle == idle_handle:
                    continue
                driver.switch_to.window(handle)
                if driver.current_url.startswith(f"moz-extension://{extension_uuid}/"):
                    driver.close()
            driver.switch_to.window(idle_handle)
            time.sleep(idle_seconds)
            driver.get(options_url)
        result = message(driver, "manualCleanupExecute", planId=preview["planId"])
        assert result["blockedCount"] == 1, result
        eventually(lambda: not history(driver, "manual.firefox.qa.invalid"), "manual delete")
        replay = message(driver, "manualCleanupExecute", planId=preview["planId"])
        assert replay["errorCode"] == "PLAN_UNAVAILABLE", replay
        driver.switch_to.new_window("tab")
        driver.get(options_url)
        assert message(driver, "manualCleanupExecute", planId=preview["planId"])["errorCode"] == "PLAN_UNAVAILABLE"
        print("PASS Firefox read-only frozen preview, session plan, execute once, replay reject")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [])
        changed_url = "https://changed.firefox.qa.invalid/private"
        add_url(driver, changed_url)
        eventually(lambda: len(history(driver, "changed.firefox.qa.invalid")) == 1, "changed-rule seed")
        rules(driver, [rule("before", "changed.firefox.qa.invalid")])
        preview = message(driver, "manualCleanupPreview", days=30)
        rules(driver, [rule("after", "changed.firefox.qa.invalid")])
        changed = message(driver, "manualCleanupExecute", planId=preview["planId"])
        assert changed["errorCode"] == "RULES_CHANGED", changed
        assert history(driver, "changed.firefox.qa.invalid")
        print("PASS Firefox changed-rule rejection leaves history untouched")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [])
        repeated = "https://range.firefox.qa.invalid/private"
        api(driver, "return browser.history.addUrl({url:arguments[0],visitTime:Date.now()-40*86400000});", repeated)
        add_url(driver, repeated)
        visits = api(driver, "return browser.history.getVisits({url:arguments[0]});", repeated)
        assert len(visits) >= 2, visits
        rules(driver, [rule("range", "range.firefox.qa.invalid")])
        range_preview = message(driver, "manualCleanupPreview", days=30)
        assert range_preview["blockedCount"] == 1, range_preview
        range_result = message(driver, "manualCleanupExecute", planId=range_preview["planId"])
        assert range_result["blockedCount"] == 1, range_result
        assert api(driver, "return browser.history.getVisits({url:arguments[0]});", repeated) == []
        print("PASS Firefox last-visit range selects URL; deleteUrl removes old and new visits")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [])
        boundary = int(time.time() * 1000) - 2 * 86400000
        boundary_urls = [f"https://boundary.firefox.qa.invalid/{index}" for index in range(3)]
        for url, visit_time in zip(boundary_urls, [boundary - 1, boundary, boundary]):
            api(driver, "return browser.history.addUrl({url:arguments[0],visitTime:arguments[1]});", url, visit_time)
        full = {item["url"] for item in history(driver, "boundary.firefox.qa.invalid")}
        assert full == set(boundary_urls), full
        left = api(driver, "return browser.history.search({text:'boundary.firefox.qa.invalid',startTime:arguments[0],endTime:arguments[1],maxResults:100});", boundary - 2, boundary + 1)
        right = api(driver, "return browser.history.search({text:'boundary.firefox.qa.invalid',startTime:arguments[0],endTime:arguments[1],maxResults:100});", boundary, boundary + 3)
        assert {item["url"] for item in left + right} == full
        assert len([item for item in left + right if item["url"] in boundary_urls[1:]]) >= 2
        print("PASS Firefox native search overlap covers boundary and tied visit timestamps")

        rules(driver, initial)
        driver.refresh()
        click(driver, 'button[data-page="cleanup"]')
        assert driver.find_element(By.CSS_SELECTOR, "#cleanup-recent").is_selected()
        click(driver, "#cleanup-all-time")
        assert not driver.find_element(By.CSS_SELECTOR, "#cleanup-days").is_enabled()
        click(driver, "#cleanup-recent")
        assert driver.find_element(By.CSS_SELECTOR, "#cleanup-days").is_enabled()
        print("PASS Firefox recent/all radio range and days enabled state")

        api(driver, "return browser.history.deleteAll();")
        rules(driver, [])
        ui_url = "https://ui-cleanup.firefox.qa.invalid/private?token=synthetic"
        add_url(driver, ui_url)
        eventually(lambda: len(history(driver, "ui-cleanup.firefox.qa.invalid")) == 1, "UI cleanup seed")
        rules(driver, [rule("UI cleanup", "ui-cleanup.firefox.qa.invalid")])
        driver.refresh()
        click(driver, 'button[data-page="cleanup"]')
        click(driver, "#cleanup-btn")
        eventually(lambda: driver.find_element(By.CSS_SELECTOR, "#preview-container").is_displayed(), "Firefox UI preview")
        assert ui_url in driver.find_element(By.CSS_SELECTOR, "#preview-stats").text
        assert history(driver, "ui-cleanup.firefox.qa.invalid")
        driver.save_screenshot(str(screenshot_dir / "firefox-cleanup-preview-en.png"))
        click(driver, "#cleanup-all-time")
        eventually(lambda: not driver.find_element(By.CSS_SELECTOR, "#preview-container").is_displayed(), "range invalidated Firefox preview")
        assert not driver.find_element(By.CSS_SELECTOR, "#cleanup-days").is_enabled()
        click(driver, "#cleanup-btn")
        eventually(lambda: driver.find_element(By.CSS_SELECTOR, "#preview-container").is_displayed(), "Firefox all-history preview")
        assert "Beginning" in driver.find_element(By.CSS_SELECTOR, "#preview-stats").text
        click(driver, "#cancel-cleanup-btn")
        eventually(lambda: not driver.find_element(By.CSS_SELECTOR, "#preview-container").is_displayed(), "Firefox preview cancel")
        click(driver, "#cleanup-recent")
        fill(driver, "#cleanup-days", "7")
        click(driver, "#cleanup-btn")
        eventually(lambda: driver.find_element(By.CSS_SELECTOR, "#preview-container").is_displayed(), "Firefox seven-day preview")
        click(driver, "#language-toggle")
        assert driver.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == "zh-CN"
        driver.save_screenshot(str(screenshot_dir / "firefox-cleanup-preview-zh.png"))
        click(driver, "#confirm-cleanup-btn")
        eventually(lambda: driver.find_element(By.CSS_SELECTOR, "#cleanup-status").get_attribute("class") == "status-good", "Firefox cleanup result")
        assert history(driver, "ui-cleanup.firefox.qa.invalid") == []
        assert not driver.find_element(By.CSS_SELECTOR, "#confirm-cleanup-btn").is_displayed()
        click(driver, 'button[data-page="activity"]')
        assert "ui-cleanup.firefox.qa.invalid" not in driver.find_element(By.CSS_SELECTOR, "#logs-list").text
        print("PASS Firefox UI preview/range invalidation/cancel/execute and bilingual URL-free activity")
    finally:
        driver.quit()


def restart_case(extension_path: Path, geckodriver: Path, firefox_binary: Path):
    with tempfile.TemporaryDirectory(prefix="historyfilter-firefox-restart-") as profile:
        def launch():
            opts = Options()
            opts.binary_location = str(firefox_binary)
            opts.add_argument("-headless")
            opts.add_argument("-profile")
            opts.add_argument(profile)
            opts.set_preference("extensions.webextensions.keepStorageOnUninstall", True)
            opts.set_preference("extensions.webextensions.keepUuidOnUninstall", True)
            return webdriver.Firefox(
                service=Service(str(geckodriver), service_args=["--allow-system-access"]),
                options=opts,
            )

        def open_addon(driver):
            addon_id = install_extension(driver, extension_path)
            driver.set_context("chrome")
            uuids = json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
            driver.set_context("content")
            driver.get(f"moz-extension://{uuids[addon_id]}/src/options/options.html")

        first = launch()
        try:
            assert first.capabilities.get("moz:profile") == profile
            open_addon(first)
            api(first, "return browser.history.deleteAll();")
            rules(first, [])
            source = "https://restart.firefox.qa.invalid/old"
            add_url(first, source)
            eventually(lambda: history(first, "restart.firefox.qa.invalid"), "restart source")
            saved_rules = [rule("restart", "restart.firefox.qa.invalid")]
            rules(first, saved_rules)
            api(first, "return browser.storage.local.set({options_locale:'zh-CN'});")
            preview = message(first, "manualCleanupPreview", days=30)
            assert preview["blockedCount"] == 1
        finally:
            first.quit()

        second = launch()
        try:
            assert second.capabilities.get("moz:profile") == profile
            open_addon(second)
            stored = api(second, "return browser.storage.local.get(['history_rules','options_locale']);")
            assert stored["history_rules"] == saved_rules and stored["options_locale"] == "zh-CN", stored
            assert api(second, "return browser.storage.session.get('manual_cleanup_plan');") == {}
            assert message(second, "manualCleanupExecute", planId=preview["planId"])["errorCode"] == "PLAN_UNAVAILABLE"
            assert history(second, "restart.firefox.qa.invalid")
            print("PASS Firefox restart retains rules/language/history and clears session preview")
        finally:
            second.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", "--zip", dest="extension_path", type=Path,
                        default=ROOT / "release/dist/HistoryFilter-v1.0.0-firefox.zip",
                        help="Firefox ZIP or source directory for actual temporary directory loading")
    add_firefox_arguments(parser)
    parser.add_argument("--idle-seconds", type=int, default=0,
                        help="Optional bounded idle wait before executing a preview")
    args = parser.parse_args()
    geckodriver, firefox_binary = firefox_tool_paths(args, parser)
    main(args.extension_path.resolve(), geckodriver, firefox_binary, args.idle_seconds)
    restart_case(args.extension_path.resolve(), geckodriver, firefox_binary)
