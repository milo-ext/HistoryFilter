import assert from 'node:assert/strict';
import test from 'node:test';
import { onHistoryVisited } from '../src/background/history-monitor.js';

function setup(rule, entries, { failAdd = false } = {}) {
  const history = new Map(entries);
  const state = { history_rules: [rule] };
  const writes = [];
  const events = [];

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(state[key]) }; },
        async set(values) { Object.assign(state, structuredClone(values)); }
      }
    },
    history: {
      async getVisits({ url }) {
        return Array.from({ length: history.get(url) || 0 }, (_, i) => ({ visitId: String(i) }));
      },
      async addUrl({ url }) {
        if (failAdd) throw new Error('Simulated history write failure');
        writes.push(['add', url]);
        history.set(url, (history.get(url) || 0) + 1);
        events.push(onHistoryVisited({ url, visitCount: history.get(url) }));
      },
      async deleteUrl({ url }) {
        writes.push(['delete', url]);
        history.delete(url);
      }
    }
  };

  return { history, state, writes, events };
}

function domainRule(action, extra = {}) {
  return {
    id: 'test-rule', name: 'Test rule', enabled: true,
    matchType: 'domain', pattern: 'example.com', action, ...extra
  };
}

for (const visitCount of [1, 5, undefined]) {
  test(`block removes all matched visits with visitCount=${visitCount}`, async () => {
    const url = 'https://example.com/private';
    const otherUrl = 'https://unrelated.example/';
    const env = setup(domainRule('block'), [[url, visitCount ?? 5], [otherUrl, 2]]);

    await onHistoryVisited({ url, visitCount });

    assert.equal(env.history.has(url), false);
    assert.equal(env.history.get(otherUrl), 2);
    assert.equal(env.state.history_logs[0].action, 'block');
  });
}

for (const visitCount of [5, undefined]) {
  test(`normalize replaces all matched visits with visitCount=${visitCount}`, async () => {
    const target = `https://example.com/normalized-${visitCount}`;
    const url = `${target}?text=private`;
    const env = setup(domainRule('normalize', {
      normalizeOptions: { keepOriginAndPath: true }
    }), [[url, 5], [target, 2]]);

    await onHistoryVisited({ url, visitCount });
    await Promise.all(env.events);

    assert.equal(env.history.has(url), false);
    assert.equal(env.history.get(target), 3);
    assert.deepEqual(env.writes, [['add', target], ['delete', url]]);
    assert.equal(env.state.history_logs[0].action, 'normalize');
  });
}

test('a disabled rule leaves all visits untouched', async () => {
  const url = 'https://example.com/disabled';
  const env = setup(domainRule('block', { enabled: false }), [[url, 5]]);
  await onHistoryVisited({ url, visitCount: 5 });
  assert.equal(env.history.get(url), 5);
  assert.deepEqual(env.writes, []);
});

test('an unmatched URL leaves all visits untouched', async () => {
  const url = 'https://unrelated.example/private';
  const env = setup(domainRule('block'), [[url, 5]]);
  await onHistoryVisited({ url, visitCount: 5 });
  assert.equal(env.history.get(url), 5);
  assert.deepEqual(env.writes, []);
});

test('normalize leaves already clean URLs untouched', async () => {
  const url = 'https://example.com/already-clean';
  const env = setup(domainRule('normalize', {
    normalizeOptions: { keepOriginAndPath: true }
  }), [[url, 5]]);
  await onHistoryVisited({ url, visitCount: 5 });
  assert.equal(env.history.get(url), 5);
  assert.deepEqual(env.writes, []);
});

test('normalize preserves original visits when adding the target fails', async () => {
  const url = 'https://example.com/write-failure?text=private';
  const env = setup(domainRule('normalize', {
    normalizeOptions: { keepOriginAndPath: true }
  }), [[url, 5]], { failAdd: true });
  await onHistoryVisited({ url, visitCount: 5 });
  assert.equal(env.history.get(url), 5);
  assert.deepEqual(env.writes, []);
  assert.equal(env.state.history_logs[0].action, 'error');
});

test('extension-generated target is not processed by a later block rule', async () => {
  const target = 'https://example.com/guarded';
  const url = `${target}?text=private`;
  const env = setup(domainRule('normalize', {
    queryKey: 'text', normalizeOptions: { keepOriginAndPath: true }
  }), [[url, 5]]);
  env.state.history_rules.push(domainRule('block', { id: 'fallback-block' }));

  await onHistoryVisited({ url, visitCount: 5 });
  await Promise.all(env.events);

  assert.equal(env.history.has(url), false);
  assert.equal(env.history.get(target), 1);
  assert.deepEqual(env.writes, [['add', target], ['delete', url]]);
});

test('a real target visit immediately after normalization still runs its block rule', async () => {
  const target = 'https://example.com/revisited-target';
  const url = `${target}?text=private`;
  const env = setup(domainRule('normalize', { queryKey: 'text', normalizeOptions: { keepOriginAndPath: true } }), [[url, 1]]);
  env.state.history_rules.push(domainRule('block', { id: 'fallback' }));
  await onHistoryVisited({ url });
  await Promise.all(env.events);
  assert.equal(env.history.has(target), true);
  await onHistoryVisited({ url: target });
  assert.equal(env.history.has(target), false);
});

test('failed generated visit does not suppress a subsequent real visit', async () => {
  const target = 'https://example.com/failed-generated-target';
  const url = `${target}?text=private`;
  const env = setup(domainRule('normalize', { queryKey: 'text', normalizeOptions: { keepOriginAndPath: true } }), [[url, 1], [target, 1]], { failAdd: true });
  env.state.history_rules.push(domainRule('block', { id: 'fallback' }));
  await onHistoryVisited({ url });
  await onHistoryVisited({ url: target });
  assert.equal(env.history.has(target), false);
});
