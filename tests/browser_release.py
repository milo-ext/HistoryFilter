"""Real Chromium smoke tests for the unpacked extension.

Run with a Python environment that has Playwright and a locally installed
Playwright Chromium browser:

    python3 tests/browser_release.py

Every run creates and removes a fresh browser profile. The only history URLs
created by this suite use synthetic .invalid hosts; no personal profile is read.
"""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def wait_for(predicate, label: str, timeout: float = 8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {label}")


def history(page, fragment: str):
    return page.evaluate(
        "text => chrome.history.search({text, startTime: 1, maxResults: 100})",
        fragment,
    )


def add_visit(page, url: str):
    page.evaluate("url => chrome.history.addUrl({url})", url)


def put_rules(page, rules):
    page.evaluate("rules => chrome.storage.local.set({history_rules: rules})", rules)


def logs(page):
    return page.evaluate("chrome.storage.local.get('history_logs')").get("history_logs", [])


def clear(page):
    page.evaluate("chrome.history.deleteAll()")
    page.evaluate("chrome.storage.local.set({history_logs: []})")


def cleanup_message(page, action: str, **fields):
    return page.evaluate(
        "message => chrome.runtime.sendMessage(message)",
        {"action": action, **fields},
    )


def rule(name, pattern, action="block", **extra):
    return {
        "id": f"qa-{name}",
        "name": name,
        "enabled": True,
        "matchType": "domain",
        "pattern": pattern,
        "action": action,
        **extra,
    }


def main(extension_dir: Path):
    with tempfile.TemporaryDirectory(prefix="historyfilter-release-qa-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=playwright.chromium.executable_path,
                headless=True,
                args=[
                    f"--disable-extensions-except={extension_dir}",
                    f"--load-extension={extension_dir}",
                ],
            )
            screenshot_dir = ROOT / "release" / "qa_screenshots_current"
            try:
                workers = context.service_workers
                worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=10000)
                extension_origin = worker.url.split("/src/", 1)[0]
                def opened_options():
                    context.pages[0].wait_for_timeout(100)
                    return next((candidate for candidate in context.pages
                                 if candidate.url.startswith(extension_origin + "/src/options/options.html")), None)
                installed_options = wait_for(opened_options, "first-install options page", timeout=15)
                page = context.new_page()
                page.goto(f"{extension_origin}/src/options/options.html")
                assert installed_options.url.startswith(extension_origin)
                assert page.title().startswith("HistoryFilter")
                assert page.evaluate("chrome.runtime.getManifest().permissions") == ["history", "storage"]
                initial_rules = page.evaluate("chrome.storage.local.get('history_rules')")["history_rules"]
                assert len(initial_rules) == 1 and initial_rules[0]["enabled"] is False
                print("PASS fresh install, manifest permissions, options page, default rules")

                page.evaluate("chrome.storage.local.set({options_locale: 'en'})")
                page.reload()
                assert page.locator("html").get_attribute("lang") == "en"
                assert page.locator("#rules-title").inner_text().strip()
                page.locator("#test-url").fill("https://translate.google.com/?text=example&sl=auto")
                page.locator("#test-rule-btn").click()
                assert "No enabled rule" in page.locator("#test-result").inner_text()
                page.locator(".rule-enabled").first.locator("..").click()
                wait_for(lambda: page.evaluate("chrome.storage.local.get('history_rules')")["history_rules"][0]["enabled"], "opt-in default rule")
                before_test_history = history(page, "translate.google.com")
                before_test_logs = logs(page)
                page.locator("#test-url").fill("https://translate.google.com/?text=example&sl=auto")
                page.locator("#test-rule-btn").click()
                english_result = page.locator("#test-result").inner_text()
                assert "translate.google.com/" in english_result
                assert history(page, "translate.google.com") == before_test_history
                assert logs(page) == before_test_logs
                print("PASS rule tester evaluates live rules without reading or changing history")

                english_heading = page.locator("#rules-title").inner_text()
                page.locator("#language-toggle").click()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "zh-CN", "Chinese locale")
                assert page.locator("#rules-title").inner_text() != english_heading
                assert page.locator("#test-result").inner_text() != english_result
                assert page.locator("#test-url").get_attribute("aria-label")
                assert page.evaluate("chrome.storage.local.get('options_locale')")["options_locale"] == "zh-CN"
                page.reload()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "zh-CN", "persisted Chinese locale")
                wait_for(lambda: page.locator(".rule-card").count() == len(initial_rules), "rules after locale reload")
                assert page.locator("#rules-title").inner_text() != english_heading
                page.locator("#language-toggle").click()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "en", "English locale restored")
                assert page.locator("#rules-title").inner_text() == english_heading
                for locale_code in ("en",):
                    assert page.locator("#add-rule-btn").inner_text().strip()
                    assert page.locator('button[data-page="cleanup"]').inner_text().strip()
                    assert page.locator("#test-url").get_attribute("aria-label")
                print("PASS Chinese/English labels, translated tester result, and persisted language")

                page.locator("#add-rule-btn").click()
                page.locator("#rule-modal").wait_for(state="visible")
                page.locator("#rule-name").fill("UI QA rule")
                page.locator("#rule-pattern").fill("ui.qa.invalid")
                assert page.locator("#rule-pattern").input_value() == "ui.qa.invalid"
                page.locator("#save-rule-btn").click()
                try:
                    wait_for(lambda: page.locator(".rule-card").count() == len(initial_rules) + 1, "UI added rule")
                except AssertionError as exc:
                    stored_rules = page.evaluate("chrome.storage.local.get('history_rules')")
                    raise AssertionError(
                        f"{exc}; card count={page.locator('.rule-card').count()}, "
                        f"form error={page.locator('#form-error').inner_text()!r}, "
                        f"pattern value={page.locator('#rule-pattern').input_value()!r}, "
                        f"rule status={page.locator('#rule-status').inner_text()!r}, "
                        f"stored rules={stored_rules!r}"
                    ) from exc
                page.locator(".rule-card").last.locator(".edit").click()
                page.locator("#rule-name").fill("UI QA edited")
                page.locator("details.advance").evaluate("element => element.open = true")
                page.locator("#rule-enabled").locator("..").click()
                assert not page.locator("#rule-enabled").is_checked()
                page.locator("#save-rule-btn").click()
                wait_for(lambda: "UI QA edited" in page.locator(".rule-card").last.inner_text(), "UI edited rule")
                assert not page.locator(".rule-card").last.locator(".rule-enabled").is_checked()
                page.locator(".rule-card").last.locator(".move-up").click()
                wait_for(lambda: "UI QA edited" in page.locator(".rule-card").first.inner_text(), "UI reordered rule")
                page.locator(".rule-card").first.locator(".delete").click()
                assert page.locator("#delete-modal").is_visible()
                page.locator("#delete-confirm-btn").click()
                wait_for(lambda: page.locator(".rule-card").count() == len(initial_rules), "UI deleted rule")

                def invalid_rule(pattern, match_type="domain", fixed_url=None):
                    page.locator("#add-rule-btn").click()
                    page.locator("#rule-name").fill("Invalid QA rule")
                    page.locator("#rule-match-type").select_option(match_type)
                    page.locator("#rule-pattern").fill(pattern)
                    if fixed_url is not None:
                        page.locator("#rule-action").select_option("normalize")
                        page.locator("#normalize-mode").select_option("customFixed")
                        page.locator("#custom-fixed-url").fill(fixed_url)
                    page.locator("#save-rule-btn").click()
                    assert page.locator("#rule-modal").is_visible(), "Invalid rule unexpectedly saved"
                    assert page.locator("#form-error").inner_text().strip(), "Invalid rule has no inline error"
                    page.locator("#cancel-btn").click()

                invalid_rule("bad..domain")
                invalid_rule("[", match_type="regex")
                invalid_rule("valid.qa.invalid", fixed_url="javascript:alert(1)")
                assert page.locator(".rule-card").count() == len(initial_rules)
                print("PASS options UI add, edit, disable, reorder, delete, and inline validation")

                malicious_name = '<img src=x onerror="window.__qa_xss=1">'
                put_rules(page, [*initial_rules, rule(malicious_name, "inert.qa.invalid")])
                page.reload()
                assert malicious_name in page.locator(".rule-card").last.inner_text()
                assert page.locator(".rule-card img").count() == 0
                assert page.evaluate("window.__qa_xss") is None
                put_rules(page, initial_rules)
                page.reload()
                print("PASS untrusted rule names render as inert text")

                clear(page)
                target = "https://repeat.qa.invalid/private?token=sensitive"
                put_rules(page, [rule("Repeat block", "repeat.qa.invalid")])
                add_visit(page, target)
                wait_for(lambda: len(logs(page)) >= 1, "first block log")
                assert history(page, "repeat.qa.invalid") == []
                add_visit(page, target)
                wait_for(lambda: len(logs(page)) >= 2, "second block log")
                assert history(page, "repeat.qa.invalid") == []
                assert all("token=" not in str(entry) for entry in logs(page))
                print("PASS first and repeated visits blocked; query redacted in stored logs")

                clear(page)
                put_rules(page, [
                    rule("Normalize first", "order.qa.invalid", "normalize", normalizeOptions={"keepOriginOnly": True}),
                    rule("Block second", "order.qa.invalid"),
                ])
                add_visit(page, "https://order.qa.invalid/path?q=secret")
                wait_for(lambda: any(item["url"] == "https://order.qa.invalid/" for item in history(page, "order.qa.invalid")), "normalized URL")
                assert all("?q=" not in item["url"] for item in history(page, "order.qa.invalid"))
                print("PASS first enabled rule wins; normalize writes clean target")

                clear(page)
                put_rules(page, [
                    {**rule("Disabled block", "disabled.qa.invalid"), "enabled": False},
                    rule("Path block", "disabled.qa.invalid", pathPattern="/private", pathMatchType="prefix"),
                ])
                add_visit(page, "https://disabled.qa.invalid/public")
                add_visit(page, "https://disabled.qa.invalid/private/one")
                wait_for(lambda: len(history(page, "disabled.qa.invalid")) == 1, "path-filtered visit")
                assert history(page, "disabled.qa.invalid")[0]["url"] == "https://disabled.qa.invalid/public"
                print("PASS disabled rule and path matching")

                clear(page)
                put_rules(page, [])
                old_block = "https://manual.qa.invalid/private?token=old"
                old_normalize = "https://manual.qa.invalid/search?q=secret"
                add_visit(page, old_block)
                add_visit(page, old_normalize)
                assert len(history(page, "manual.qa.invalid")) == 2
                page.wait_for_timeout(200)
                put_rules(page, [
                    rule("Manual path block", "manual.qa.invalid", pathPattern="/private", pathMatchType="prefix"),
                    rule("Manual normalize", "manual.qa.invalid", "normalize", normalizeOptions={"keepOriginOnly": True}),
                ])
                preview = cleanup_message(page, "manualCleanupPreview", days=30)
                assert preview["blockedCount"] == 1 and preview["normalizedCount"] == 1, preview
                assert {sample["statusCode"] for sample in preview["samples"]} == {"WILL_BLOCK", "WILL_NORMALIZE"}, preview
                assert len(history(page, "manual.qa.invalid")) == 2, "Preview mutated history"
                print("PASS manual preview is read only and counts both actions")

                # Force ordinary MV3 worker suspension without closing the browser.
                session = context.new_cdp_session(page)
                worker_targets = [target for target in session.send("Target.getTargets")["targetInfos"]
                                  if target["type"] == "service_worker" and target["url"].startswith(extension_origin)]
                assert len(worker_targets) == 1, worker_targets
                versions = []
                session.on("ServiceWorker.workerVersionUpdated", lambda event: versions.extend(event["versions"]))
                session.send("ServiceWorker.enable")
                page.wait_for_timeout(100)
                assert versions, "CDP did not report the extension worker version"
                version = next(v for v in versions if v["scriptURL"].startswith(extension_origin))
                session.send("ServiceWorker.stopWorker", {"versionId": version["versionId"]})
                result = cleanup_message(page, "manualCleanupExecute", planId=preview["planId"])
                assert result["blockedCount"] == 1 and result["normalizedCount"] == 1, result
                assert result["failedCount"] == 0 and result["partialCount"] == 0, result
                wait_for(lambda: len(history(page, "manual.qa.invalid")) == 1, "manual cleanup history changes")
                assert history(page, "manual.qa.invalid")[0]["url"] == "https://manual.qa.invalid/"
                second_tab = context.new_page()
                second_tab.goto(f"{extension_origin}/src/options/options.html")
                replay = cleanup_message(second_tab, "manualCleanupExecute", planId=preview["planId"])
                assert "error" in replay and "Preview again" in replay["error"], replay
                assert replay["errorCode"] == "PLAN_UNAVAILABLE", replay
                print("PASS preview survives worker suspension; execution is single use across tabs")

                clear(page)
                put_rules(page, [])
                change_url = "https://change.qa.invalid/private"
                add_visit(page, change_url)
                wait_for(lambda: any(item["url"] == change_url for item in history(page, "change.qa.invalid")), "old change URL")
                page.wait_for_timeout(200)
                put_rules(page, [rule("Before change", "change.qa.invalid")])
                preview = cleanup_message(page, "manualCleanupPreview", days=30)
                put_rules(page, [rule("After change", "change.qa.invalid")])
                changed = cleanup_message(page, "manualCleanupExecute", planId=preview["planId"])
                assert "Rules changed" in changed.get("error", ""), changed
                assert changed["errorCode"] == "RULES_CHANGED", changed
                assert any(item["url"] == change_url for item in history(page, "change.qa.invalid"))
                print("PASS changed rules invalidate preview without touching history")

                clear(page)
                put_rules(page, [])
                late_source = "https://no-ttl.qa.invalid/planned"
                late_unmatched = "https://keep-after-preview.qa.invalid/new"
                add_visit(page, late_source)
                wait_for(lambda: history(page, "no-ttl.qa.invalid"), "no-TTL source")
                page.wait_for_timeout(200)
                put_rules(page, [rule("No TTL", "no-ttl.qa.invalid")])
                old_preview = cleanup_message(page, "manualCleanupPreview", days=30)
                assert "expiresAt" not in old_preview
                assert "expiresAt" not in page.evaluate("chrome.storage.session.get('manual_cleanup_plan')")["manual_cleanup_plan"]
                add_visit(page, late_unmatched)
                active_worker = context.service_workers[-1]
                active_worker.evaluate("() => { globalThis.__qaRealNow = Date.now; Date.now = () => globalThis.__qaRealNow() + 10 * 60 * 1000; }")
                try:
                    late_result = cleanup_message(page, "manualCleanupExecute", planId=old_preview["planId"])
                finally:
                    active_worker.evaluate("() => { Date.now = globalThis.__qaRealNow; delete globalThis.__qaRealNow; }")
                assert late_result["blockedCount"] == 1, late_result
                assert history(page, "no-ttl.qa.invalid") == []
                assert any(item["url"] == late_unmatched for item in history(page, "keep-after-preview.qa.invalid"))
                assert cleanup_message(page, "manualCleanupExecute", planId=old_preview["planId"])["errorCode"] == "PLAN_UNAVAILABLE"
                print("PASS frozen plan executes after simulated 10 minutes; later unmatched URL remains; replay rejected")

                clear(page)
                put_rules(page, [])
                ui_cleanup_url = "https://ui-cleanup.qa.invalid/private?token=sample"
                add_visit(page, ui_cleanup_url)
                wait_for(lambda: any(item["url"] == ui_cleanup_url for item in history(page, "ui-cleanup.qa.invalid")), "UI cleanup source")
                page.wait_for_timeout(200)
                put_rules(page, [rule("UI cleanup", "ui-cleanup.qa.invalid")])
                page.reload()
                page.locator('button[data-page="cleanup"]').click()
                assert page.locator("#cleanup-recent").is_checked()
                assert not page.locator("#cleanup-all-time").is_checked()
                assert page.locator("#cleanup-days").is_enabled()
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                for width, height, suffix in ((1280, 800, "desktop"), (390, 844, "small")):
                    page.set_viewport_size({"width": width, "height": height})
                    fieldset = page.locator("#cleanup-range").bounding_box()
                    preview_button = page.locator("#cleanup-btn").bounding_box()
                    assert fieldset and preview_button and preview_button["y"] >= fieldset["y"] + fieldset["height"]
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                    page.screenshot(path=str(screenshot_dir / f"cleanup-range-en-recent-{suffix}.png"))
                page.locator("#cleanup-all-time").check()
                assert not page.locator("#cleanup-recent").is_checked()
                assert page.locator("#cleanup-days").is_disabled()
                page.screenshot(path=str(screenshot_dir / "cleanup-range-en-all-small.png"))
                page.locator("#language-toggle").click()
                assert page.locator("html").get_attribute("lang") == "zh-CN"
                for width, height, suffix in ((1280, 800, "desktop"), (390, 844, "small")):
                    page.set_viewport_size({"width": width, "height": height})
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                    page.screenshot(path=str(screenshot_dir / f"cleanup-range-zh-all-{suffix}.png"))
                page.locator("#cleanup-recent").check()
                assert page.locator("#cleanup-days").is_enabled()
                page.locator("#cleanup-days").fill("7")
                assert page.locator("#cleanup-days").input_value() == "7"
                page.screenshot(path=str(screenshot_dir / "cleanup-range-zh-recent-small.png"))
                page.locator("#language-toggle").click()
                assert page.locator("html").get_attribute("lang") == "en"
                page.locator("#cleanup-days").fill("30")
                page.set_viewport_size({"width": 1280, "height": 800})
                print("PASS English/Chinese recent/all radios, days state, aligned preview action at desktop and 390px")
                page.locator("#cleanup-btn").click()
                wait_for(lambda: page.locator("#preview-container").is_visible(), "visible UI preview")
                assert ui_cleanup_url in page.locator("#preview-stats").inner_text()
                assert any(item["url"] == ui_cleanup_url for item in history(page, "ui-cleanup.qa.invalid"))
                page.screenshot(path=str(screenshot_dir / "cleanup-preview-en-desktop.png"))
                page.set_viewport_size({"width": 390, "height": 844})
                page.screenshot(path=str(screenshot_dir / "cleanup-preview-en-small.png"))
                page.locator("#cleanup-all-time").check()
                wait_for(lambda: not page.locator("#preview-container").is_visible(), "range change invalidates preview")
                assert page.locator("#cleanup-days").is_disabled()
                page.locator("#cleanup-btn").click()
                wait_for(lambda: page.locator("#preview-container").is_visible(), "all-history preview")
                assert "Beginning" in page.locator("#preview-stats").inner_text()
                page.locator("#cleanup-recent").check()
                wait_for(lambda: not page.locator("#preview-container").is_visible(), "return to recent invalidates preview")
                page.locator("#cleanup-days").fill("7")
                assert page.locator("#cleanup-days").is_enabled()
                page.locator("#cleanup-btn").click()
                wait_for(lambda: page.locator("#preview-container").is_visible(), "seven-day preview")
                page.locator("#language-toggle").click()
                assert page.locator("html").get_attribute("lang") == "zh-CN"
                page.screenshot(path=str(screenshot_dir / "cleanup-preview-zh-small.png"))
                page.set_viewport_size({"width": 1280, "height": 800})
                page.screenshot(path=str(screenshot_dir / "cleanup-preview-zh-desktop.png"))
                page.locator("#language-toggle").click()
                assert page.locator("html").get_attribute("lang") == "en"
                page.locator('button[data-page="rules"]').click()
                page.locator(".rule-card .switch").first.click()
                wait_for(lambda: page.evaluate("chrome.storage.local.get('history_rules')")["history_rules"][0]["enabled"] is False,
                         "rule disabled in storage")
                page.locator('button[data-page="cleanup"]').click()
                assert not page.locator("#preview-container").is_visible(), "Rule mutation left stale preview visible"
                page.locator('button[data-page="rules"]').click()
                page.locator(".rule-card .switch").first.click()
                wait_for(lambda: page.evaluate("chrome.storage.local.get('history_rules')")["history_rules"][0]["enabled"] is True,
                         "rule reenabled in storage")
                page.locator('button[data-page="cleanup"]').click()
                page.locator("#cleanup-btn").click()
                wait_for(lambda: page.locator("#preview-container").is_visible(), "second UI preview")
                page.locator("#language-toggle").click()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "zh-CN", "Chinese preview locale")
                assert ui_cleanup_url in page.locator("#preview-stats").inner_text()
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                page.set_viewport_size({"width": 1280, "height": 800})
                page.screenshot(path=str(screenshot_dir / "cleanup-zh-qa.png"))
                page.locator("#confirm-cleanup-btn").click()
                wait_for(lambda: not history(page, "ui-cleanup.qa.invalid"), "UI cleanup execution")
                assert page.locator("#preview-container").is_visible()
                assert not page.locator("#confirm-cleanup-btn").is_visible()
                chinese_status = page.locator("#cleanup-status").inner_text()
                assert chinese_status.strip()
                page.locator("#language-toggle").click()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "en", "English result locale")
                assert page.locator("#cleanup-status").inner_text() != chinese_status
                page.locator('button[data-page="activity"]').click()
                assert page.locator("#logs-list .log-row").count() >= 1
                assert "ui-cleanup.qa.invalid" not in page.locator("#logs-list").inner_text()
                print("PASS real UI preview, rule-change invalidation, one-shot execute, translated result and URL-free logs")

                put_rules(page, initial_rules)
                page.reload()
                page.set_viewport_size({"width": 1280, "height": 800})
                page.mouse.move(1255, 790)
                page.screenshot(path=str(screenshot_dir / "rules-en.png"))
                page.locator("#language-toggle").click()
                wait_for(lambda: page.locator("html").get_attribute("lang") == "zh-CN", "Chinese rules screenshot")
                assert page.locator("#default-preset-note").is_visible()
                page.mouse.move(1255, 790)
                page.screenshot(path=str(screenshot_dir / "rules-zh.png"))
                page.set_viewport_size({"width": 390, "height": 844})
                page.screenshot(path=str(screenshot_dir / "rules-zh-small.png"))
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Options overflows small viewport"
                page.locator("#add-rule-btn").click()
                assert page.locator("#rule-modal").is_visible()
                assert page.locator("#save-rule-btn").is_visible() and page.locator("#cancel-btn").is_visible()
                save_box = page.locator("#save-rule-btn").bounding_box()
                cancel_box = page.locator("#cancel-btn").bounding_box()
                assert save_box and cancel_box and save_box["y"] + save_box["height"] <= 844
                assert cancel_box["y"] + cancel_box["height"] <= 844
                page.screenshot(path=str(screenshot_dir / "editor-zh-small.png"))
                page.locator("#cancel-btn").click()
                assert not page.locator("#rule-modal").is_visible()
                print("PASS bilingual production screenshots and narrow editor save/cancel visibility")

                legacy_url = "https://legacy.qa.invalid/private?token=do-not-retain"
                page.evaluate("data => chrome.storage.local.set(data)", {
                    "history_logs": [{"timestamp": 123456, "action": "block", "url": legacy_url,
                                      "message": "Old message with " + legacy_url}],
                })
                # Open options tabs now migrate logs immediately on storage changes.
                restart_plan_id = cleanup_message(page, "manualCleanupPreview", days=30)["planId"]
            finally:
                context.close()

            # Relaunch the same isolated QA profile to verify persistent local data
            # and the legacy-log migration path on ordinary browser startup.
            restarted = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=playwright.chromium.executable_path,
                headless=True,
                args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"],
            )
            try:
                worker = restarted.service_workers[0] if restarted.service_workers else restarted.wait_for_event("serviceworker", timeout=10000)
                options = restarted.new_page()
                options.goto(worker.url.split("/src/", 1)[0] + "/src/options/options.html")
                assert options.evaluate("chrome.storage.local.get('history_rules')")["history_rules"] == initial_rules
                expired_on_restart = cleanup_message(options, "manualCleanupExecute", planId=restart_plan_id)
                assert "Preview again" in expired_on_restart.get("error", ""), expired_on_restart
                wait_for(lambda: all("url" not in item and "message" not in item for item in logs(options)),
                         "legacy log migration")
                assert "legacy.qa.invalid" not in str(logs(options))
                print("PASS browser restart keeps rules, clears session plan, and physically migrates legacy URL logs")
            finally:
                restarted.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-dir", type=Path, default=ROOT,
                        help="Unpacked extension directory; defaults to the repository")
    args = parser.parse_args()
    main(args.extension_dir.resolve())
