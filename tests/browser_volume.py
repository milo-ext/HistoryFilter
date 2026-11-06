"""Focused uncapped cleanup check in a disposable Chromium profile.

Run separately from the quick release suite:
    python3 tests/browser_volume.py

This creates only synthetic .invalid history URLs in a new temporary profile.
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser_release import ROOT, put_rules, rule


def main(extension_dir: Path):
    with tempfile.TemporaryDirectory(prefix="historyfilter-volume-qa-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=playwright.chromium.executable_path,
                headless=True,
                args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=10000)
                page = context.new_page()
                page.set_default_timeout(120000)
                page.goto(worker.url.split("/src/", 1)[0] + "/src/options/options.html")
                page.evaluate("chrome.storage.local.set({options_locale:'en'})")
                page.reload()
                put_rules(page, [])
                unmatched = [f"https://keep.qa.invalid/item/{index}?v={index}" for index in range(8005)]
                matched = [f"https://matched.qa.invalid/item/{index}?v={index}" for index in range(2005)]
                urls = unmatched + matched
                for offset in range(0, len(urls), 250):
                    page.evaluate("batch => Promise.all(batch.map(url => chrome.history.addUrl({url})))", urls[offset:offset + 250])
                page.wait_for_timeout(400)
                seeded = page.evaluate("chrome.history.search({text:'',startTime:1,maxResults:20000})")
                assert len(seeded) >= len(urls), (len(seeded), len(urls))
                put_rules(page, [rule("Volume block", "matched.qa.invalid")])
                page.reload()
                page.locator('button[data-page="cleanup"]').click()
                page.locator("#cleanup-btn").click()
                page.locator("#preview-container").wait_for(state="visible", timeout=120000)
                plan = page.evaluate("chrome.storage.session.get('manual_cleanup_plan')")["manual_cleanup_plan"]
                assert plan["totalChecked"] >= len(urls), plan["totalChecked"]
                assert len(plan["operations"]) == len(matched), len(plan["operations"])
                assert page.locator("#preview-stats .hintbar").is_visible()
                english_warning = page.locator("#preview-stats .hintbar").inner_text()
                assert "10,000" in english_warning and "continue" in english_warning.lower(), english_warning
                assert page.locator("#confirm-cleanup-btn").is_enabled()
                before = page.evaluate("chrome.history.search({text:'matched.qa.invalid',startTime:1,maxResults:3000})")
                assert len(before) == len(matched), len(before)
                screenshot_dir = ROOT / "release" / "qa_screenshots_current"
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                page.set_viewport_size({"width": 1280, "height": 800})
                page.locator("#preview-stats .hintbar").scroll_into_view_if_needed()
                page.screenshot(path=str(screenshot_dir / "large-history-en-qa.png"))
                print(f"PASS full preview: {plan['totalChecked']} URLs scanned, {len(plan['operations'])} operations, no writes")
                page.locator("#language-toggle").click()
                assert page.locator("html").get_attribute("lang") == "zh-CN"
                chinese_warning = page.locator("#preview-stats .hintbar").inner_text()
                assert chinese_warning != english_warning and "10,000" in chinese_warning, chinese_warning
                assert page.locator("#confirm-cleanup-btn").is_enabled()
                page.locator("#preview-stats .hintbar").scroll_into_view_if_needed()
                page.screenshot(path=str(screenshot_dir / "large-history-zh-qa.png"))
                print("PASS large-history warning in English and Chinese; confirmation remains available")
                page.locator("#confirm-cleanup-btn").click()
                page.locator("#cleanup-status.status-good").wait_for(state="visible", timeout=120000)
                assert not page.locator("#confirm-cleanup-btn").is_visible()
                remaining = page.evaluate("chrome.history.search({text:'matched.qa.invalid',startTime:1,maxResults:3000})")
                assert remaining == [], len(remaining)
                after_keep = page.evaluate("chrome.history.search({text:'keep.qa.invalid',startTime:1,maxResults:9000})")
                assert len(after_keep) == len(unmatched), len(after_keep)
                result = page.evaluate("chrome.storage.local.get('history_logs')")["history_logs"][0]
                assert result["action"] == "cleanup" and result["counts"]["blockedCount"] == len(matched), result
                print(f"PASS execution deleted all {len(matched)} matching URLs and preserved {len(unmatched)} unmatched URLs")
            finally:
                context.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-dir", type=Path, default=ROOT)
    args = parser.parse_args()
    main(args.extension_dir.resolve())
