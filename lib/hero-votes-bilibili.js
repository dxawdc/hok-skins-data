'use strict';

const VOTE_ID = '23ERAmwloghv9uc00';
const GROUP_ID = '24ERA2wloghvqw600';
const SOURCE_URL = 'https://www.bilibili.com/blackboard/era/dNS5HFYbtej7HKqX.html';
const PAGE_SIZE = 50;

async function collectBilibili({ fetchImpl, now, timeoutMs, ttl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date(now()).toISOString();
  try {
    const rows = [];
    let version = '';
    let total;
    let first;
    for (let page = 1; page <= 10; page++) {
      const url = new URL('https://api.bilibili.com/x/activity_components/vote_new/rank');
      url.search = new URLSearchParams({ vote_id: VOTE_ID, group_id: GROUP_ID,
        pn: String(page), ps: String(PAGE_SIZE), type: '0', random_version: version }).toString();
      const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('B 站活动接口暂时不可用');
      const body = await response.json();
      const data = body.data;
      if (body.code !== 0 || !data || data.vote_id !== VOTE_ID || data.group_id !== GROUP_ID ||
          data.vote_display !== true || !data.page || data.page.page_num !== page || data.page.page_size !== PAGE_SIZE ||
          !Number.isSafeInteger(data.page.total) || data.page.total < 1 || data.page.total > PAGE_SIZE * 10 ||
          !Array.isArray(data.items) || typeof data.random_version !== 'string' || !data.random_version) {
        throw new Error('B 站活动榜单格式发生变化');
      }
      if (page === 1) { total = data.page.total; version = data.random_version; first = data; }
      // 随机顺序分页必须沿用同一版本，避免跨页漏英雄或重复。
      if (data.page.total !== total || data.random_version !== version ||
          data.items.length !== Math.min(PAGE_SIZE, total - rows.length) || data.page.num !== data.items.length) {
        throw new Error('B 站活动分页不完整');
      }
      for (const option of data.items) {
        const name = option.item && option.item.title;
        if (typeof option.item_id !== 'string' || !option.item_id || typeof name !== 'string' || !name.trim() ||
            !Number.isSafeInteger(option.vote) || option.vote < 0) throw new Error('B 站活动票数格式异常');
        rows.push({ id: option.item_id, name: name.trim(), role: '', votes: option.vote });
      }
      if (rows.length === total) break;
    }
    if (rows.length !== total || new Set(rows.map(row => row.id)).size !== total || new Set(rows.map(row => row.name)).size !== total) {
      throw new Error('B 站活动英雄重复或缺失');
    }
    rows.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      platform: 'bilibili', activityId: VOTE_ID,
      source: { name: 'B站王者年度人气英雄投票', url: SOURCE_URL },
      startedAt, fetchedAt: new Date(now()).toISOString(), cacheSeconds: ttl / 1000,
      roleSource: 'site',
      activityStatus: Number.isFinite(first.etime) && now() >= first.etime * 1000 ? 'ENDED' : 'ONLINE',
      total, rows,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { collectBilibili, VOTE_ID, GROUP_ID };
