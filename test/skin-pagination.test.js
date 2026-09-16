'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const publicSkins = require('../api/skins')._private.fetchAllSkinRows;
const adminSkins = require('../api/admin')._private.fetchAllSkinRows;
const analytics = require('../api/analytics')._private.fetchAll;

// 构造同一天跨过第 1000 条边界的记录，模拟数据库对相同排序值的不确定顺序。
function fixture(size = 1007) {
  return Array.from({ length: size }, (_, i) => ({ id: i + 1, date: i < 10 ? '2022-01-31' : '2022-02-01', hero: '测试英雄', name: `测试皮肤${i}`, type: i % 2 ? '首发' : '返场' }));
}

function mockClient(rows, { fallback = false } = {}) {
  const calls = [];
  return { calls, from() {
    let select, orders = [];
    return {
      select(value) { select = value; return this; },
      order(column, options) { orders.push([column, options]); return this; },
      async range(from, to) {
        calls.push({ select, from, to });
        if (fallback && select.includes('skin_profile_series') && from >= 1000) return { error: new Error('模拟第二页关联字段不可用') };
        // 未用 ID 排序时，不同页的同日记录顺序可能相反。
        const ordered = [...rows].sort((a, b) => {
          for (const [key, opts] of orders) {
            if (a[key] == null || b[key] == null) {
              if (a[key] == null && b[key] == null) continue;
              return (a[key] == null ? 1 : -1) * (opts.nullsFirst === false ? 1 : -1);
            }
            const delta = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            if (delta) return delta * (opts.ascending ? 1 : -1);
          }
          return (from === 0 ? 1 : -1) * (a.id - b.id);
        });
        return { data: ordered.slice(from, to + 1), error: null };
      },
    };
  } };
}

const readers = [
  ['公开皮肤接口', publicSkins],
  ['后台全量读取', adminSkins],
  ['分析导出接口', client => analytics(client, { table: 'skins', select: '*' })],
];

for (const [name, read] of readers) {
  test(`${name}：同日跨页没有重复或遗漏，首发和返场记录均保留`, async () => {
    const rows = fixture();
    rows.push({ id: 2000, date: null, type: '首发' });
    const client = mockClient(rows);
    const result = await read(client);
    assert.equal(result.length, rows.length);
    assert.equal(new Set(result.map(r => r.id)).size, rows.length);
    assert.deepEqual(result.map(r => r.id).sort((a, b) => a - b), rows.map(r => r.id).sort((a, b) => a - b));
    assert.equal(result.filter(r => r.type === '首发').length, rows.filter(r => r.type === '首发').length);
    assert.equal(result.at(-1).id, 2000, '空日期排在最后');
    assert.deepEqual(client.calls.map(c => [c.from, c.to]), [[0, 999], [1000, 1999]]);
  });
}

test('显式 limit/offset 分页与全量读取顺序相同', async () => {
  const client = mockClient(fixture());
  const full = await publicSkins(client);
  const left = await publicSkins(client, { limit: 1000, offset: 0 });
  const right = await publicSkins(client, { limit: 1000, offset: 1000 });
  assert.deepEqual([...left, ...right], full);
});

for (const [name, read] of readers.slice(0, 2)) {
  test(`${name}：第二页关联查询失败后，回退查询仍完整且不混入旧页`, async () => {
    const rows = fixture();
    const client = mockClient(rows, { fallback: true });
    const result = await read(client);
    assert.equal(result.length, rows.length);
    assert.equal(new Set(result.map(r => r.id)).size, rows.length);
    assert.deepEqual(client.calls.map(c => c.from), [0, 1000, 0, 1000]);
  });
}

test('恰好 1000 条时读取空尾页并结束；空表返回空数组', async () => {
  const client = mockClient(fixture(1000));
  assert.equal((await publicSkins(client)).length, 1000);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(await publicSkins(mockClient([])), []);
});
