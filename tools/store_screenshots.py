"""Render 1280x800 store screenshots in English and Simplified Chinese.

Captures the real options UI from the repository extension in a disposable
Chromium profile seeded with sample rules and history, then composes each
capture with a headline into release/store_screenshots/<locale>/.
English captures without added titles are also saved under amo/, captured
directly from a real 1280x800 viewport without padding or scaling.

    python3 tools/store_screenshots.py
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "release" / "store_screenshots"
ICON = (ROOT / "assets" / "icons" / "icon128.png").as_uri()
# All screens use the same full-window width, including open dialogs.
# The lower edge may move up to a rule/sample boundary, never through a row.
CAPTURE_WIDTH, CAPTURE_HEIGHT = 1280, 720

RULE_NAMES = {
    "en": ["Translation Query Cleanup", "Remove UTM Parameters", "Delete Redirect Links",
           "Delete Local Development Pages", "Documentation Search"],
    "zh-CN": ["翻译查询清理", "移除 UTM 参数", "删除跳转链接", "删除本地开发页面", "文档搜索页"],
}

HISTORY = [
    "https://translate.example/?sl=en&tl=zh-CN&text=serendipity&op=translate",
    "https://translate.example/?sl=en&tl=zh-CN&text=ephemeral&op=translate",
    "https://translate.example/?sl=auto&tl=en&text=%E4%BD%A0%E5%A5%BD&op=translate",
    "https://news.example.com/story?id=42&utm_source=newsletter&utm_medium=email",
    "https://shop.example.com/item/7?utm_campaign=autumn&color=green",
    "https://links.example/demo-one",
    "https://links.example/demo-two",
    "http://localhost:5173/dashboard?debug=1",
    "http://127.0.0.1:8000/admin/",
    "https://docs.example/search?q=example",
]

COPY = {
    "en": {
        "lang": "en",
        "font": '"Avenir Next", -apple-system, sans-serif',
        "shots": [
            ("01-address-bar", "Keep address-bar\nsuggestions clean",
             "Right after each visit, HistoryFilter deletes or rewrites matching history entries using your rules."),
            ("02-rules", "Your rules,\nin your order",
             "Match a domain, query keys, or a regular expression. The first enabled rule that matches wins."),
            ("03-templates", "Start from\na template",
             "Google Translate, UTM parameters, t.co links, localhost, or any site you choose. Edit them later."),
            ("04-cleanup", "Clean up old history\nwith a preview",
             "Review the totals and up to 50 sample URLs. Manual cleanup runs only after you confirm."),
            ("05-import", "Take your rules anywhere",
             "Export rules to a file and import them on another computer. Everything runs in your browser, with no servers or analytics."),
        ],
        "hero": {
            "query": "translate",
            "title": "Translation search",
            "removed": "Removed",
            "kept": "Kept",
            "utm_label": "Tracking parameters removed",
        },
    },
    "zh-CN": {
        "lang": "zh-CN",
        "font": '"PingFang SC", "Avenir Next", sans-serif',
        "shots": [
            ("01-address-bar", "让地址栏建议\n保持干净",
             "每次访问之后，HistoryFilter 按你的规则删除或改写匹配的浏览记录。"),
            ("02-rules", "规则由你定，顺序由你排",
             "按域名、参数名或正则表达式匹配，从上到下第一条命中的已启用规则生效。"),
            ("03-templates", "从模板快速开始",
             "Google 翻译、UTM 参数、t.co 跳转、本地开发地址，或你指定的网站。添加后仍可编辑。"),
            ("04-cleanup", "清理旧历史，先预览再执行",
             "先核对影响总数和最多 50 条 URL 样本，确认之后才执行手动清理。"),
            ("05-import", "规则随身带走",
             "规则可导出为文件，在另一台电脑上导入。所有处理都在浏览器本地完成，没有服务器，也没有统计。"),
        ],
        "hero": {
            "query": "translate",
            "title": "翻译查询",
            "removed": "已删除",
            "kept": "保留",
            "utm_label": "跟踪参数已移除",
        },
    },
}

STYLE = """
*{box-sizing:border-box;margin:0}
html,body{width:1280px;height:800px;overflow:hidden}
body{font-family:var(--font);background:#E8F0EE;color:#10201E;position:relative;-webkit-font-smoothing:antialiased}
.brand{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:10px;font-weight:600;font-size:18px;letter-spacing:-.01em}
.brand img{width:30px;height:30px}
.copy{position:absolute;left:72px;top:190px;width:392px}
h1{font-size:44px;line-height:1.14;font-weight:600;letter-spacing:-.025em}
:lang(zh-CN) h1{font-size:42px;line-height:1.3;letter-spacing:0}
.copy p{margin-top:22px;font-size:19px;line-height:1.6;color:#3F5552;text-wrap:pretty}
:lang(zh-CN) .copy p{line-height:1.75}
.window{position:absolute;left:64px;top:136px;width:1152px;border-radius:12px;overflow:hidden;
  background:#fff;box-shadow:0 1px 0 #cfdcd9,0 30px 70px -20px rgba(11,79,74,.35);border:1px solid #cfdcd9}
.window img{display:block;width:100%;height:auto}
.overview .brand{left:64px;top:36px}
.overview .copy{left:320px;top:26px;width:896px}
.overview h1{font-size:30px;line-height:1.15}
.overview .copy p{margin-top:8px;font-size:15px;line-height:1.5}
.overview:lang(zh-CN) h1{font-size:30px;line-height:1.2}
.overview:lang(zh-CN) .copy p{line-height:1.5}
.hero{background:#0B4F4A;color:#fff}
.hero .copy p{color:#C4E0DA}
.omni{position:absolute;left:520px;top:120px;width:700px;background:#fff;border-radius:16px;color:#1f2a29;
  box-shadow:0 30px 80px -24px rgba(0,0,0,.55);overflow:hidden}
.omni-input{display:flex;align-items:center;gap:14px;padding:20px 24px;border-bottom:1px solid #e4ebe9;font-size:20px}
.omni-input svg{width:20px;height:20px;stroke:#6b7c79;fill:none;stroke-width:2}
.caret{display:inline-block;width:2px;height:22px;background:#0F766E;margin-left:2px;vertical-align:-4px}
.row{display:grid;grid-template-columns:28px 1fr auto;gap:14px;align-items:center;padding:13px 24px}
.dot{width:24px;height:24px;border-radius:6px;background:#dfe9e7;display:grid;place-items:center;font:700 12px/1 var(--font);color:#4b6b66}
.row .t{font-size:15px;font-weight:600}
.url{font-family:"SF Mono",Menlo,monospace;font-size:13px;color:#667875;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.gone .t{color:#9aa8a5}
.row.gone .url{text-decoration:line-through;text-decoration-color:#B4483F;text-decoration-thickness:1.5px;color:#9aa8a5}
.row.gone .dot{opacity:.45}
.tag{font-size:12px;font-weight:600;border-radius:6px;padding:4px 9px;white-space:nowrap}
.gone .tag{color:#9C3E36;background:#F8E9E7}
.keep{background:#E6F4F1}
.keep .tag{color:#fff;background:#0F766E}
.keep .url{color:#0B5F59}
.utm{position:absolute;left:520px;top:552px;width:700px;background:#fff;border-radius:14px;padding:18px 24px;color:#1f2a29;
  box-shadow:0 24px 60px -24px rgba(0,0,0,.5)}
.utm .label{font-size:13px;font-weight:600;color:#0B5F59;margin-bottom:8px}
.utm .url{font-size:14px;color:#1f2a29;white-space:nowrap;line-height:1.6}
.utm s{color:#B4483F;text-decoration-thickness:2px}
"""


def page_html(copy: dict, title: str, body_line: str, inner: str, hero: bool = False) -> str:
    return f"""<!doctype html><html lang="{copy['lang']}"><head><meta charset="utf-8">
<style>:root{{--font:{copy['font']}}}{STYLE}</style></head>
<body class="{'hero' if hero else 'overview'}">
<div class="brand"><img src="{ICON}" alt="">HistoryFilter</div>
<div class="copy"><h1>{html.escape(title).replace(chr(10), '<br>' if hero else ' ')}</h1><p>{html.escape(body_line)}</p></div>
{inner}</body></html>"""


def hero_inner(copy: dict) -> str:
    h = copy["hero"]
    removed = [
        "translate.example/?sl=en&amp;tl=zh-CN&amp;text=serendipity",
        "translate.example/?sl=en&amp;tl=zh-CN&amp;text=ephemeral",
        "translate.example/?sl=auto&amp;tl=en&amp;text=%E4%BD%A0%E5%A5%BD",
        "translate.example/?sl=en&amp;tl=ja&amp;text=deadline",
    ]
    rows = "".join(
        f'<div class="row gone"><span class="dot">G</span><div><div class="t">{html.escape(h["title"])}</div>'
        f'<div class="url">{url}</div></div><span class="tag">{html.escape(h["removed"])}</span></div>'
        for url in removed)
    rows += (f'<div class="row keep"><span class="dot">G</span><div><div class="t">{html.escape(h["title"])}</div>'
             f'<div class="url">translate.example/</div></div><span class="tag">{html.escape(h["kept"])}</span></div>')
    search = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>'
    return (f'<div class="omni"><div class="omni-input">{search}<span>{h["query"]}<span class="caret"></span></span></div>{rows}</div>'
            f'<div class="utm"><div class="label">{html.escape(h["utm_label"])}</div>'
            '<div class="url">news.example.com/story?id=42<s>&amp;utm_source=newsletter&amp;utm_medium=email</s></div></div>')


def window_inner(capture: Path) -> str:
    return f'<div class="window"><img src="{capture.as_uri()}" alt=""></div>'


def seeded_rules(names: list[str]) -> list[dict]:
    return [
        {"id": "rule_translate", "name": names[0], "matchType": "domain", "pattern": "translate.example",
         "queryKey": "text", "action": "normalize", "enabled": True, "normalizeOptions": {"keepOriginOnly": True}},
        {"id": "rule_utm", "templateId": "utm-cleanup", "name": names[1], "matchType": "query", "pattern": "utm_*",
         "action": "normalize", "enabled": True, "normalizeOptions": {"stripSelectedQueryKeys": ["utm_*"]}},
        {"id": "rule_redirect", "name": names[2], "matchType": "domain", "pattern": "links.example",
         "action": "block", "enabled": True},
        {"id": "rule_local", "templateId": "local-dev-block", "name": names[3], "matchType": "regex",
         "pattern": "^https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?(?:[/?#]|$)", "action": "block", "enabled": True},
        {"id": "rule_docs", "name": names[4], "matchType": "domain", "pattern": "docs.example",
         "pathPattern": "/search", "pathMatchType": "exact", "action": "block", "enabled": False},
    ]


def align_bottom_to_rows(page, selector: str) -> None:
    """Shorten a viewport only when its bottom would slice through a row."""
    height = page.viewport_size["height"]
    rows = page.locator(selector).evaluate_all(
        "nodes => nodes.map(node => {const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom};})")
    if any(row["top"] < height < row["bottom"] for row in rows):
        boundaries = [int(row["bottom"]) for row in rows if 400 <= row["bottom"] <= height]
        if not boundaries:
            raise AssertionError(f"No safe row boundary for {selector}")
        page.set_viewport_size({"width": CAPTURE_WIDTH, "height": max(boundaries)})


PAGE_ROWS = """selector => ({
    scrollTop: scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    rows: [...document.querySelectorAll(selector)].map(node => {
        const r=node.getBoundingClientRect();return {top:r.top + scrollY,bottom:r.bottom + scrollY};
    })
})"""


def page_bottom_is_safe(rows: list[dict], offset: float, height: int) -> bool:
    bottom = offset + height
    return any(row["bottom"] > offset and row["top"] < bottom for row in rows) and not any(
        row["top"] + 1 < bottom < row["bottom"] - 1 for row in rows
    )


def scroll_bottom_to_rows(page, selector: str) -> None:
    """Keep the real AMO viewport fixed; move the document to a row boundary."""
    height = page.viewport_size["height"]
    state = page.evaluate(PAGE_ROWS, selector)
    candidates = [state["scrollTop"], state["maxScroll"]]
    for index, row in enumerate(state["rows"]):
        next_top = state["rows"][index + 1]["top"] if index + 1 < len(state["rows"]) else row["bottom"]
        offset = round((row["bottom"] + next_top) / 2 - height)
        if 0 <= offset <= state["maxScroll"]:
            candidates.append(offset)
    for offset in sorted(set(candidates), key=lambda value: abs(value - state["scrollTop"])):
        if not page_bottom_is_safe(state["rows"], offset, height):
            continue
        page.evaluate("offset => window.scrollTo(0, offset)", offset)
        actual = page.evaluate(PAGE_ROWS, selector)
        if page_bottom_is_safe(actual["rows"], actual["scrollTop"], height):
            return
    raise AssertionError(f"Cannot align the fixed AMO viewport with {selector}: {state}")


TEMPLATE_GEOMETRY = """modal => {
    const body = modal.querySelector('.modal-body');
    const header = modal.querySelector('.modal-header').getBoundingClientRect();
    const footer = modal.querySelector('.modal-footer').getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    const box = node => {const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom};};
    const note = body.querySelector('.template-note');
    const lines = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const r of range.getClientRects()) {
            if (r.width && r.height) lines.push({top:r.top,bottom:r.bottom});
        }
    }
    return {
        top: Math.max(bounds.top, header.bottom), bottom: Math.min(bounds.bottom, footer.top),
        scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight,
        cards: [...body.querySelectorAll('.template-item')].map(box),
        buttons: [...body.querySelectorAll('.template-item button')].map(box),
        note: note ? box(note) : null, lines
    };
}"""


def whole_or_outside(box: dict, top: float, bottom: float, tolerance: float = 0) -> bool:
    return box["bottom"] <= top + tolerance or box["top"] >= bottom - tolerance or (
        box["top"] >= top - tolerance and box["bottom"] <= bottom + tolerance
    )


def template_controls_are_safe(frame: dict) -> bool:
    top, bottom = frame["top"], frame["bottom"]
    visible = [button for button in frame["buttons"] if button["bottom"] > top and button["top"] < bottom]
    return bool(visible) and all(whole_or_outside(button, top, bottom, tolerance=1) for button in visible) and not any(
        card["top"] + 1 < bottom < card["bottom"] - 1 for card in frame["cards"]
    )


def template_frame_is_safe(frame: dict) -> bool:
    top, bottom = frame["top"], frame["bottom"]
    return template_controls_are_safe(frame) and (
        frame["note"] is None or whole_or_outside(frame["note"], top, bottom)
    ) and all(whole_or_outside(line, top, bottom) for line in frame["lines"])


def shifted_template_frame(initial: dict, offset: float) -> dict:
    """Scroll-only prediction: nothing in the dialog is hidden or restyled."""
    delta = offset - initial["scrollTop"]
    shift = lambda box: {"top": box["top"] - delta, "bottom": box["bottom"] - delta}
    return {**initial, "scrollTop": offset,
            "cards": [shift(box) for box in initial["cards"]],
            "buttons": [shift(box) for box in initial["buttons"]],
            "note": shift(initial["note"]) if initial["note"] else None,
            "lines": [shift(box) for box in initial["lines"]]}


def align_template_scroll(page, label: str) -> bool:
    modal = page.locator("#template-modal")
    initial = modal.evaluate(TEMPLATE_GEOMETRY)
    # Preserve the previous button-safe selection as the explicitly allowed
    # fallback if this viewport cannot also show complete text and note blocks.
    fallback_candidates = [initial["scrollTop"], initial["maxScroll"]]
    for index, card in enumerate(initial["cards"]):
        next_top = initial["cards"][index + 1]["top"] if index + 1 < len(initial["cards"]) else card["bottom"]
        offset = round(initial["scrollTop"] + (card["bottom"] + next_top) / 2 - initial["bottom"])
        if 0 <= offset <= initial["maxScroll"]:
            fallback_candidates.append(offset)
    ordered = lambda values: sorted(set(values), key=lambda value: abs(value - initial["scrollTop"]))
    fallback = next((offset for offset in ordered(fallback_candidates)
                     if template_controls_are_safe(shifted_template_frame(initial, offset))), None)
    # Search every available pixel in memory, then verify promising positions
    # against the actual DOM. This finds narrow gaps between wrapped text lines.
    candidates = ordered([*range(int(initial["maxScroll"]) + 1), *fallback_candidates])
    body = page.locator("#template-modal .modal-body")
    for offset in candidates:
        if not template_frame_is_safe(shifted_template_frame(initial, offset)):
            continue
        body.evaluate("(body, offset) => {body.scrollTop = offset;}", offset)
        frame = modal.evaluate(TEMPLATE_GEOMETRY)
        if template_frame_is_safe(frame):
            print(f"{label}/03-templates: complete note/text/buttons at scrollTop={frame['scrollTop']}")
            return True
    if fallback is None:
        raise AssertionError(f"Cannot frame templates without clipped buttons: {initial}")
    body.evaluate("(body, offset) => {body.scrollTop = offset;}", fallback)
    assert template_controls_are_safe(modal.evaluate(TEMPLATE_GEOMETRY))
    print(f"WARNING {label}/03-templates: no complete text/note framing; retaining previous button-safe scrollTop={fallback}")
    return False


def capture_locale(playwright, locale: str, work: Path, executable: str, *, amo: bool = False) -> dict[str, Path]:
    label = "amo" if amo else locale
    viewport_height = 800 if amo else CAPTURE_HEIGHT
    context = playwright.chromium.launch_persistent_context(
        str(work / f"profile-{label}"), executable_path=executable, headless=True,
        viewport={"width": CAPTURE_WIDTH, "height": viewport_height}, device_scale_factor=1,
        color_scheme="light", reduced_motion="reduce",
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"])
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        origin = worker.url.split("/src/", 1)[0]
        page = context.new_page()
        page.goto(f"{origin}/src/options/options.html")
        page.wait_for_selector(".rule-card")
        rules = seeded_rules(RULE_NAMES[locale])
        # Only a disposable profile and generated fixture URLs are used.
        page.evaluate("""async ({urls, locale}) => {
            await chrome.storage.local.set({history_rules: [], options_locale: locale});
            for (const url of urls) await chrome.history.addUrl({url});
            await new Promise(resolve => setTimeout(resolve, 1500));
        }""", {"urls": HISTORY, "locale": locale})
        page.evaluate("rules => chrome.storage.local.set({history_rules: rules})", rules)
        page.reload()
        page.wait_for_function("count => document.querySelectorAll('.rule-card').length === count", arg=len(rules))
        page.wait_for_function("locale => document.documentElement.lang === locale", arg=locale)
        page.evaluate("document.fonts.ready")
        shots: dict[str, Path] = {}
        complete_template_text = True

        def grab(name: str) -> None:
            # Full-window capture: no sidebar crop, no dialog-specific widening,
            # no negative image offset hiding the last half of a rule.
            metrics = page.evaluate("""() => ({
                width: innerWidth, height: innerHeight, docWidth: document.documentElement.scrollWidth,
                buttons: [...document.querySelectorAll('.heading-actions button')]
                    .filter(node => node.getClientRects().length)
                    .map(node => {const r=node.getBoundingClientRect();return {left:r.left,right:r.right};})
            })""")
            assert metrics["width"] == CAPTURE_WIDTH and metrics["docWidth"] <= CAPTURE_WIDTH, metrics
            assert all(0 <= button["left"] < button["right"] <= CAPTURE_WIDTH for button in metrics["buttons"]), metrics
            if amo:
                assert metrics["height"] == 800, metrics
                if name in ("02-rules", "04-cleanup"):
                    selector = "#rules-list .rule-card" if name == "02-rules" else ".sample-row"
                    state = page.evaluate(PAGE_ROWS, selector)
                    assert page_bottom_is_safe(state["rows"], state["scrollTop"], 800), state
            if name == "03-templates":
                frame = page.locator("#template-modal").evaluate(TEMPLATE_GEOMETRY)
                assert template_controls_are_safe(frame), f"Template clips a card or button: {frame}"
                try:
                    assert template_frame_is_safe(frame), f"Template clips text or its note: {frame}"
                except AssertionError:
                    if complete_template_text:
                        raise
                    print(f"WARNING {label}/03-templates: text framing assertion failed; using explicitly allowed fallback")
            path = work / f"{label}-{name}.png"
            page.screenshot(path=str(path), omit_background=False)
            shots[name] = path
            print(f"Captured {label}/{name}: {metrics['width']}x{metrics['height']}, full window")

        if amo:
            scroll_bottom_to_rows(page, "#rules-list .rule-card")
        else:
            align_bottom_to_rows(page, "#rules-list .rule-card")
        rules_viewport = dict(page.viewport_size)
        # The first real UI screenshot must show the local-processing statement.
        footer = page.locator('.side-note').bounding_box()
        assert footer and footer['y'] >= 0 and footer['y'] + footer['height'] <= rules_viewport['height'] + 1
        grab("02-rules")
        page.click("#open-templates-btn")
        page.wait_for_selector("#template-modal:not([hidden])")
        complete_template_text = align_template_scroll(page, label)
        grab("03-templates")
        page.keyboard.press("Escape")

        page.set_viewport_size({"width": CAPTURE_WIDTH, "height": viewport_height})
        page.click('.nav button[data-page="cleanup"]')
        page.click("#cleanup-btn")
        page.wait_for_selector("#preview-container:not([hidden])")
        page.eval_on_selector("#preview-container", "node => window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 24)")
        if amo:
            scroll_bottom_to_rows(page, ".sample-row")
        else:
            align_bottom_to_rows(page, ".sample-row")
        grab("04-cleanup")
        page.click("#cancel-cleanup-btn")

        page.click('.nav button[data-page="rules"]')
        page.set_viewport_size(rules_viewport)
        export_file = work / "historyfilter-rules.json"
        exported = page.evaluate("async () => (await chrome.storage.local.get('history_rules')).history_rules")
        export_file.write_text(json.dumps({"format": "historyfilter-rules", "version": 1, "rules": exported + [
            {"name": RULE_NAMES[locale][2], "matchType": "domain", "pattern": "links.example", "action": "block"},
            {"name": "Search result pages" if locale == "en" else "搜索结果页", "matchType": "domain",
             "pattern": "search.example", "pathPattern": "/search", "action": "block"},
        ]}), encoding="utf-8")
        page.set_input_files("#import-file", str(export_file))
        page.wait_for_selector("#import-modal:not([hidden])")
        grab("05-import")
        page.keyboard.press("Escape")
        return shots
    finally:
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUT, help="Output root for en/, zh-CN/ and amo/")
    parser.add_argument("--chromium", default=os.environ.get("CHROMIUM_BINARY"),
                        help="Chromium executable; defaults to CHROMIUM_BINARY or Playwright Chromium")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="historyfilter-store-") as temp, sync_playwright() as playwright:
        work = Path(temp)
        executable = args.chromium or playwright.chromium.executable_path
        browser = playwright.chromium.launch(executable_path=executable)
        generated: list[tuple[Path, Path]] = []
        try:
            for locale, copy in COPY.items():
                captures = capture_locale(playwright, locale, work, executable)
                if locale == "en":
                    amo_captures = capture_locale(playwright, locale, work, executable, amo=True)
                    generated.extend((capture, Path("amo") / f"{name}.png") for name, capture in amo_captures.items())
                page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
                try:
                    for name, title, body_line in copy["shots"]:
                        if name == "01-address-bar":
                            markup = page_html(copy, title, body_line, hero_inner(copy), hero=True)
                        else:
                            markup = page_html(copy, title, body_line, window_inner(captures[name]))
                        source = work / f"{locale}-{name}.html"
                        source.write_text(markup, encoding="utf-8")
                        page.goto(source.as_uri())
                        page.wait_for_load_state("load")
                        page.evaluate("document.fonts.ready")
                        if name != "01-address-bar":
                            bounds = page.locator('.window').bounding_box()
                            assert bounds and bounds['y'] + bounds['height'] <= 800, bounds
                        output = work / f"composed-{locale}-{name}.png"
                        page.screenshot(path=str(output), omit_background=False)
                        generated.append((output, Path(locale) / f"{name}.png"))
                finally:
                    page.close()
        finally:
            browser.close()
        # A failed capture must not leave a mixture of old and new store images.
        for source, relative in generated:
            target = args.output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            print(f"Wrote {target}")


if __name__ == "__main__":
    main()
