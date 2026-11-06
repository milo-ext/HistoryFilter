"""Real-browser preset catalog and selective-query cleanup acceptance.

Only disposable profiles and synthetic `.invalid`/localhost URLs are used.
Examples:
    python3 tests/browser_templates.py --browser chrome
    python3 tests/browser_templates.py --browser firefox
Pass --extension with an extracted Chrome directory or Firefox ZIP to test a package.
"""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path
from browser_tools import add_firefox_arguments, firefox_tool_paths


ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "release" / "qa_screenshots_current"
TEMPLATE_IDS = ["google-translate", "utm-cleanup", "tco-block", "site-domain-block", "local-dev-block"]
SOURCE = "https://utm.qa.invalid/watch?id=42&q=a+b&v=x%20y&t=7&list=one&list=two&utm_source=news&utm_medium=email#utm_campaign=fragment"
TARGET = "https://utm.qa.invalid/watch?id=42&q=a+b&v=x%20y&t=7&list=one&list=two#utm_campaign=fragment"


def rule(name, domain, action="block"):
    return {"id": f"qa-{name}", "name": name, "enabled": True,
            "matchType": "domain", "pattern": domain, "action": action}


def wait_for(predicate, label, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {label}")


def chrome(extension_dir: Path):
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory(prefix="historyfilter-templates-chrome-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile, executable_path=playwright.chromium.executable_path,
                headless=True, args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=10000)
                url = worker.url.split("/src/", 1)[0] + "/src/options/options.html"
                page = context.new_page()
                page.set_viewport_size({"width": 1280, "height": 800})
                page.emulate_media(color_scheme="light")
                page.goto(url)
                page.evaluate("chrome.storage.local.set({options_locale:'en'})")
                page.reload()
                page.locator(".rule-card").first.wait_for()
                get_rules = lambda: page.evaluate("chrome.storage.local.get('history_rules')")["history_rules"]
                history = lambda text: page.evaluate("text=>chrome.history.search({text,startTime:1,maxResults:1000})", text)
                send = lambda body: page.evaluate("body=>chrome.runtime.sendMessage(body)", body)
                initial = get_rules()
                assert len(initial) == 1 and initial[0]["id"] == "preset-google-translate"
                assert not any(item.get("templateId") for item in initial)
                page.locator("#open-templates-btn").click()
                assert page.locator("#template-modal").is_visible()
                ids = page.locator("#template-list .template-item").evaluate_all("els=>els.map(e=>e.dataset.templateId)")
                assert ids == TEMPLATE_IDS, ids
                assert page.locator('.template-item[data-template-id="google-translate"] button').is_disabled()
                CAPTURES.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(CAPTURES / "templates-chrome-en-light-desktop.png"))
                print("PASS Chrome catalog has five opt-in templates; default Google already added")

                old_tco = "https://t.co/qa123"
                page.evaluate("url=>chrome.history.addUrl({url})", old_tco)
                wait_for(lambda: any(item["url"] == old_tco for item in history("t.co")), "old t.co URL")
                page.locator('.template-item[data-template-id="utm-cleanup"] button').click()
                wait_for(lambda: len(get_rules()) == 2, "UTM add")
                utm = get_rules()[-1]
                assert utm["templateId"] == "utm-cleanup" and utm["enabled"]
                assert utm["matchType"] == "query" and utm["pattern"] == "utm_*"
                assert utm["normalizeOptions"] == {"stripSelectedQueryKeys": ["utm_*"]}
                page.locator('.template-item[data-template-id="tco-block"] button').click()
                wait_for(lambda: len(get_rules()) == 3, "t.co add")
                assert [item.get("templateId") for item in get_rules()] == [None, "utm-cleanup", "tco-block"]
                assert any(item["url"] == old_tco for item in history("t.co")), "Adding a template bulk-deleted old history"
                page.evaluate("url=>chrome.history.addUrl({url})", old_tco)
                wait_for(lambda: not any(item["url"] == old_tco for item in history("t.co")), "revisited t.co deletion")
                print("PASS Chrome adds append/enable; no bulk cleanup on add; exact revisit deletes prior visits")

                page.locator("#cancel-templates-btn").click()
                second = context.new_page()
                second.goto(url)
                page.evaluate("window.__qaAdd=chrome.runtime.sendMessage({action:'addRuleTemplate',templateId:'local-dev-block'});true")
                second.evaluate("window.__qaAdd=chrome.runtime.sendMessage({action:'addRuleTemplate',templateId:'local-dev-block'});true")
                replies = [page.evaluate("window.__qaAdd"), second.evaluate("window.__qaAdd")]
                assert sorted(reply["added"] for reply in replies) == [False, True], replies
                assert sum(item.get("templateId") == "local-dev-block" for item in get_rules()) == 1
                page.reload()
                page.locator(".rule-card").first.wait_for()
                assert [item.get("templateId") for item in get_rules()][:4] == [None, "utm-cleanup", "tco-block", "local-dev-block"]
                print("PASS Chrome concurrent cross-tab fixed-template requests create one rule")

                page.locator("#open-templates-btn").click()
                before_site = len(get_rules())
                page.locator('.template-item[data-template-id="site-domain-block"] button').click()
                assert page.locator("#rule-modal").is_visible() and page.locator("#site-template-note").is_visible()
                assert len(get_rules()) == before_site
                page.locator("#cancel-btn").click()
                assert len(get_rules()) == before_site
                page.locator("#open-templates-btn").click()
                page.locator('.template-item[data-template-id="site-domain-block"] button').click()
                page.locator("#rule-pattern").fill("site.qa.invalid/path")
                page.locator("#save-rule-btn").click()
                assert page.locator("#form-error").inner_text().strip()
                assert len(get_rules()) == before_site
                page.locator("#rule-pattern").fill("site.qa.invalid")
                page.locator("#save-rule-btn").click()
                wait_for(lambda: len(get_rules()) == before_site + 1, "site add")
                assert get_rules()[-1]["templateId"] == "site-domain-block" and get_rules()[-1]["pattern"] == "site.qa.invalid"
                duplicate_site = send({"action": "addRuleTemplate", "templateId": "site-domain-block", "domain": "site.qa.invalid"})
                assert duplicate_site["added"] is False
                other_site = send({"action": "addRuleTemplate", "templateId": "site-domain-block", "domain": "other.qa.invalid"})
                assert other_site["added"] is True
                assert len(get_rules()) == before_site + 2
                print("PASS Chrome configurable site waits for save, dedupes same domain, reuses other domain")

                page.reload()
                page.locator(".rule-card").first.wait_for()
                utm_id = utm["id"]
                page.locator(f'.rule-card .edit[data-id="{utm_id}"]').click()
                assert page.locator("#rule-match-type").input_value() == "query"
                assert page.locator("#rule-pattern").input_value() == "utm_*"
                assert page.locator("#normalize-mode").input_value() == "stripSelectedQuery"
                assert page.locator("#strip-query-keys").input_value() == "utm_*"
                page.locator("#save-rule-btn").click()
                page.reload()
                roundtrip = next(item for item in get_rules() if item["id"] == utm["id"])
                assert roundtrip["matchType"] == "query" and roundtrip["normalizeOptions"] == {"stripSelectedQueryKeys": ["utm_*"]}
                page.locator("#language-toggle").click()
                page.emulate_media(color_scheme="dark")
                page.set_viewport_size({"width": 390, "height": 844})
                page.locator("#open-templates-btn").click()
                page.screenshot(path=str(CAPTURES / "templates-chrome-zh-dark-narrow.png"))
                page.locator("#cancel-templates-btn").click()
                page.locator(f'.rule-card .edit[data-id="{utm_id}"]').click()
                page.screenshot(path=str(CAPTURES / "templates-chrome-utm-editor-zh-dark-narrow.png"))
                page.locator("#cancel-btn").click()
                page.locator("#add-rule-btn").click()
                page.locator("#rule-name").fill("Invalid selector")
                page.locator("#rule-match-type").select_option("query")
                page.locator("#rule-pattern").fill("*")
                page.locator("#save-rule-btn").click()
                assert page.locator("#form-error").inner_text().strip()
                page.locator("#rule-pattern").fill("utm_*")
                page.locator("#normalize-mode").select_option("stripSelectedQuery")
                page.locator("#strip-query-keys").fill("*")
                page.locator("#save-rule-btn").click()
                assert page.locator("#form-error").inner_text().strip()
                page.locator("#cancel-btn").click()
                print("PASS Chrome UTM editor round trip and bilingual light/dark catalog/editor")

                local_dev = next(item for item in get_rules() if item.get("templateId") == "local-dev-block")
                check_dev = lambda test_url: page.evaluate('''async ({url,rule}) => {const m=await import(chrome.runtime.getURL('src/background/rule-engine.js'));return m.evaluateUrl(url,[rule]);}''', {"url": test_url, "rule": local_dev})
                assert check_dev("http://localhost:3000/path")["action"] == "block"
                assert check_dev("https://127.0.0.1:8443/path")["action"] == "block"
                assert check_dev("http://localhost.evil/path") is None
                assert check_dev("http://127.0.0.2/path") is None
                print("PASS Chrome selector validation and anchored localhost/127.0.0.1 template")

                page.evaluate("chrome.history.deleteAll()")
                page.evaluate("rules=>chrome.storage.local.set({history_rules:rules})", [utm, rule("later", "utm.qa.invalid")])
                page.evaluate("url=>chrome.history.addUrl({url})", SOURCE)
                wait_for(lambda: any(item["url"] == TARGET for item in history("utm.qa.invalid")), "UTM target")
                assert not any(item["url"] == SOURCE for item in history("utm.qa.invalid"))
                no_utm = "https://utm.qa.invalid/watch?id=42&q=a+b"
                page.evaluate("url=>chrome.history.addUrl({url})", no_utm)
                wait_for(lambda: not any(item["url"] == no_utm for item in history("utm.qa.invalid")), "later block")
                page.evaluate("rules=>chrome.storage.local.set({history_rules:rules})", [utm])
                fragment = "https://utm.qa.invalid/watch?id=42#utm_source=x"
                page.evaluate("url=>chrome.history.addUrl({url})", fragment)
                wait_for(lambda: any(item["url"] == fragment for item in history("utm.qa.invalid")), "fragment unmatched")
                assert send({"action": "addRuleTemplate", "templateId": "utm-cleanup"})["added"] is False
                print("PASS Chrome real-time UTM-only normalize preserves raw query/hash; no-UTM falls to later block")

                page.evaluate("chrome.history.deleteAll()")
                page.evaluate("chrome.storage.local.set({history_rules:[]})")
                page.evaluate("url=>chrome.history.addUrl({url})", SOURCE)
                wait_for(lambda: any(item["url"] == SOURCE for item in history("utm.qa.invalid")), "old UTM URL")
                page.evaluate("rules=>chrome.storage.local.set({history_rules:rules})", [utm])
                preview = send({"action": "manualCleanupPreview", "days": 30})
                assert preview["normalizedCount"] == 1 and any(item["url"] == SOURCE and item["newUrl"] == TARGET for item in preview["samples"]), preview
                assert any(item["url"] == SOURCE for item in history("utm.qa.invalid"))
                executed = send({"action": "manualCleanupExecute", "planId": preview["planId"]})
                assert executed["normalizedCount"] == 1, executed
                assert any(item["url"] == TARGET for item in history("utm.qa.invalid"))
                print("PASS Chrome manual preview is read-only and executes selective UTM normalization")

                edited_legacy = {"id": "preset-google-translate", "name": "My Translate Edit", "enabled": False,
                                 "matchType": "domain", "pattern": "translate.google.com", "pathPattern": "/custom",
                                 "pathMatchType": "exact", "action": "normalize",
                                 "normalizeOptions": {"customFixedUrl": "https://keep.qa.invalid/"}}
                page.evaluate("rule=>chrome.storage.local.set({history_rules:[rule]})", edited_legacy)
                page.reload()
                wait_for(lambda: page.locator(".rule-card").count() == 1, "legacy UI reload")
                assert get_rules() == [edited_legacy]
                print("PASS Chrome edited legacy Google rule survives UI read/reload without template auto-append")
            finally:
                context.close()


def firefox(extension_path: Path, geckodriver: Path, firefox_binary: Path):
    import json
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.firefox.service import Service
    from firefox_release import api, click, eventually, fill, install_extension

    opts = Options()
    opts.binary_location = str(firefox_binary)
    opts.add_argument("-headless")
    opts.set_preference("layout.css.prefers-color-scheme.content-override", 1)
    driver = webdriver.Firefox(
        service=Service(str(geckodriver), service_args=["--allow-system-access"]),
        options=opts,
    )
    try:
        addon_id = install_extension(driver, extension_path)
        driver.set_context("chrome")
        uuids = json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
        driver.set_context("content")
        options_url = f"moz-extension://{uuids[addon_id]}/src/options/options.html"
        driver.get(options_url)
        api(driver, "return browser.storage.local.set({options_locale:'en'});")
        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) >= 1, "Firefox rules")
        get_rules = lambda: api(driver, "return browser.storage.local.get('history_rules');")["history_rules"]
        history = lambda text: api(driver, "return browser.history.search({text:arguments[0],startTime:1,maxResults:1000});", text)
        send = lambda body: api(driver, "return browser.runtime.sendMessage(arguments[0]);", body)
        initial = get_rules()
        assert len(initial) == 1 and initial[0]["id"] == "preset-google-translate"
        click(driver, "#open-templates-btn")
        ids = [item.get_attribute("data-template-id") for item in driver.find_elements(By.CSS_SELECTOR, "#template-list .template-item")]
        assert ids == TEMPLATE_IDS, ids
        assert not driver.find_element(By.CSS_SELECTOR, '.template-item[data-template-id="google-translate"] button').is_enabled()
        CAPTURES.mkdir(parents=True, exist_ok=True)
        driver.set_window_size(1280, 800)
        driver.switch_to.window(driver.current_window_handle)
        eventually(lambda: driver.execute_script("return innerWidth") == 1280, "Firefox desktop width")
        driver.save_screenshot(str(CAPTURES / "templates-firefox-en-light-desktop.png"))
        print("PASS Firefox five opt-in templates; default Google already added")

        old_tco = "https://t.co/firefoxqa"
        api(driver, "return browser.history.addUrl({url:arguments[0]});", old_tco)
        eventually(lambda: any(item["url"] == old_tco for item in history("t.co")), "old t.co")
        click(driver, '.template-item[data-template-id="utm-cleanup"] button')
        eventually(lambda: len(get_rules()) == 2, "UTM add")
        utm = get_rules()[-1]
        assert utm["templateId"] == "utm-cleanup" and utm["enabled"]
        assert utm["matchType"] == "query" and utm["pattern"] == "utm_*"
        assert utm["normalizeOptions"] == {"stripSelectedQueryKeys": ["utm_*"]}
        click(driver, '.template-item[data-template-id="tco-block"] button')
        eventually(lambda: len(get_rules()) == 3, "t.co add")
        assert [r.get("templateId") for r in get_rules()] == [None, "utm-cleanup", "tco-block"]
        assert any(item["url"] == old_tco for item in history("t.co"))
        api(driver, "return browser.history.addUrl({url:arguments[0]});", old_tco)
        eventually(lambda: not any(item["url"] == old_tco for item in history("t.co")), "t.co revisit deleted")
        click(driver, "#cancel-templates-btn")
        print("PASS Firefox add/append/enable; no bulk cleanup; revisit removes old URL")

        first_handle = driver.current_window_handle
        driver.switch_to.new_window("tab")
        second_handle = driver.current_window_handle
        driver.get(options_url)
        driver.execute_script("window.__qaAdd=browser.runtime.sendMessage({action:'addRuleTemplate',templateId:'local-dev-block'});")
        driver.switch_to.window(first_handle)
        driver.execute_script("window.__qaAdd=browser.runtime.sendMessage({action:'addRuleTemplate',templateId:'local-dev-block'});")
        first_result = api(driver, "return window.__qaAdd;")
        driver.switch_to.window(second_handle)
        second_result = api(driver, "return window.__qaAdd;")
        assert sorted((first_result["added"], second_result["added"])) == [False, True]
        assert sum(r.get("templateId") == "local-dev-block" for r in get_rules()) == 1
        driver.switch_to.window(first_handle)
        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) == 4, "four rules")
        print("PASS Firefox cross-tab simultaneous fixed-template request creates one rule")

        click(driver, "#open-templates-btn")
        before_site = len(get_rules())
        click(driver, '.template-item[data-template-id="site-domain-block"] button')
        assert driver.find_element(By.CSS_SELECTOR, "#rule-modal").is_displayed()
        assert driver.find_element(By.CSS_SELECTOR, "#site-template-note").is_displayed()
        assert len(get_rules()) == before_site
        click(driver, "#cancel-btn")
        assert len(get_rules()) == before_site
        click(driver, "#open-templates-btn")
        click(driver, '.template-item[data-template-id="site-domain-block"] button')
        fill(driver, "#rule-pattern", "site.firefox.qa.invalid/path")
        click(driver, "#save-rule-btn")
        assert driver.find_element(By.CSS_SELECTOR, "#form-error").text.strip()
        assert len(get_rules()) == before_site
        fill(driver, "#rule-pattern", "site.firefox.qa.invalid")
        click(driver, "#save-rule-btn")
        eventually(lambda: len(get_rules()) == before_site + 1, "site add")
        assert get_rules()[-1]["templateId"] == "site-domain-block"
        assert send({"action": "addRuleTemplate", "templateId": "site-domain-block", "domain": "site.firefox.qa.invalid"})["added"] is False
        assert send({"action": "addRuleTemplate", "templateId": "site-domain-block", "domain": "other.firefox.qa.invalid"})["added"] is True
        print("PASS Firefox site template config/cancel/save and domain-specific reuse")

        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) >= 6, "saved rules")
        utm_id = utm["id"]
        click(driver, f'.rule-card .edit[data-id="{utm_id}"]')
        assert driver.find_element(By.CSS_SELECTOR, "#rule-match-type").get_attribute("value") == "query"
        assert driver.find_element(By.CSS_SELECTOR, "#rule-pattern").get_attribute("value") == "utm_*"
        assert driver.find_element(By.CSS_SELECTOR, "#normalize-mode").get_attribute("value") == "stripSelectedQuery"
        assert driver.find_element(By.CSS_SELECTOR, "#strip-query-keys").get_attribute("value") == "utm_*"
        click(driver, "#save-rule-btn")
        driver.refresh()
        roundtrip = next(r for r in get_rules() if r["id"] == utm_id)
        assert roundtrip["matchType"] == "query" and roundtrip["normalizeOptions"] == {"stripSelectedQueryKeys": ["utm_*"]}
        click(driver, "#language-toggle")
        driver.set_context("chrome")
        driver.execute_script('Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override",0)')
        driver.set_context("content")
        driver.set_window_size(390, 844)
        driver.switch_to.window(first_handle)
        eventually(lambda: driver.execute_script("return innerWidth") == 500, "Firefox narrow width")
        click(driver, "#open-templates-btn")
        driver.save_screenshot(str(CAPTURES / "templates-firefox-zh-dark-narrow.png"))
        click(driver, "#cancel-templates-btn")
        click(driver, f'.rule-card .edit[data-id="{utm_id}"]')
        driver.save_screenshot(str(CAPTURES / "templates-firefox-utm-editor-zh-dark-narrow.png"))
        click(driver, "#cancel-btn")
        from selenium.webdriver.support.ui import Select
        click(driver, "#add-rule-btn")
        fill(driver, "#rule-name", "Invalid selector")
        Select(driver.find_element(By.CSS_SELECTOR, "#rule-match-type")).select_by_value("query")
        fill(driver, "#rule-pattern", "*")
        click(driver, "#save-rule-btn")
        assert driver.find_element(By.CSS_SELECTOR, "#form-error").text.strip()
        fill(driver, "#rule-pattern", "utm_*")
        Select(driver.find_element(By.CSS_SELECTOR, "#normalize-mode")).select_by_value("stripSelectedQuery")
        fill(driver, "#strip-query-keys", "*")
        click(driver, "#save-rule-btn")
        assert driver.find_element(By.CSS_SELECTOR, "#form-error").text.strip()
        click(driver, "#cancel-btn")
        print("PASS Firefox UTM editor round trip and bilingual light/dark catalog/editor")

        local_dev = next(r for r in get_rules() if r.get("templateId") == "local-dev-block")
        def check_dev(test_url):
            return api(driver, "const m=await import(browser.runtime.getURL('src/background/rule-engine.js'));return m.evaluateUrl(arguments[0],[arguments[1]]);", test_url, local_dev)
        assert check_dev("http://localhost:3000/path")["action"] == "block"
        assert check_dev("https://127.0.0.1:8443/path")["action"] == "block"
        assert check_dev("http://localhost.evil/path") is None
        assert check_dev("http://127.0.0.2/path") is None
        print("PASS Firefox selector validation and anchored localhost/127.0.0.1 template")

        api(driver, "return browser.history.deleteAll();")
        api(driver, "return browser.storage.local.set({history_rules:arguments[0]});", [utm, rule("later", "utm.firefox.qa.invalid")])
        source = SOURCE.replace("utm.qa.invalid", "utm.firefox.qa.invalid")
        target = TARGET.replace("utm.qa.invalid", "utm.firefox.qa.invalid")
        api(driver, "return browser.history.addUrl({url:arguments[0]});", source)
        eventually(lambda: any(item["url"] == target for item in history("utm.firefox.qa.invalid")), "UTM normalize")
        assert not any(item["url"] == source for item in history("utm.firefox.qa.invalid"))
        no_utm = "https://utm.firefox.qa.invalid/watch?id=42&q=a+b"
        api(driver, "return browser.history.addUrl({url:arguments[0]});", no_utm)
        eventually(lambda: not any(item["url"] == no_utm for item in history("utm.firefox.qa.invalid")), "later block")
        api(driver, "return browser.storage.local.set({history_rules:arguments[0]});", [utm])
        fragment = "https://utm.firefox.qa.invalid/watch?id=42#utm_source=x"
        api(driver, "return browser.history.addUrl({url:arguments[0]});", fragment)
        eventually(lambda: any(item["url"] == fragment for item in history("utm.firefox.qa.invalid")), "fragment unmatched")
        print("PASS Firefox real-time selective UTM normalization preserves bytes/hash; no-UTM falls through")

        api(driver, "return browser.history.deleteAll();")
        api(driver, "return browser.storage.local.set({history_rules:[]});")
        api(driver, "return browser.history.addUrl({url:arguments[0]});", source)
        eventually(lambda: any(item["url"] == source for item in history("utm.firefox.qa.invalid")), "old UTM")
        api(driver, "return browser.storage.local.set({history_rules:arguments[0]});", [utm])
        preview = send({"action": "manualCleanupPreview", "days": 30})
        assert preview["normalizedCount"] == 1 and any(x["url"] == source and x["newUrl"] == target for x in preview["samples"]), preview
        assert any(x["url"] == source for x in history("utm.firefox.qa.invalid"))
        executed = send({"action": "manualCleanupExecute", "planId": preview["planId"]})
        assert executed["normalizedCount"] == 1 and any(x["url"] == target for x in history("utm.firefox.qa.invalid"))
        print("PASS Firefox read-only manual preview and selective UTM execute")

        edited_legacy = {"id": "preset-google-translate", "name": "My Translate Edit", "enabled": False,
                         "matchType": "domain", "pattern": "translate.google.com", "pathPattern": "/custom",
                         "pathMatchType": "exact", "action": "normalize",
                         "normalizeOptions": {"customFixedUrl": "https://keep.qa.invalid/"}}
        api(driver, "return browser.storage.local.set({history_rules:[arguments[0]]});", edited_legacy)
        driver.refresh()
        eventually(lambda: len(driver.find_elements(By.CSS_SELECTOR, ".rule-card")) == 1, "legacy reload")
        assert get_rules() == [edited_legacy]
        print("PASS Firefox edited legacy Google rule survives UI read/reload without template auto-append")
    finally:
        driver.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("chrome", "firefox"), required=True)
    parser.add_argument("--extension", type=Path, default=ROOT)
    add_firefox_arguments(parser)
    args = parser.parse_args()
    if args.browser == "chrome":
        chrome(args.extension.resolve())
    else:
        firefox(args.extension.resolve(), *firefox_tool_paths(args, parser))
