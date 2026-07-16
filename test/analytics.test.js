'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COLUMNS,
  DICTIONARY,
  normalizeQuality,
  flattenHero,
  flattenSkin,
  flattenSpecial,
  flattenResource,
  parseFilters,
  applyFilters,
  buildMeta,
  csvEscape,
  toCsv,
  SPECIAL_RESOURCES,
} = require('../api/analytics')._private;

test('数据字典覆盖全部列，且列顺序稳定', () => {
  for (const col of COLUMNS) {
    assert.ok(DICTIONARY[col], `字段 ${col} 缺少数据字典说明`);
  }
  assert.equal(COLUMNS[0], 'category');
  assert.equal(COLUMNS[COLUMNS.length - 1], 'source_table');
});

test('伴生品质归一化为其他，其余保持原样', () => {
  assert.equal(normalizeQuality('伴生'), '其他');
  assert.equal(normalizeQuality('传说'), '传说');
  assert.equal(normalizeQuality(''), '');
  assert.equal(normalizeQuality(null), '');
});

test('英雄上线被拍平为首发事件并保留定位/分路', () => {
  const ev = flattenHero({
    id: 12, name: '李白', gender: '男', release_date: '2020-01-01',
    roles: ['刺客'], lanes: ['打野'], notes: '',
  });
  assert.equal(ev.category, 'hero');
  assert.equal(ev.event_id, 'hero-12');
  assert.equal(ev.release_type, '首发');
  assert.equal(ev.hero, '李白');
  assert.deepEqual(ev.roles, ['刺客']);
  assert.deepEqual(ev.lanes, ['打野']);
  assert.equal(ev.date, '2020-01-01');
});

test('皮肤事件优先取档案信息并按 sort_order 汇总系列', () => {
  const ev = flattenSkin({
    id: 5, name: '旧名', quality: '史诗', hero: '旧英雄', hero_id: 1,
    type: '返场', date: '2026-01-02', price: '288', obtain: '直购', notes: '',
    skin_profiles: {
      id: 99, name: '凤求凰', quality: '传说', hero: '刘备', hero_id: 2,
      tag: '', permanent: '是',
      skin_profile_series: [
        { series: { name: '典藏', sort_order: 2 } },
        { series: { name: '限定', sort_order: 1 } },
      ],
    },
  });
  assert.equal(ev.category, 'skin');
  assert.equal(ev.name, '凤求凰');
  assert.equal(ev.hero, '刘备');
  assert.equal(ev.hero_id, 2);
  assert.equal(ev.quality, '传说');
  assert.equal(ev.release_type, '返场');
  assert.equal(ev.permanent, '是');
  assert.deepEqual(ev.series, ['限定', '典藏']);
});

test('星传说等特殊资源经档案关联带出归属英雄', () => {
  const config = SPECIAL_RESOURCES.find(c => c.category === 'star_legend');
  const ev = flattenSpecial({
    id: 7, name: '星传说A', date: '2026-03-01', release_type: '首发',
    tag: '', obtain: '', price: '', permanent: '否',
    skin_profile: { id: 3, name: 'x', hero: '妲己', hero_id: 8 },
  }, config);
  assert.equal(ev.category, 'star_legend');
  assert.equal(ev.event_id, 'star_legend-7');
  assert.equal(ev.hero, '妲己');
  assert.equal(ev.source_table, 'star_legend_resources');
});

test('普通资源保留天幕/小兵为细分类型', () => {
  const ev = flattenResource({
    id: 2, name: '天幕A', type: '天幕', quality: '史诗',
    release_type: '返场', date: '2026-02-02', collab: '某IP',
  });
  assert.equal(ev.category, 'resource');
  assert.equal(ev.sub_type, '天幕');
  assert.equal(ev.collab, '某IP');
  assert.equal(ev.release_type, '返场');
});

test('过滤参数解析：默认与合法性校验', () => {
  assert.deepEqual(parseFilters({}), {
    format: 'json', categories: [], releaseType: null, hero: null,
    from: null, to: null, includeHeroes: true,
  });
  const f = parseFilters({
    format: 'csv', category: 'skin, star_legend', release_type: '返场',
    hero: ' 李白 ', from: '2026-01-01', to: 'bad-date', include_heroes: 'false',
  });
  assert.equal(f.format, 'csv');
  assert.deepEqual(f.categories, ['skin', 'star_legend']);
  assert.equal(f.releaseType, '返场');
  assert.equal(f.hero, '李白');
  assert.equal(f.from, '2026-01-01');
  assert.equal(f.to, null); // 非法日期被丢弃
  assert.equal(f.includeHeroes, false);
});

test('非法 release_type 被忽略', () => {
  assert.equal(parseFilters({ release_type: '限时' }).releaseType, null);
});

test('applyFilters 按类别/类型/英雄/日期区间筛选', () => {
  const events = [
    { category: 'skin', release_type: '首发', hero: '李白', name: '青莲剑仙', date: '2026-01-05' },
    { category: 'skin', release_type: '返场', hero: '妲己', name: '女仆', date: '2026-02-05' },
    { category: 'resource', release_type: '返场', hero: '', name: '天幕A', date: '2026-03-05' },
    { category: 'hero', release_type: '首发', hero: '李白', name: '李白', date: '2020-01-01' },
  ];
  assert.equal(applyFilters(events, parseFilters({ category: 'skin' })).length, 2);
  assert.equal(applyFilters(events, parseFilters({ release_type: '返场' })).length, 2);
  assert.equal(applyFilters(events, parseFilters({ hero: '李白' })).length, 2);
  const ranged = applyFilters(events, parseFilters({ from: '2026-02-01', to: '2026-02-28' }));
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0].name, '女仆');
});

test('buildMeta 统计类别、类型与日期区间', () => {
  const events = [
    { category: 'skin', release_type: '首发', date: '2026-01-05' },
    { category: 'skin', release_type: '返场', date: '2026-03-05' },
    { category: 'resource', release_type: '返场', date: '2026-02-05' },
  ];
  const meta = buildMeta(events, parseFilters({}));
  assert.equal(meta.total_events, 3);
  assert.deepEqual(meta.counts_by_category, { skin: 2, resource: 1 });
  assert.deepEqual(meta.counts_by_release_type, { 首发: 1, 返场: 2 });
  assert.deepEqual(meta.date_range, { from: '2026-01-05', to: '2026-03-05' });
});

test('CSV 转义处理逗号、引号、换行', () => {
  assert.equal(csvEscape('普通'), '普通');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('说"引号"'), '"说""引号"""');
  assert.equal(csvEscape('第一行\n第二行'), '"第一行\n第二行"');
  assert.equal(csvEscape(null), '');
});

test('toCsv 生成 BOM 表头，数组用竖线拼接', () => {
  const csv = toCsv([
    flattenHero({ id: 1, name: '李白', gender: '男', release_date: '2020-01-01', roles: ['刺客', '战士'], lanes: ['打野'] }),
  ]);
  assert.ok(csv.startsWith('﻿'), '应以 UTF-8 BOM 开头');
  const [header, firstRow] = csv.slice(1).split('\r\n');
  assert.equal(header, COLUMNS.join(','));
  assert.ok(firstRow.includes('刺客|战士'), '数组字段应以竖线拼接');
});
