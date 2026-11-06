import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MESSAGES } from '../src/options/locales.js';

test('English and Chinese UI catalogs have matching keys and placeholders', () => {
  const english = MESSAGES.en;
  const chinese = MESSAGES['zh-CN'];
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  for (const key of Object.keys(english)) {
    assert.equal(typeof english[key], 'string');
    assert.equal(typeof chinese[key], 'string');
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(chinese[key]), placeholders(english[key]), `Placeholder mismatch in ${key}`);
  }
});

test('all localized HTML attributes point to catalog keys', () => {
  const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(key in MESSAGES.en, `Missing locale key ${key}`);
});
