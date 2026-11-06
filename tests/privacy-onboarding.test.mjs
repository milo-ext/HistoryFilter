import assert from 'node:assert/strict';
import test from 'node:test';
import { addLog, getLogs } from '../src/shared/logger.js';
import { onHistoryVisited } from '../src/background/history-monitor.js';

function storage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(value) { Object.assign(state, structuredClone(value)); }
  };
}

test('new and legacy persistent logs contain only whitelisted fields', async () => {
  const privateUrl = 'https://private.example/secret/path?token=123';
  const local = storage({ history_logs: [{ timestamp: 1, action: 'normalize', url: privateUrl,
    newUrl: privateUrl, message: `Failure at ${privateUrl}`, unexpected: privateUrl }] });
  globalThis.chrome = { storage: { local } };
  const migrated = await getLogs();
  assert.deepEqual(migrated, [{ timestamp: 1, action: 'normalize', code: 'legacy' }]);
  await addLog({ action: 'cleanup', code: 'completed', url: privateUrl,
    message: privateUrl, counts: { blockedCount: 2, failedCount: 1, secret: privateUrl } });
  assert.deepEqual(local.state.history_logs[0], {
    timestamp: local.state.history_logs[0].timestamp,
    action: 'cleanup', code: 'completed', counts: { blockedCount: 2, failedCount: 1 }
  });
  assert.equal(JSON.stringify(local.state.history_logs).includes('private.example'), false);
});

test('history failure emits neither URLs nor raw error text to logs or console', async () => {
  const privateUrl = 'https://private.example/secret/path?token=123';
  const local = storage({ history_rules: [{ id: 'r1', name: 'Private', enabled: true,
    matchType: 'domain', pattern: 'private.example', action: 'block' }] });
  const errors = [];
  const originalError = console.error;
  globalThis.chrome = {
    storage: { local },
    history: { async deleteUrl() { throw new Error(`Failure at ${privateUrl}`); } }
  };
  console.error = (...args) => errors.push(args);
  try {
    await onHistoryVisited({ url: privateUrl });
  } finally {
    console.error = originalError;
  }
  assert.equal(JSON.stringify(errors).includes('private.example'), false);
  assert.equal(JSON.stringify(local.state.history_logs).includes('private.example'), false);
  assert.deepEqual(local.state.history_logs[0].code, 'delete_failed');
});

test('first install opens options after initialization; update does not; toolbar opens options', async () => {
  const local = storage();
  const session = { async get() { return {}; }, async set() {}, async remove() {} };
  let installed, clicked, visited, messages;
  let opens = 0;
  globalThis.chrome = {
    storage: { local, session },
    history: { onVisited: { addListener(fn) { visited = fn; } } },
    runtime: {
      id: 'test-extension',
      onInstalled: { addListener(fn) { installed = fn; } },
      onMessage: { addListener(fn) { messages = fn; } },
      async openOptionsPage() { opens++; },
      getURL(path) { return `chrome-extension://test-extension/${path}`; }
    },
    action: { onClicked: { addListener(fn) { clicked = fn; } } }
  };
  await import('../src/background/service-worker.js?onboarding-test');
  assert.equal(typeof visited, 'function');
  assert.equal(typeof messages, 'function');
  await installed({ reason: 'install' });
  assert.equal(opens, 1);
  assert.equal(local.state.history_rules[0].id, 'preset-google-translate');
  assert.equal(local.state.history_rules[0].enabled, false);
  await installed({ reason: 'update' });
  assert.equal(opens, 1);
  clicked();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 2);
});
