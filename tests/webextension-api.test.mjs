import assert from 'node:assert/strict';
import test from 'node:test';
import { getExtensionApi, sendExtensionMessage, usesPromiseMessaging } from '../src/shared/webextension-api.js';

function apiStub(extensionOrigin) {
  const state = { history_rules: [] };
  const session = {};
  const handlers = {};
  const api = {
    runtime: {
      id: 'test-extension',
      onInstalled: { addListener(fn) { handlers.installed = fn; } },
      onMessage: { addListener(fn) { handlers.message = fn; } },
      getURL(path) { return `${extensionOrigin}/${path}`; },
      async openOptionsPage() {}
    },
    action: { onClicked: { addListener(fn) { handlers.clicked = fn; } } },
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(state[key]) }; },
        async set(values) { Object.assign(state, structuredClone(values)); }
      },
      session: {
        async get(key) { return { [key]: structuredClone(session[key]) }; },
        async set(values) { Object.assign(session, structuredClone(values)); },
        async remove(key) { delete session[key]; }
      }
    },
    history: {
      onVisited: { addListener(fn) { handlers.visited = fn; } },
      async search() { return []; },
      async deleteUrl() { throw new Error('No history writes expected'); },
      async addUrl() { throw new Error('No history writes expected'); }
    }
  };
  return { api, handlers, state, session };
}

test('prefers browser Promise namespace and handles callback responses on its listener', async () => {
  const env = apiStub('moz-extension://internal-id');
  globalThis.browser = env.api;
  globalThis.chrome = { runtime: { sendMessage() { throw new Error('Wrong namespace'); } } };
  try {
    assert.equal(getExtensionApi(), env.api);
    assert.equal(usesPromiseMessaging(), true);
    env.api.runtime.sendMessage = async message => ({ echoed: message.action });
    assert.deepEqual(await sendExtensionMessage({ action: 'probe' }), { echoed: 'probe' });
    await import('../src/background/service-worker.js?browser-api-test');
    const sender = { id: env.api.runtime.id, url: env.api.runtime.getURL('src/options/options.html') };
    assert.equal(env.handlers.message({ action: 'other' }, sender, () => {}), false);
    const preview = await new Promise(resolve => {
      assert.equal(env.handlers.message({ action: 'manualCleanupPreview', days: 1 }, sender, resolve), true);
    });
    assert.equal(preview.totalChecked, 0);
    assert.equal(typeof preview.planId, 'string');
    const result = await new Promise(resolve => {
      assert.equal(env.handlers.message({ action: 'manualCleanupExecute', planId: preview.planId }, sender, resolve), true);
    });
    assert.equal(result.blockedCount, 0);
    assert.equal(env.session.manual_cleanup_plan, undefined);
    env.state.history_rules = [{ id: 'block-example', name: 'Example', matchType: 'domain',
      pattern: 'example.com', action: 'block', enabled: true }];
    const removed = [];
    env.api.history.deleteUrl = async ({ url }) => { removed.push(url); };
    await env.handlers.visited({ url: 'https://example.com/private' });
    assert.deepEqual(removed, ['https://example.com/private']);
    const sendToWorker = request => new Promise(resolve => {
      assert.equal(env.handlers.message(request, sender, resolve), true);
    });
    const [utm, tco, again] = await Promise.all([
      sendToWorker({ action: 'addRuleTemplate', templateId: 'utm-cleanup' }),
      sendToWorker({ action: 'addRuleTemplate', templateId: 'tco-block' }),
      sendToWorker({ action: 'addRuleTemplate', templateId: 'utm-cleanup' })
    ]);
    assert.equal(utm.added, true);
    assert.equal(tco.added, true);
    assert.equal(again.added, false);
    assert.deepEqual(env.state.history_rules.map(rule => rule.templateId || rule.id),
      ['block-example', 'utm-cleanup', 'tco-block']);
  } finally {
    delete globalThis.browser;
    delete globalThis.chrome;
  }
});

test('falls back to Chrome callback messages and keeps its response channel open', async () => {
  const env = apiStub('chrome-extension://test-extension');
  globalThis.chrome = env.api;
  try {
    assert.equal(getExtensionApi(), env.api);
    assert.equal(usesPromiseMessaging(), false);
    env.api.runtime.sendMessage = (message, callback) => callback({ echoed: message.action });
    assert.deepEqual(await sendExtensionMessage({ action: 'probe' }), { echoed: 'probe' });
    env.api.runtime.sendMessage = (_message, callback) => {
      env.api.runtime.lastError = { message: 'Private URL must not leak' };
      callback();
      delete env.api.runtime.lastError;
    };
    await assert.rejects(sendExtensionMessage({ action: 'probe' }), /Extension messaging failed/);
    await import('../src/background/service-worker.js?chrome-api-test');
    const sender = { id: env.api.runtime.id, url: env.api.runtime.getURL('src/options/options.html') };
    assert.equal(env.handlers.message({ action: 'other' }, sender, () => {}), false);
    const response = await new Promise(resolve => {
      assert.equal(env.handlers.message({ action: 'manualCleanupPreview', days: 1 }, sender, resolve), true);
    });
    assert.equal(response.totalChecked, 0);
    assert.equal(typeof response.planId, 'string');
    const blocked = await new Promise(resolve => {
      assert.equal(env.handlers.message({ action: 'manualCleanupExecute', planId: response.planId },
        { id: 'another-extension', url: sender.url }, resolve), true);
    });
    assert.equal(blocked.errorCode, 'UNAUTHORIZED');
    for (const action of ['getRules', 'mutateRules', 'getLogs', 'clearLogs', 'addRuleTemplate']) {
      const response = await new Promise(resolve => {
        assert.equal(env.handlers.message({ action, operation: 'delete', id: 'anything' },
          { id: env.api.runtime.id, url: 'https://untrusted.example/' }, resolve), true);
      });
      assert.equal(response.errorCode, 'UNAUTHORIZED', action);
    }

  } finally {
    delete globalThis.chrome;
  }
});
