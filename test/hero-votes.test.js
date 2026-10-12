'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, TTL, STALE_TTL, VOTE_ID, ROLES } = require('../api/hero-votes')._private;

function fixture() {
  const tabs = ROLES.map((role, i) => ({ tab_id: String(100 + i), tab_name: role }));
  const state = { calls: [], fail: false, paginate: false, invalidScore: false, missingTab: false };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    state.calls.push(url);
    if (state.fail) throw new Error('模拟上游故障');
    let data;
    if (url.pathname.endsWith('query_vote_base_info')) {
      data = { vote_id: VOTE_ID, tabs: state.missingTab ? tabs.slice(1) : tabs, play_rule_status: 'ONLINE' };
    } else {
      const id = url.searchParams.get('tab_id');
      const next = url.searchParams.has('cursor');
      data = {
        options: [{ id: id + (next ? '2' : '1'), tab_id: id, custom_option: { name: ` 英雄${id}${next ? '续' : ''} ` }, score: state.invalidScore ? null : 50, rank: 1 }],
        has_more: state.paginate && !next, next_cursor: '下一页',
      };
    }
    return { ok: true, json: async () => ({ success: true, code: 0, data }) };
  };
  return { state, fetchImpl };
}

async function invoke(handler, method = 'GET') {
  const result = { headers: {} };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; }, end() {},
  };
  await handler({ method, query: {} }, res);
  return result;
}

test('并发读取合并为一轮，五分钟缓存保留实际拉取时间', async () => {
  const { state, fetchImpl } = fixture();
  let time = Date.parse('2026-10-12T00:00:00Z');
  const handler = createHandler({ fetchImpl, now: () => time });
  const [first, concurrent] = await Promise.all([invoke(handler), invoke(handler)]);
  assert.equal(state.calls.length, 7);
  assert.equal(first.body.total, 6);
  assert.equal(first.body.rows[0].name.startsWith(' '), false);
  assert.equal(first.body.fetchedAt, concurrent.body.fetchedAt);
  time += 200000;
  const cached = await invoke(handler);
  assert.equal(state.calls.length, 7);
  assert.equal(cached.body.fetchedAt, first.body.fetchedAt);
  assert.match(cached.headers['Cache-Control'], /s-maxage=100,/);
  time += 100000;
  const refreshed = await invoke(handler);
  assert.equal(state.calls.length, 14);
  assert.notEqual(refreshed.body.fetchedAt, first.body.fetchedAt);
});

test('完整追踪分页，源站大整数 ID 保持字符串', async () => {
  const { state, fetchImpl } = fixture(); state.paginate = true;
  const result = await invoke(createHandler({ fetchImpl }));
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 12);
  assert.ok(state.calls.every(url => url.searchParams.get('vote_id') === VOTE_ID));
  assert.equal(state.calls.filter(url => url.searchParams.get('cursor') === '下一页').length, 6);
});

test('缺组或非法票数不能发布半份榜单或伪造零票', async () => {
  for (const field of ['missingTab', 'invalidScore']) {
    const { state, fetchImpl } = fixture(); state[field] = true;
    const result = await invoke(createHandler({ fetchImpl }));
    assert.equal(result.status, 502);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
});

test('失败保留旧快照及时间，短期退避，超过一天拒绝旧数据', async () => {
  const { state, fetchImpl } = fixture();
  let time = Date.now(); const initial = time;
  const handler = createHandler({ fetchImpl, now: () => time });
  const first = await invoke(handler);
  time += TTL; state.fail = true;
  const stale = await invoke(handler);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(stale.headers['Cache-Control'], 'no-store');
  const calls = state.calls.length;
  await invoke(handler);
  assert.equal(state.calls.length, calls);
  time = initial + STALE_TTL;
  assert.equal((await invoke(handler)).status, 502);
});

test('上游卡住时超时终止，写入方法不会触达源站', async () => {
  const handler = createHandler({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('请求超时')), { once: true });
  }) });
  assert.equal((await invoke(handler)).status, 502);
  const { state, fetchImpl } = fixture(); const readonly = createHandler({ fetchImpl });
  assert.equal((await invoke(readonly, 'POST')).status, 405);
  assert.equal((await invoke(readonly, 'OPTIONS')).status, 204);
  assert.equal(state.calls.length, 0);
});
