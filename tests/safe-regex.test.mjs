import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { compileSafeRegex } from '../src/shared/safe-regex.js';
import { createTemplateRule } from '../src/shared/presets.js';

test('supported URL regexes preserve native matching semantics', () => {
  for (const pattern of ['^https?://example\\.com/', '^https://example\\.com/[a-z]+$', '^https://example\\.com/a{1,20}$', '^https://(?:one|two)\\.example/.*$', createTemplateRule('local-dev-block').pattern]) {
    const regex = compileSafeRegex(pattern);
    assert.ok(regex, pattern);
    for (const url of ['https://example.com/aaa', 'http://localhost:3000/', 'https://two.example/path', 'https://unrelated.example/']) {
      assert.equal(regex.test(url), new RegExp(pattern, 'i').test(url));
    }
  }
});

test('ambiguous groups, repeated atoms, backreferences and unanchored alternatives are rejected', () => {
  for (const pattern of ['(a+)+$', '^(a+)+$', '^a+a+$', '^(a|aa)+$', '^a(?=b)', '^a.*|b.*', '^a{1000000}', '^(a)\\1$', '^a?a?a?a?a?a?a?a?a?', '^a.*.*', '^a{1,2}a+', '^a++', '^a\\x61+', '^a\\u0061+', '^a(?<name>b)', '^[a', '^\\', '^a{1,}', '^a.*?']) {
    assert.equal(compileSafeRegex(pattern), null, pattern);
  }
});

test('runtime never executes a legacy catastrophic regex, even without import validation', () => {
  const engine = new URL('../src/background/rule-engine.js', import.meta.url).href;
  const code = `import { evaluateUrl } from ${JSON.stringify(engine)};
    const rule = { matchType: 'regex', pattern: '^(a+)+$', enabled: true, action: 'block' };
    if (evaluateUrl('a'.repeat(40) + '!', [rule]) !== null) process.exit(1);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr.toString());
});

test('export preserves unsupported legacy expressions for recovery, import refuses them', async () => {
  const { createRulesExport, sanitizeImportedRule } = await import('../src/shared/rule-transfer.js');
  const rule = { id: 'old', name: 'Legacy', enabled: true, matchType: 'regex', pattern: '(a+)+$', action: 'block' };
  assert.deepEqual(createRulesExport([rule]).rules, [rule]);
  assert.equal(sanitizeImportedRule(rule), null);
});
