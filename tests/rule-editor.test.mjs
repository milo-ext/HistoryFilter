import assert from 'node:assert/strict';
import test from 'node:test';
import { getMode, normalizeOptionsFromEditor } from '../src/options/rule-editor.js';
import { evaluateUrl } from '../src/background/rule-engine.js';
import { createRulesExport, sanitizeImportedRule } from '../src/shared/rule-transfer.js';
import { getRules, mutateRules } from '../src/shared/storage.js';

const legacyRule = { id: 'legacy', name: 'Legacy normalize', enabled: true,
  matchType: 'domain', pattern: 'example.com', action: 'normalize' };
const source = 'https://example.com/path?keep=1&utm_source=2#part';

test('legacy no-mode editing requires a choice and preserves storage and export until then', async () => {
  for (const normalizeOptions of [undefined, {}]) {
    const state = { history_rules: [{ ...legacyRule, normalizeOptions }] };
    globalThis.chrome = { storage: { local: {
      async get(key) { return { [key]: structuredClone(state[key]) }; },
      async set(values) { Object.assign(state, structuredClone(values)); }
    } } };
    const [saved] = await getRules();
    assert.equal(evaluateUrl(source, [saved]).normalizedUrl, source);
    assert.equal(getMode(saved), '', 'the editor must not preselect a destructive mode');
    assert.throws(() => normalizeOptionsFromEditor(getMode(saved)),
      { code: 'normalizeModeRequired', field: 'normalize-mode' });
    await assert.rejects(mutateRules({ operation: 'edit', expectedRule: saved,
      rule: { ...saved, name: 'Rename only' } }), { code: 'INVALID_RULE' });
    await mutateRules({ operation: 'toggle', id: saved.id, enabled: false });
    await mutateRules({ operation: 'toggle', id: saved.id, enabled: true });
    assert.deepEqual(await getRules(), [saved]);
    const exported = createRulesExport(await getRules());
    assert.equal(exported.rules.length, 1);
    assert.deepEqual(exported.rules[0].normalizeOptions, {});
    assert.equal(evaluateUrl(source, exported.rules).normalizedUrl, source);

    const edited = { ...saved, name: 'Explicit selection', normalizeOptions: normalizeOptionsFromEditor('stripAll') };
    await mutateRules({ operation: 'edit', expectedRule: saved, rule: edited });
    assert.equal(evaluateUrl(source, await getRules()).normalizedUrl, 'https://example.com/path#part');
    assert.deepEqual(createRulesExport(await getRules()).rules[0].normalizeOptions, { stripAllQueryParams: true });
  }
});

test('every explicit normalization mode preserves its behavior through editor round-trip', () => {
  const options = [
    { keepOriginOnly: true }, { keepOriginAndPath: true }, { stripAllQueryParams: true },
    { stripSelectedQueryKeys: ['utm_*'] }, { keepSelectedQueryKeys: ['keep'] },
    { customFixedUrl: 'https://example.com/fixed' }
  ];
  for (const normalizeOptions of options) {
    const original = { ...legacyRule, normalizeOptions };
    const saved = sanitizeImportedRule({ ...original, normalizeOptions: normalizeOptionsFromEditor(getMode(original), {
      stripQueryKeys: (normalizeOptions.stripSelectedQueryKeys || []).join(', '),
      keepQueryKeys: (normalizeOptions.keepSelectedQueryKeys || []).join(', '),
      customFixedUrl: normalizeOptions.customFixedUrl || ''
    }) });
    assert.deepEqual(saved.normalizeOptions, normalizeOptions);
    assert.deepEqual(evaluateUrl(source, [saved]), evaluateUrl(source, [original]));
  }
});

test('editor rejects missing, unknown and malformed mode inputs', () => {
  for (const mode of ['', 'unknown']) {
    assert.throws(() => normalizeOptionsFromEditor(mode), { code: 'normalizeModeRequired' });
  }
  assert.throws(() => normalizeOptionsFromEditor('stripSelectedQuery', { stripQueryKeys: '*' }), { code: 'stripKeysInvalid' });
  assert.throws(() => normalizeOptionsFromEditor('keepSelectedQuery'), { code: 'keysRequired' });
  assert.throws(() => normalizeOptionsFromEditor('customFixed', { customFixedUrl: 'javascript:alert(1)' }), { code: 'fixedInvalid' });
});
