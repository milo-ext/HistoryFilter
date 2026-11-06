import assert from 'node:assert/strict';
import test from 'node:test';
import { previewExistingHistory, executeExistingHistory, cancelExistingHistory } from '../src/background/history-processor.js';

function rule(action, extra = {}) {
  return { id: 'r1', name: 'Example', enabled: true, matchType: 'domain', pattern: 'example.com',
    action, ...extra };
}

function setup(rules, urls, { failAdd = false, failDelete = false } = {}) {
  const local = { history_rules: structuredClone(rules) };
  const session = {};
  const writes = [];
  const searches = [];
  const defaultVisitTime = Date.now() - 1000;
  const withTimes = value => structuredClone(value).map(item => ({
    ...item, lastVisitTime: item.lastVisitTime ?? defaultVisitTime
  }));
  let currentUrls = withTimes(urls);
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(local[key]) }; },
        async set(value) { Object.assign(local, structuredClone(value)); }
      },
      session: {
        async get(key) { return { [key]: structuredClone(session[key]) }; },
        async set(value) { Object.assign(session, structuredClone(value)); },
        async remove(key) { delete session[key]; }
      }
    },
    history: {
      async search(query) {
        searches.push(query);
        return structuredClone(currentUrls
          .filter(item => item.lastVisitTime > query.startTime && item.lastVisitTime < query.endTime)
          .slice(0, query.maxResults));
      },
      async addUrl({ url }) { if (failAdd) throw new Error('add failed'); writes.push(['add', url]); },
      async deleteUrl({ url }) { if (failDelete) throw new Error('delete failed'); writes.push(['delete', url]); }
    }
  };
  return { local, session, writes, searches, setUrls(value) { currentUrls = withTimes(value); } };
}

test('execution uses frozen URLs, actions and time window, and rejects replay', async () => {
  const url = 'https://example.com/one';
  const env = setup([rule('block')], [{ url }, { url: 'https://other.com/' }]);
  const preview = await previewExistingHistory(30);
  assert.equal(preview.blockedCount, 1);
  assert.equal(preview.totalChecked, 2);
  assert.equal(preview.samples[0].statusCode, 'WILL_BLOCK');
  assert.equal(env.searches[0].maxResults, 10_000);
  assert.equal(env.searches[0].endTime, preview.endTime);
  env.setUrls([{ url: 'https://example.com/new' }]);
  const result = await executeExistingHistory(preview.planId);
  assert.deepEqual(env.writes, [['delete', url]]);
  assert.equal(result.blockedCount, 1);
  assert.equal(env.searches.length, 1);
  assert.equal(env.session.manual_cleanup_plan, undefined);
  await assert.rejects(executeExistingHistory(preview.planId), /Preview again/);
});

test('changed rules require another preview and do not touch history', async () => {
  const env = setup([rule('block')], [{ url: 'https://example.com/one' }]);
  const preview = await previewExistingHistory(7);
  env.local.history_rules[0].enabled = false;
  await assert.rejects(executeExistingHistory(preview.planId), /Rules changed/);
  assert.deepEqual(env.writes, []);
  await assert.rejects(executeExistingHistory(preview.planId), /Preview again/);
});

test('failed target add leaves original alone; failed original delete reports partial', async () => {
  const original = 'https://example.com/path?q=secret';
  const normalize = rule('normalize', { normalizeOptions: { keepOriginAndPath: true } });
  const addFailure = setup([normalize], [{ url: original }], { failAdd: true });
  const first = await previewExistingHistory(1);
  const firstResult = await executeExistingHistory(first.planId);
  assert.equal(firstResult.failedCount, 1);
  assert.equal(firstResult.partialCount, 0);
  assert.equal(firstResult.normalizedCount, 0);
  assert.deepEqual(addFailure.writes, []);

  const deleteFailure = setup([normalize], [{ url: original }], { failDelete: true });
  const second = await previewExistingHistory(1);
  const secondResult = await executeExistingHistory(second.planId);
  assert.equal(secondResult.failedCount, 0);
  assert.equal(secondResult.partialCount, 1);
  assert.equal(secondResult.normalizedCount, 0);
  assert.deepEqual(deleteFailure.writes, [['add', 'https://example.com/path']]);
});

test('more than 10,000 URLs scans fully and returns a warning, without preview writes', async () => {
  const now = Date.now();
  const urls = Array.from({ length: 10_001 }, (_, i) => ({
    url: `https://example.com/${i}`, lastVisitTime: now - 10_000 - i * 1000
  }));
  const env = setup([rule('block')], urls);
  const preview = await previewExistingHistory(1);
  assert.equal(preview.totalChecked, 10_001);
  assert.equal(preview.blockedCount, 10_001);
  assert.equal(preview.largeHistory, true);
  assert.equal(preview.warningThreshold, 10_000);
  assert.ok(env.searches.length > 1);
  assert.ok(env.session.manual_cleanup_plan);
  assert.deepEqual(env.writes, []);
});

test('cancel and a newer preview invalidate the prior plan', async () => {
  const env = setup([rule('block')], [{ url: 'https://example.com/one' }]);
  const first = await previewExistingHistory(1);
  await cancelExistingHistory(first.planId);
  await assert.rejects(executeExistingHistory(first.planId), /Preview again/);
  const second = await previewExistingHistory(1);
  const third = await previewExistingHistory(1);
  await assert.rejects(executeExistingHistory(second.planId), /Preview again/);
  assert.equal(env.session.manual_cleanup_plan.planId, third.planId);
  delete env.session.manual_cleanup_plan; // Browser restart or extension reload clears session storage.
  await assert.rejects(executeExistingHistory(third.planId), { code: 'PLAN_UNAVAILABLE' });
  assert.deepEqual(env.writes, []);
});

test('more than 2,000 planned changes execute completely', async () => {
  const urls = Array.from({ length: 2_001 }, (_, i) => ({ url: `https://example.com/${i}` }));
  const env = setup([rule('block')], urls);
  const preview = await previewExistingHistory(1);
  assert.equal(preview.blockedCount, 2_001);
  assert.equal(preview.largeHistory, false);
  const result = await executeExistingHistory(preview.planId);
  assert.equal(result.blockedCount, 2_001);
  assert.equal(env.session.manual_cleanup_plan, undefined);
  assert.equal(env.writes.length, 2_001);
});

test('a second tab cannot execute while another execution is in progress', async () => {
  const env = setup([rule('block')], [{ url: 'https://example.com/one' }]);
  const preview = await previewExistingHistory(1);
  let resumeDelete;
  chrome.history.deleteUrl = async ({ url }) => {
    await new Promise(resolve => { resumeDelete = resolve; });
    env.writes.push(['delete', url]);
  };
  const execution = executeExistingHistory(preview.planId);
  while (!resumeDelete) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(executeExistingHistory(preview.planId), /already running/);
  await assert.rejects(previewExistingHistory(1), /already running/);
  resumeDelete();
  assert.equal((await execution).blockedCount, 1);
  assert.deepEqual(env.writes, [['delete', 'https://example.com/one']]);
});

test('invalid day values are rejected before history search', async () => {
  const env = setup([rule('block')], []);
  for (const days of [-1, 1.5, '30', 3651, NaN]) {
    await assert.rejects(previewExistingHistory(days), /whole number of days/);
  }
  assert.equal(env.searches.length, 0);
});

test('already normalized URLs are no-ops', async () => {
  const url = 'https://example.com/clean';
  const env = setup([rule('normalize', { normalizeOptions: { keepOriginAndPath: true } })], [{ url }]);
  const preview = await previewExistingHistory(1);
  assert.equal(preview.normalizedCount, 0);
  assert.equal(preview.skippedCount, 0);
  const result = await executeExistingHistory(preview.planId);
  assert.equal(result.normalizedCount, 0);
  assert.deepEqual(env.writes, []);
});

test('normalization targeting a URL scheduled for cleanup is skipped', async () => {
  const original = 'https://example.com/path?q=secret';
  const target = 'https://example.com/path';
  const env = setup([
    rule('block', { id: 'block-target', queryKey: '', pathPattern: '/path', pathMatchType: 'exact',
      // A regex rule below handles the exact target while the first rule matches only query-bearing URLs.
      matchType: 'regex', pattern: '^https://example\\.com/path$' }),
    rule('normalize', { id: 'normalize-source', normalizeOptions: { keepOriginAndPath: true } })
  ], [{ url: original }, { url: target }]);
  const preview = await previewExistingHistory(1);
  assert.equal(preview.blockedCount, 1);
  assert.equal(preview.normalizedCount, 0);
  assert.equal(preview.conflictingTargetCount, 1);
  assert.equal(preview.skippedCount, 1);
  assert.equal(preview.samples[0].status, 'skipped');
  assert.equal(preview.samples[0].statusCode, 'SKIPPED');
  assert.equal(preview.samples[0].reasonCode, 'CONFLICTING_TARGET');
  const result = await executeExistingHistory(preview.planId);
  assert.equal(result.blockedCount, 1);
  assert.deepEqual(env.writes, [['delete', target]]);
});

test('overlapping time windows deduplicate boundary URLs and enumerate dense ties', async () => {
  const originalNow = Date.now;
  const fixedNow = 2_000_000_000_000;
  Date.now = () => fixedNow;
  try {
    const midpoint = fixedNow - 12 * 60 * 60 * 1000;
    const urls = Array.from({ length: 10_001 }, (_, i) => ({
      url: `https://example.com/tie-${i}`, lastVisitTime: midpoint
    }));
    urls.push({ url: urls[0].url, lastVisitTime: midpoint + 0.5 });
    const env = setup([rule('block')], urls);
    const preview = await previewExistingHistory(1);
    assert.equal(preview.totalChecked, 10_001);
    assert.equal(preview.blockedCount, 10_001);
    assert.equal(preview.largeHistory, true);
    assert.ok(env.searches.some(query => query.maxResults > 10_000));
    assert.deepEqual(env.writes, []);
  } finally {
    Date.now = originalNow;
  }
});

test('exactly 10,000 URLs sharing a timestamp are complete without a warning', async () => {
  const originalNow = Date.now;
  const fixedNow = 2_000_000_000_000;
  Date.now = () => fixedNow;
  try {
    const at = fixedNow - 1000;
    const urls = Array.from({ length: 10_000 }, (_, i) => ({
      url: `https://example.com/tie-${i}`, lastVisitTime: at
    }));
    const env = setup([rule('block')], urls);
    const preview = await previewExistingHistory(1);
    assert.equal(preview.totalChecked, 10_000);
    assert.equal(preview.blockedCount, 10_000);
    assert.equal(preview.largeHistory, false);
    assert.ok(env.searches.some(query => query.maxResults > 10_000));
    assert.deepEqual(env.writes, []);
  } finally {
    Date.now = originalNow;
  }
});

test('an API error while enumerating a dense timestamp fails before plan or writes', async () => {
  const originalNow = Date.now;
  const fixedNow = 2_000_000_000_000;
  Date.now = () => fixedNow;
  try {
    const at = fixedNow - 1000;
    const urls = Array.from({ length: 10_001 }, (_, i) => ({ url: `https://example.com/${i}`, lastVisitTime: at }));
    const env = setup([rule('block')], urls);
    const realSearch = chrome.history.search;
    chrome.history.search = query => query.maxResults > 10_000
      ? Promise.reject(new Error('Simulated Chrome query failure')) : realSearch(query);
    await assert.rejects(previewExistingHistory(1), /Simulated Chrome query failure/);
    assert.equal(env.session.manual_cleanup_plan, undefined);
    assert.deepEqual(env.writes, []);
  } finally {
    Date.now = originalNow;
  }
});

test('temporary plan quota failure is explicit and makes no history changes', async () => {
  const env = setup([rule('block')], [{ url: 'https://example.com/one' }]);
  chrome.storage.session.set = async () => { throw new Error('QUOTA_BYTES'); };
  await assert.rejects(previewExistingHistory(1), { code: 'PLAN_SIZE' });
  assert.equal(env.session.manual_cleanup_plan, undefined);
  assert.deepEqual(env.writes, []);
});

test('a preview stays executable after 10 minutes and uses only its frozen URLs', async () => {
  const originalNow = Date.now;
  let clock = 2_000_000_000_000;
  Date.now = () => clock;
  try {
    const env = setup([rule('block')], [{ url: 'https://example.com/one', lastVisitTime: clock - 1000 }]);
    const realSearch = chrome.history.search;
    chrome.history.search = async query => {
      const items = await realSearch(query);
      clock += 10 * 60 * 1000;
      return items;
    };
    const preview = await previewExistingHistory(1);
    assert.equal(preview.endTime, 2_000_000_000_000);
    assert.equal(preview.totalChecked, 1);
    assert.equal(Object.hasOwn(preview, 'expiresAt'), false);
    assert.equal(Object.hasOwn(env.session.manual_cleanup_plan, 'expiresAt'), false);
    env.setUrls([{ url: 'https://example.com/new', lastVisitTime: clock - 1000 }]);
    clock += 10 * 60 * 1000;
    const result = await executeExistingHistory(preview.planId);
    assert.equal(result.blockedCount, 1);
    assert.deepEqual(env.writes, [['delete', 'https://example.com/one']]);
  } finally {
    Date.now = originalNow;
  }
});
