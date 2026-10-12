'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, TTL, STALE_TTL, VOTE_ID, ROLES } = require('../api/hero-votes')._private;
const { VOTE_ID: BILI_VOTE_ID, GROUP_ID } = require('../lib/hero-votes-bilibili');

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

async function invoke(handler, method = 'GET', platform) {
  const result = { headers: {} };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; }, end() {},
  };
  await handler({ method, query: platform === undefined ? {} : { platform } }, res);
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

function biliFixture() {
  const state = { calls: [], fail: false, duplicate: false, changedVersion: false, changedTotal: false, invalidVote: false };
  const fetchImpl = async input => {
    const url = new URL(input); state.calls.push(url);
    if (state.fail) throw new Error('模拟 B 站故障');
    const page = Number(url.searchParams.get('pn'));
    const size = page === 3 ? 27 : 50;
    return { ok: true, json: async () => ({ code: 0, data: {
      vote_id: BILI_VOTE_ID, group_id: GROUP_ID, vote_display: true,
      random_version: state.changedVersion && page > 1 ? '版本二' : '版本一',
      page: { num: size, total: state.changedTotal && page > 1 ? 128 : 127, page_num: page, page_size: 50 },
      items: Array.from({ length: size }, (_, i) => {
        const id = (state.duplicate && page > 1 ? 0 : (page - 1) * 50) + i;
        return { item_id: String(id), item: { title: '英雄' + id }, vote: state.invalidVote ? null : id };
      }),
    } }) };
  };
  return { state, fetchImpl };
}

test('B 站沿用随机版本完整读取三页，并按票数排序、保留真实零票', async () => {
  const { state, fetchImpl } = biliFixture();
  const handler = createHandler({ fetchImpl });
  const [first, concurrent] = await Promise.all([invoke(handler, 'GET', 'bilibili'), invoke(handler, 'GET', 'bilibili')]);
  assert.equal(first.status, 200);
  assert.equal(first.body.platform, 'bilibili');
  assert.equal(first.body.total, 127);
  assert.equal(first.body.rows[0].votes, 126);
  assert.equal(first.body.rows.at(-1).votes, 0);
  assert.equal(first.body.fetchedAt, concurrent.body.fetchedAt);
  assert.equal(state.calls.length, 3);
  assert.deepEqual(state.calls.map(url => url.searchParams.get('random_version')), ['', '版本一', '版本一']);
  assert.ok(state.calls.every(url => url.searchParams.get('vote_id') === BILI_VOTE_ID && !url.searchParams.has('csrf')));
});

test('B 站重复、分页版本或总数变化、非法票数均拒绝发布', async () => {
  for (const flag of ['duplicate', 'changedVersion', 'changedTotal', 'invalidVote']) {
    const { state, fetchImpl } = biliFixture(); state[flag] = true;
    const result = await invoke(createHandler({ fetchImpl }), 'GET', 'bilibili');
    assert.equal(result.status, 502, flag);
    assert.equal(result.body.rows, undefined);
  }
});

test('平台缓存、并发和失败退避独立，未知平台不触达源站', async () => {
  const xhs = fixture(); const bili = biliFixture();
  let time = Date.now();
  const handler = createHandler({ now: () => time, fetchImpl: url => url.includes('api.bilibili.com') ? bili.fetchImpl(url) : xhs.fetchImpl(url) });
  const [a, b] = await Promise.all([invoke(handler), invoke(handler, 'GET', 'bilibili')]);
  assert.equal(a.body.platform, 'xhs'); assert.equal(b.body.platform, 'bilibili');
  time += TTL; bili.state.fail = true;
  const failed = await invoke(handler, 'GET', 'bilibili');
  assert.equal(failed.body.stale, true); assert.equal(failed.body.fetchedAt, b.body.fetchedAt);
  const refreshed = await invoke(handler);
  assert.equal(refreshed.body.stale, false); assert.notEqual(refreshed.body.fetchedAt, a.body.fetchedAt);
  const calls = xhs.state.calls.length + bili.state.calls.length;
  for (const value of ['unknown', 'toString', ['xhs', 'bilibili']]) {
    assert.equal((await invoke(handler, 'GET', value)).status, 400);
  }
  assert.equal(xhs.state.calls.length + bili.state.calls.length, calls);
});

function weiboFixture(flag) {
  const time = Date.parse('2026-10-12T06:00:00Z');
  const state = { calls: 0 };
  const fetchImpl = async () => {
    state.calls++;
    const rows = Array.from({ length: flag === 'missing' ? 126 : 127 }, (_, i) => ({
      heroId: flag === 'duplicate' ? 1 : i + 1, heroName: '英雄' + i,
      allVoteNum: flag === 'invalid' ? null : i === 0 ? 7.2 : 0,
    }));
    const date = flag === 'old' ? '2026-10-11 13:00' : flag === 'future' ? '2026-10-12 15:00' : '2026-10-12 13:54';
    return { ok: true, json: async () => ({ status: { code: 200 }, data: { result: {
      platform: flag === 'platform' ? 'all' : 'wb', rows,
      content: flag === 'time' ? '<div>暂无更新时间</div>' : '<div>最后更新时间:' + date + '<hr /><script>不渲染第三方内容</script></div>',
    } } }) };
  };
  return { time, state, fetchImpl };
}

test('微博转供保留来源时间及署名，万转换票数始终标记为约数，不透传 HTML', async () => {
  const { time, state, fetchImpl } = weiboFixture();
  const handler = createHandler({ now: () => time, fetchImpl });
  const result = await invoke(handler, 'GET', 'weibo');
  assert.equal(result.status, 200); assert.equal(result.body.total, 127);
  assert.equal(result.body.sourceUpdatedAt, '2026-10-12T13:54:00+08:00');
  assert.equal(result.body.fetchedAt, '2026-10-12T06:00:00.000Z');
  assert.equal(result.body.source.provider.name, '苏苏的荣耀助手');
  assert.equal(result.body.rows[0].votes, 72000);
  assert.ok(result.body.rows.every(row => row.approximate === true));
  assert.equal(result.body.approximate, true); assert.equal(result.body.content, undefined);
  await invoke(handler, 'GET', 'weibo'); assert.equal(state.calls, 1);
});

test('微博缺项、跨平台数据、重复英雄、非数字票数或异常来源时间均拒绝发布', async () => {
  for (const flag of ['missing', 'duplicate', 'invalid', 'platform', 'old', 'future', 'time']) {
    const { time, fetchImpl } = weiboFixture(flag);
    const result = await invoke(createHandler({ now: () => time, fetchImpl }), 'GET', 'weibo');
    assert.equal(result.status, 502, flag);
  }
});

test('微博旧来源不会因重新拉取而延寿，缓存及失败回退均受来源时间限制', async () => {
  const source = weiboFixture(); let time = source.time;
  const handler = createHandler({ now: () => time, fetchImpl: source.fetchImpl });
  assert.equal((await invoke(handler, 'GET', 'weibo')).status, 200);
  time = Date.parse('2026-10-13T05:53:30Z');
  const last = await invoke(handler, 'GET', 'weibo');
  assert.equal(last.status, 200); assert.match(last.headers['Cache-Control'], /s-maxage=30,/);
  time += 30000;
  assert.equal((await invoke(handler, 'GET', 'weibo')).status, 502);
});

function kwaiFixture(flag) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url, options, request });
    const page = request.page;
    const items = Array.from({ length: page === 1 ? 100 : 27 }, (_, i) => {
      const id = 127 - (page - 1) * 100 - i;
      return { id, title: '英雄' + id, voteCount: id - 1 };
    });
    if (flag === 'missing') items.pop();
    if (flag === 'duplicate' && page === 2) items[0].id = 127;
    if (flag === 'name' && page === 2) items[0].title = '英雄127';
    if (flag === 'votes') items[0].voteCount = '7.2万';
    if (flag === 'order') items.reverse();
    return { ok: true, json: async () => ({ result: flag === 'login' ? 109 : 1,
      data: { token: flag === 'token' ? '其它活动' : 'v_HZQHiKhZ',
        totalCount: flag === 'total' && page === 2 ? 128 : 127, items } }) };
  };
  return { calls, fetchImpl };
}

test('快手分页读取全部精确票数，缓存和并发请求复用完整快照', async () => {
  const { calls, fetchImpl } = kwaiFixture();
  const handler = createHandler({ fetchImpl });
  const [a, b] = await Promise.all([invoke(handler, 'GET', 'kuaishou'), invoke(handler, 'GET', 'kuaishou')]);
  assert.equal(a.status, 200); assert.equal(a.body.platform, 'kuaishou');
  assert.equal(a.body.total, 127); assert.equal(a.body.rows.at(-1).votes, 0);
  assert.equal(a.body.rows[0].votes, 126); assert.equal(a.body.fetchedAt, b.body.fetchedAt);
  assert.equal(a.body.roleSource, 'site');
  await invoke(handler, 'GET', 'kuaishou');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.request.page), [1, 2]);
  assert.ok(calls.every(call => call.url.endsWith('/auth/vote/list') && call.options.method === 'POST' &&
    call.request.sort === 3 && call.request.count === 100 && !call.options.headers.Cookie));
});

test('快手缺页、跨页重复、错活动、登录失败和缩写票数均拒绝发布', async () => {
  for (const flag of ['missing', 'duplicate', 'name', 'votes', 'order', 'total', 'token', 'login']) {
    const { fetchImpl } = kwaiFixture(flag);
    const result = await invoke(createHandler({ fetchImpl }), 'GET', 'kuaishou');
    assert.equal(result.status, 502, flag); assert.equal(result.body.rows, undefined);
  }
});
