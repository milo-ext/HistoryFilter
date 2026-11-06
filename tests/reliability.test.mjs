import assert from 'node:assert/strict';
import test from 'node:test';
import * as storage from '../src/shared/storage.js';
import { addLog, clearLogs, getLogs } from '../src/shared/logger.js';
import { sanitizeImportedRule } from '../src/shared/rule-transfer.js';

const rule = { id: 'r1', name: 'Example', enabled: true, matchType: 'domain', pattern: 'old.example', action: 'block' };
function setup(rules = [rule]) {
  const state = { history_rules: structuredClone(rules), history_logs: [] };
  globalThis.chrome = { storage: { local: {
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(values) { Object.assign(state, structuredClone(values)); }
  } } };
  return state;
}

test('concurrent ordinary and template additions retain every rule', async () => {
  const state = setup([]);
  await Promise.all([
    storage.addRule({ ...rule, id: 'first' }),
    storage.addRule({ ...rule, id: 'second' }),
    storage.addTemplateRule('utm-cleanup')
  ]);
  assert.equal(state.history_rules.length, 3);
});

test('field-only toggle preserves another page edit and stale editor saves are rejected', async () => {
  const state = setup();
  await storage.mutateRules({ operation: 'edit', rule: { ...rule, pattern: 'new.example' }, expectedRule: rule });
  await storage.mutateRules({ operation: 'toggle', id: rule.id, enabled: false });
  assert.equal(state.history_rules[0].pattern, 'new.example');
  assert.equal(state.history_rules[0].enabled, false);
  await assert.rejects(storage.mutateRules({ operation: 'edit', rule, expectedRule: rule }), { code: 'RULE_CONFLICT' });
});

test('replacement import cannot overwrite rules changed since its confirmation opened', async () => {
  const state = setup();
  await storage.addRule({ ...rule, id: 'second' });
  await assert.rejects(storage.mutateRules({ operation: 'import', mode: 'replace', rules: [rule], expectedRules: [rule] }), { code: 'RULE_CONFLICT' });
  assert.equal(state.history_rules.length, 2);
});

test('concurrent activity writes and clear keep their invocation order', async () => {
  setup();
  await Promise.all([addLog({ action: 'block', code: 'completed' }), addLog({ action: 'normalize', code: 'completed' })]);
  assert.equal((await getLogs()).length, 2);
  await Promise.all([addLog({ action: 'block', code: 'completed' }), clearLogs(), addLog({ action: 'error', code: 'add_failed' })]);
  assert.deepEqual((await getLogs()).map(log => log.action), ['error']);
});

test('unsafe regular expressions are refused by the import validator', () => {
  for (const pattern of ['(a+)+$', '^(a+)+$', '^a+a+$', '^https://(a|aa)+$', '^a(?=b)', '^a.*|b.*', '^a{1000000}']) {
    assert.equal(sanitizeImportedRule({ ...rule, matchType: 'regex', pattern }), null, pattern);
  }
});

test('fresh installs do not process visits before the user enables a rule', async () => {
  setup();
  delete globalThis.chrome;
  const state = {};
  globalThis.chrome = { storage: { local: {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, structuredClone(values)); }
  } } };
  const rules = await storage.getRules();
  assert.equal(rules.every(rule => rule.enabled === false), true);
  state.history_rules[0].enabled = true;
  assert.equal((await storage.getRules())[0].enabled, true, 'existing choice survives initialization');
});
