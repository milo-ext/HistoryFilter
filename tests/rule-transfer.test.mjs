import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES } from '../src/shared/types.js';
import { createTemplateRule } from '../src/shared/presets.js';
import { evaluateUrl } from '../src/background/rule-engine.js';
import {
  createRulesExport, mergeImportedRules, parseRulesImport, sanitizeImportedRule, MAX_IMPORT_RULES
} from '../src/shared/rule-transfer.js';

const editorRule = {
  id: 'rule_1', name: 'Docs search', enabled: false, matchType: 'domain', pattern: 'docs.example.com',
  pathPattern: '/search', pathMatchType: 'exact', queryKey: 'q', action: 'normalize',
  normalizeOptions: { keepOriginAndPath: true }
};

function roundTrip(rules) {
  return parseRulesImport(JSON.stringify(createRulesExport(rules, new Date('2026-09-28T00:00:00Z')))).rules;
}

test('export wraps rules with format metadata and round-trips every rule shape', () => {
  const rules = [
    ...DEFAULT_RULES, editorRule,
    createTemplateRule('utm-cleanup'), createTemplateRule('tco-block'),
    createTemplateRule('site-domain-block', { domain: 'news.example' }), createTemplateRule('local-dev-block'),
    { id: 'r2', name: 'Fixed', matchType: 'regex', pattern: '^https://a\\.example/', action: 'normalize',
      normalizeOptions: { customFixedUrl: 'https://a.example/home' }, enabled: true },
    { id: 'r3', name: 'Keep', matchType: 'query', pattern: 'id, utm_*', action: 'normalize',
      normalizeOptions: { keepSelectedQueryKeys: ['id'] }, enabled: true }
  ];
  const exported = createRulesExport(rules, new Date('2026-09-28T00:00:00Z'));
  assert.equal(exported.format, 'historyfilter-rules');
  assert.equal(exported.version, 1);
  assert.equal(exported.exportedAt, '2026-09-28T00:00:00.000Z');
  const imported = roundTrip(rules);
  assert.equal(imported.length, rules.length);
  assert.deepEqual(imported[0], DEFAULT_RULES[0]);
  assert.deepEqual(imported[1], editorRule);
  const samples = ['https://translate.google.com/?text=hi', 'https://docs.example.com/search?q=1&x=2',
    'https://example.com/?utm_source=x&id=1', 'https://t.co/abc', 'https://news.example/a',
    'http://localhost:3000/', 'https://a.example/x', 'https://b.example/?id=1&utm_medium=y'];
  for (const url of samples) assert.deepEqual(evaluateUrl(url, imported), evaluateUrl(url, rules), url);
});

test('import accepts a bare rule array and reports skipped invalid entries', () => {
  const result = parseRulesImport(JSON.stringify([
    editorRule,
    { name: 'Bad regex', matchType: 'regex', pattern: '(', action: 'block' },
    { name: 'Bad action', matchType: 'domain', pattern: 'a.example', action: 'redirect' },
    'not a rule'
  ]));
  assert.equal(result.rules.length, 1);
  assert.equal(result.invalidCount, 3);
});

test('import rejects malformed, foreign, newer, oversized, and empty files', () => {
  const code = text => { try { parseRulesImport(text); } catch (error) { return error.code; } return null; };
  assert.equal(code('{nope'), 'INVALID_JSON');
  assert.equal(code('{"rules":[]}'), 'INVALID_FORMAT');
  assert.equal(code('null'), 'INVALID_FORMAT');
  assert.equal(code(JSON.stringify({ format: 'historyfilter-rules', version: 2, rules: [editorRule] })), 'UNSUPPORTED_VERSION');
  assert.equal(code(JSON.stringify(Array(MAX_IMPORT_RULES + 1).fill(editorRule))), 'TOO_MANY');
  assert.equal(code(JSON.stringify({ format: 'historyfilter-rules', version: 1, rules: [{ name: 'x' }] })), 'NO_VALID_RULES');
});

test('sanitizer applies editor validation and drops unknown fields', () => {
  assert.equal(sanitizeImportedRule({ ...editorRule, pattern: 'bad host!' }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, pathPattern: 'search' }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, name: ' ' }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, enabled: 'yes' }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, normalizeOptions: { customFixedUrl: 'javascript:alert(1)' } }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, normalizeOptions: { keepOriginOnly: true, stripAllQueryParams: true } }), null);
  assert.equal(sanitizeImportedRule({ ...editorRule, matchType: 'query', pattern: '*' }), null);
  const clean = sanitizeImportedRule({ ...editorRule, pattern: 'https://Docs.Example.com/path', id: '<script>',
    templateId: 'made-up', extra: 'x', action: 'block' });
  assert.equal(clean.pattern, 'docs.example.com');
  assert.equal('id' in clean, false);
  assert.equal('templateId' in clean, false);
  assert.equal('extra' in clean, false);
  assert.equal('normalizeOptions' in clean, false);
});

test('append skips identical definitions and never reuses a taken id', () => {
  const current = [DEFAULT_RULES[0], { ...editorRule, pathPattern: '/search', queryKey: 'q' }];
  const imported = [
    { ...DEFAULT_RULES[0], name: 'Renamed copy', enabled: false },
    { ...editorRule, pattern: 'other.example' },
    { ...editorRule, pattern: 'other.example', id: 'dupe' }
  ].map(sanitizeImportedRule);
  const merged = mergeImportedRules(current, imported, 'append');
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 2);
  assert.equal(merged.rules.length, 3);
  assert.deepEqual(merged.rules.slice(0, 2), current);
  assert.notEqual(merged.rules[2].id, 'rule_1');
  assert.match(merged.rules[2].id, /^rule_/);
});

test('replace uses the file order and keeps unique ids', () => {
  const imported = [{ ...editorRule, id: 'same' }, { ...editorRule, id: 'same', pattern: 'b.example' }];
  const merged = mergeImportedRules([DEFAULT_RULES[0]], imported, 'replace');
  assert.equal(merged.added, 2);
  assert.deepEqual(merged.rules.map(rule => rule.pattern), ['docs.example.com', 'b.example']);
  assert.equal(merged.rules[0].id, 'same');
  assert.notEqual(merged.rules[1].id, 'same');
});

test('new imports require an explicit normalization mode', () => {
  for (const normalizeOptions of [undefined, {}, { stripAllQueryParams: false }, { unknown: true }]) {
    const rule = { ...editorRule, normalizeOptions };
    assert.equal(sanitizeImportedRule(rule), null);
    assert.throws(() => parseRulesImport(JSON.stringify([rule])), { code: 'NO_VALID_RULES' });
    const mixed = parseRulesImport(JSON.stringify([editorRule, rule]));
    assert.equal(mixed.rules.length, 1);
    assert.equal(mixed.invalidCount, 1);
  }
});

test('exports retain legacy no-mode rules without inventing a destructive mode', () => {
  for (const normalizeOptions of [undefined, {}]) {
    const rule = { ...editorRule, normalizeOptions };
    const exported = createRulesExport([rule, editorRule]);
    assert.equal(exported.rules.length, 2);
    assert.deepEqual(exported.rules[0].normalizeOptions, {});
    const url = 'https://docs.example.com/search?q=1&keep=2';
    assert.equal(evaluateUrl(url, [{ ...exported.rules[0], enabled: true }]).normalizedUrl, url);
  }
});

test('export fails explicitly instead of silently dropping an unexportable rule', () => {
  assert.throws(() => createRulesExport([editorRule, { ...editorRule, action: 'invalid' }]),
    { code: 'INVALID_EXPORT_RULE' });
});
