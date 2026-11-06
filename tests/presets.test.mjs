import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES } from '../src/shared/types.js';
import { evaluateUrl } from '../src/background/rule-engine.js';
import { normalizeUrl } from '../src/background/normalizer.js';
import { parseQuerySelectors } from '../src/shared/query-selectors.js';
import { BUILTIN_TEMPLATES, createTemplateRule } from '../src/shared/presets.js';
import { addTemplateRule, getRules, mutateRules } from '../src/shared/storage.js';
import { createRulesExport, parseRulesImport } from '../src/shared/rule-transfer.js';

function setupStorage(initialRules) {
  const state = initialRules === undefined ? {} : { history_rules: structuredClone(initialRules) };
  globalThis.chrome = {
    storage: { local: {
      async get(key) { await new Promise(resolve => setImmediate(resolve)); return { [key]: structuredClone(state[key]) }; },
      async set(values) { await new Promise(resolve => setImmediate(resolve)); Object.assign(state, structuredClone(values)); }
    } }
  };
  return state;
}

test('catalog has five opt-in templates and preserves the single existing default', async () => {
  const state = setupStorage();
  assert.deepEqual(BUILTIN_TEMPLATES.map(item => item.id), [
    'google-translate', 'utm-cleanup', 'tco-block', 'site-domain-block', 'local-dev-block'
  ]);
  assert.deepEqual(await getRules(), DEFAULT_RULES);
  assert.equal(state.history_rules.length, 1);
  assert.equal(state.history_rules[0].enabled, false);
});

test('UTM template matches only real query keys and removes only UTM bytes', () => {
  const utm = createTemplateRule('utm-cleanup');
  assert.equal(utm.enabled, true);
  assert.equal(utm.matchType, 'query');
  assert.equal(utm.pattern, 'utm_*');
  assert.deepEqual(utm.normalizeOptions.stripSelectedQueryKeys, ['utm_*']);
  const source = 'https://example.com/watch?utm_source=x&q=one+two&id=1&v=abc&t=30&list=L&q=two%20words&utm_medium=y#frag';
  const evaluation = evaluateUrl(source, [utm]);
  assert.equal(evaluation.action, 'normalize');
  assert.equal(evaluation.normalizedUrl,
    'https://example.com/watch?q=one+two&id=1&v=abc&t=30&list=L&q=two%20words#frag');
  assert.equal(normalizeUrl('https://example.com/path?utm_source=x#part', utm.normalizeOptions),
    'https://example.com/path#part');
  assert.equal(normalizeUrl('https://example.com/path?%75tm_source=x&q=a+%20b&UTM_source=keep#part', utm.normalizeOptions),
    'https://example.com/path?q=a+%20b&UTM_source=keep#part');
});

test('no UTM or hash-only UTM never preempts a later block rule', () => {
  const utm = createTemplateRule('utm-cleanup');
  const block = createTemplateRule('tco-block');
  assert.equal(evaluateUrl('https://t.co/abc#utm_source=x', [utm, block]).action, 'block');
  assert.equal(evaluateUrl('https://t.co/abc?ref=x', [utm, block]).action, 'block');
  assert.equal(evaluateUrl('https://example.com/?UTM_source=x', [utm]), null);
  assert.equal(evaluateUrl('https://example.com/#utm_source=x', [utm]), null);
});

test('query selectors reject broad wildcard and malformed patterns', () => {
  for (const value of ['*', 'utm_*,,gclid', 'utm_*foo', '', 'utm_*, *']) {
    assert.equal(parseQuerySelectors(value), null);
  }
  assert.deepEqual(parseQuerySelectors('utm_*, gclid, utm_*'), ['utm_*', 'gclid']);
});

test('local development regex is anchored to localhost and 127.0.0.1', () => {
  const local = createTemplateRule('local-dev-block');
  assert.equal(evaluateUrl('http://localhost:3000/page', [local]).action, 'block');
  assert.equal(evaluateUrl('https://127.0.0.1:8443/', [local]).action, 'block');
  assert.equal(evaluateUrl('https://127.0.0.1.evil.example/', [local]), null);
  assert.equal(evaluateUrl('https://example.com/?next=http://localhost:3000/', [local]), null);
});

test('legacy customized Google preset survives migration without reset', async () => {
  const legacy = { id: 'preset-google-translate', name: 'My edited rule', enabled: false,
    matchType: 'domain', pattern: 'translate.google.com', pathPattern: '/custom',
    pathMatchType: 'exact', action: 'normalize', normalizeOptions: { keepOriginAndPath: true } };
  setupStorage([legacy]);
  assert.deepEqual(await getRules(), [legacy]);
});

test('a customized old long-URL preset ID is not removed by migration', async () => {
  const edited = { id: 'preset-long-urls', name: 'My narrow URL rule', enabled: false,
    matchType: 'regex', pattern: '^https://example\\.com/private', action: 'block' };
  setupStorage([edited]);
  assert.deepEqual(await getRules(), [edited]);
});

test('concurrent fixed template adds serialize and duplicates return existing rule', async () => {
  const state = setupStorage(DEFAULT_RULES);
  const [first, second, third] = await Promise.all([
    addTemplateRule('utm-cleanup'), addTemplateRule('tco-block'), addTemplateRule('utm-cleanup')
  ]);
  assert.equal(first.added, true);
  assert.equal(second.added, true);
  assert.equal(third.added, false);
  assert.equal(third.rule.id, first.rule.id);
  assert.deepEqual(state.history_rules.map(rule => rule.templateId || rule.id),
    ['preset-google-translate', 'utm-cleanup', 'tco-block']);
  assert.equal(state.history_rules[1].enabled, true);
  assert.ok(state.history_rules[1].id.startsWith('rule_'));
  assert.equal((await addTemplateRule('google-translate')).added, false);
});

test('site template requires a domain, dedups same domain, and reuses across domains', async () => {
  const state = setupStorage([]);
  await assert.rejects(addTemplateRule('site-domain-block', { domain: 'example.com/private' }), TypeError);
  const one = await addTemplateRule('site-domain-block', { domain: 'Example.COM' });
  const duplicate = await addTemplateRule('site-domain-block', { domain: 'example.com' });
  const two = await addTemplateRule('site-domain-block', { domain: 'another.example' });
  assert.equal(one.added, true);
  assert.equal(duplicate.added, false);
  assert.equal(two.added, true);
  assert.equal(state.history_rules.length, 2);
  assert.deepEqual(state.history_rules.map(rule => rule.pattern), ['example.com', 'another.example']);
  assert.equal(state.history_rules[0].action, 'block');
  assert.equal(state.history_rules[0].enabled, true);
});

test('long-domain templates save, toggle and round-trip without losing the domain', async () => {
  const domain = `${'a'.repeat(45)}.${'b'.repeat(45)}.com`;
  setupStorage([]);
  const { rule } = await addTemplateRule('site-domain-block', { domain });
  assert.ok(rule.name.length <= 100);
  await mutateRules({ operation: 'toggle', id: rule.id, enabled: false });
  await mutateRules({ operation: 'toggle', id: rule.id, enabled: true });
  const saved = await getRules();
  const imported = parseRulesImport(JSON.stringify(createRulesExport(saved))).rules;
  assert.deepEqual(imported, saved);
  assert.equal(imported[0].pattern, domain);
  assert.equal(evaluateUrl(`https://${domain}/private`, imported).action, 'block');
});

test('existing overlong names migrate without changing matching or losing exports', async () => {
  const domain = `${'a'.repeat(45)}.${'b'.repeat(45)}.com`;
  const legacy = { id: 'long', name: `Block ${domain} History`, enabled: true,
    matchType: 'domain', pattern: domain, action: 'block', templateId: 'site-domain-block' };
  setupStorage([legacy]);
  const saved = await getRules();
  assert.ok(saved[0].name.length <= 100);
  assert.deepEqual({ ...saved[0], name: legacy.name }, legacy);
  await mutateRules({ operation: 'toggle', id: legacy.id, enabled: false });
  await mutateRules({ operation: 'toggle', id: legacy.id, enabled: true });
  assert.deepEqual(parseRulesImport(JSON.stringify(createRulesExport(await getRules()))).rules, saved);
  // Export also handles callers holding a legacy snapshot before migration.
  const exported = createRulesExport([legacy]);
  assert.equal(exported.rules.length, 1);
  assert.equal(parseRulesImport(JSON.stringify(exported)).rules[0].pattern, domain);
});
