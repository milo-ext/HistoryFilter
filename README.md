# HistoryFilter

HistoryFilter cleans browser history with ordered URL rules. One WebExtension source tree builds Manifest V3 packages for Chrome and Firefox. Processing stays in the browser; there are no runtime dependencies, analytics, or developer-operated servers.

## Install

- **Chrome** (121 or newer): [Chrome Web Store](https://chromewebstore.google.com/detail/historyfilter/cjpfcacmhemigfdhmmjjfcbmipaiiekg)
- **Firefox** (140 or newer, desktop): [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/historyfilter/)

The sections below are for building and testing from source.

## Build and try locally

```sh
python3 release/build_package.py --browser all
```

This creates `release/dist/HistoryFilter-v1.0.0-chrome.zip` and `release/dist/HistoryFilter-v1.0.0-firefox.zip`. Use `--browser chrome` or `--browser firefox` to build one package. Both archives contain the same `src/` and icon bytes; only `manifest.json` differs. The root development manifest directly loads in both browsers; it names the same module as a Chrome service worker and Firefox background script. The release ZIPs contain only their target browser's background entry and metadata.

- **Chrome development (121 or newer):** Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked** with this repository. After source edits, select **Reload** on the extension card. Chrome 121+ ignores the Firefox `background.scripts` entry in this dual development manifest. The packaged Chrome ZIP has only `background.service_worker`; extract it and load its directory when testing the exact release artifact.
- **Firefox development (140 or newer, desktop):** Open `about:debugging`, choose **This Firefox → Load Temporary Add-on**, and select the repository's root `manifest.json`. After source edits, select **Reload** there. You can also select the Firefox ZIP to test the exact release artifact. Firefox uses the module `background.scripts` entry in the root manifest. If Firefox says `background.service_worker is currently disabled`, check that you selected the dual root manifest or the **Firefox** ZIP, not the Chrome ZIP.

The Firefox ZIP is unsigned and only for temporary testing; a temporary add-on is removed when Firefox restarts. Persistent installation in standard Firefox requires Mozilla signing through AMO, including for self-distribution. The Firefox manifest declares no data collection. See Mozilla's [cross-browser background manifest guidance](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background), [temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/), [signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/), and [built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) guidance. Firefox for Android has not been tested.

New installations start with the **Google Translate Cleanup** rule **disabled**. Review its effect, then enable it if you want this cleanup. It matches `translate.google.com` URLs containing a `text` query parameter, deletes every visit to the original URL, and adds `https://translate.google.com/` with the current time. You can edit, disable, or delete it.

Rules are evaluated from top to bottom; the first enabled match wins. Domain rules can also match a path and query key. Regex rules check the full URL using the supported subset described below. `block` deletes all visits to the matched URL. `normalize` adds the configured target at the current time and then deletes all visits to the original URL. A new visit to an already visited matched URL triggers the same action again. History events arrive after the browser records a visit, so this is cleanup, not pre-navigation blocking.

## Options and language

The options page has Rules, Clean up history, and Activity sections. The local URL tester evaluates the URL you type against enabled rules without reading or changing browser history. Rule editing supports domain, optional path/query-key conditions, regular expressions, and six normalization modes. Changing rule order changes which matching rule wins.

**Add from template** offers five optional starting rules: the bundled Google Translate cleanup, UTM-only query cleanup, t.co history removal, a website domain you choose, and localhost/127.0.0.1 development history removal. Only the disabled Google Translate rule is present by default; other templates are added and enabled only after you choose them. New template rules append below existing rules and remain editable and reorderable. Fixed templates do not add duplicate copies, and the website template can be used for different domains. Saving a rule does not bulk-scan old history; use the manual cleanup preview for that. A later visit to a matching exact URL can still trigger automatic processing that removes its earlier visits.

**Export** saves all rules to a local JSON file (`historyfilter-rules-YYYY-MM-DD.json`); it contains rules only, not history or activity logs. **Import** reads such a file (up to 1 MB and 500 rules) and checks each rule with the same validation as the editor; invalid entries are skipped and counted. Keep at most 500 rules in total. You can add the imported rules below your current rules, skipping rules with an identical definition, or replace all current rules with the file's rules and order. Replacing cannot be undone, so export first if you may need the current rules. Importing does not scan old history.

The UTM template matches URLs containing a `utm_*` query key, then removes only those keys from the **history URL after the visit**. Other query parameters, their order and duplicates, and the fragment are retained where possible. It does not block network requests or prevent a site from receiving tracking parameters. The rule editor can also match comma-separated exact query keys or final-`*` prefixes and can selectively remove named keys.

The page offers English and Simplified Chinese. It starts in Chinese when the browser language begins with `zh`; otherwise it starts in English. A chosen language is saved as `options_locale` in extension local storage for that browser profile; it is not synced. The tester input is held only in the open page.

The options page follows the browser's reported light or dark color-scheme preference automatically, including changes while the page is open. The extension has no theme switch or saved theme setting. This appearance choice does not affect URL rules, cleanup, or activity logs.

## Manual cleanup

The options page scans URLs whose **last visit** falls in the selected range, previews matched actions, and requires confirmation. Deleting a URL removes **all** its visits, including visits outside the selected range. Normalization also removes all original visits and records a new target visit at execution time. These changes cannot be undone.

A preview freezes matched URLs, planned actions, the rule snapshot, and time bounds; it does not freeze individual visit records. It is single use and stored in extension session storage during the browser session. A new preview replaces the old one. Changing the selected range or rules, cancelling or executing, browser restart, or extension reload requires a new preview. Above 10,000 URLs, the options page warns that scanning and cleanup may take longer but still allows confirmation. If the browser cannot complete a scan or the frozen plan exceeds temporary storage, preview fails before any history changes. A target URL that is itself scheduled for cleanup is skipped for safety. Execution reports deleted, normalized, skipped, failed, and partial results. “Partial” means a normalized target was added but deletion of the original failed. If the browser interrupts execution, some changes may already have happened; preview again to inspect the remaining history.

## Privacy

Read the [Privacy Policy](https://milo-ext.github.io/HistoryFilter/privacy.html).

Rule matching, history changes, and preview plans stay in the browser. Session plans temporarily contain full matched URLs and are cleared on browser restart or extension reload; they are not exposed to content scripts by default. The options preview shows up to 50 full URL examples for review. Persistent activity logs store only an action code, timestamp, and optional numeric totals—not URLs, paths, or freeform error messages. Existing logs are migrated to this format when the extension initializes or reads them. Rules remain in local storage. HistoryFilter does not transmit browsing history, rules, plans, or logs to the publisher.

## Supported regular expressions

Use domain, path and query-key conditions for common rules. Regexes are case-insensitive and must start with `^`. Supported syntax includes literals, `.`, character classes, `\d` / `\w` / `\s` and their complements, escaped punctuation, groups, grouped alternatives, and optional atoms/groups (`?`). At most one character atom may use `*`, `+`, or `{m,n}`; numeric bounds must be at most 100. Patterns are limited to 512 characters, 16 group levels, and eight alternative/optional choices. Repeated groups, lookarounds, backreferences, lazy quantifiers, top-level alternatives, and hexadecimal/Unicode escapes are not supported. These restrictions bound matching work without adding runtime dependencies.

For example, `^https?://example\.com/private` is supported; `(a+)+$` is not. The editor rejects unsupported patterns, and importing them reports them as invalid.

All settings tabs write through the background. Toggling changes only the enabled field; stale editor, deletion and replacement-import confirmations are rejected rather than overwriting newer changes. Appending imports uses the latest list.

## Help and support

Report bugs through [GitHub Issues](https://github.com/milo-ext/HistoryFilter/issues). Include browser and extension versions, reproduction steps, and synthetic example URLs. Do not post real browsing history, tokens, or full rule exports. For security issues, follow [SECURITY.md](SECURITY.md) and report privately.

Open **Help** in the options page for bilingual instructions, deletion limits, and troubleshooting. Browser history sync is separate from the extension: Chrome may propagate history deletions to other signed-in devices. HistoryFilter does not control bookmarks, open tabs, search-provider suggestions, or browser synchronization. See [Chrome's history documentation](https://support.google.com/chrome/answer/95589).

## Tests

Use Node 24 (`nvm use`, pinned in `.nvmrc`) and Python 3. No npm installation is needed for runtime or unit tests. GitHub Actions runs unit tests, packaging tests, both builds, and Chromium smoke/regression/template checks against the built ZIP on pushes and pull requests. Firefox and signed-installation release checks remain a separate acceptance step.

```sh
node --test tests/*.test.mjs
python3 -m unittest tests.test_build_package
```

The Node tests use simulated browser APIs and do not touch real history. Browser checks should use separate test profiles and synthetic URLs. The Firefox ZIP can be temporarily loaded for testing; a signed build must receive final installation and restart checks before distribution.

Browser scripts use the Python dependencies in `tests/requirements.txt`. Firefox checks accept `--geckodriver` and `--firefox` executable paths. When omitted, they use `GECKODRIVER` and `FIREFOX_BINARY`, then look for `geckodriver` and `firefox` on `PATH`. For example:

```sh
python3 tests/browser_templates.py --browser firefox --geckodriver /path/to/geckodriver --firefox /path/to/firefox
```

## Files

To regenerate the approved icons, run `npm ci` and `node tools/generate-icons.mjs`. The pinned development-only resvg renderer reads `assets/icons/icon16.svg` for 16/32px and `assets/icons/icon.svg` for 48/128px, and updates `docs/icon128.png`. These tooling dependencies are not included in extension packages.

- `src/background/`: history events, manual cleanup, matching, normalization
- `src/shared/`: rules, rule import/export, privacy-safe activity logs, cross-browser API adapter
- `src/options/`: bilingual settings and cleanup UI
- `release/build_package.py`: deterministic Chrome and Firefox ZIPs
- `tests/`: Node, Python packaging, and browser checks
