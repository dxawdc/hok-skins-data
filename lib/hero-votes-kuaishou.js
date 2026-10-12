'use strict';

const VOTE_ID = 'v_HZQHiKhZ';
const SOURCE_URL = 'https://ppg.viviv.com/doodle/tslqAYIR.html';
const PAGE_SIZE = 100;

async function collectKuaishou({ fetchImpl, now, timeoutMs, ttl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date(now()).toISOString();
  try {
    const rows = [];
    let total;
    let previousId = Infinity;
    for (let page = 1; page <= 10; page++) {
      // 最新选项顺序按 ID 降序，避免随机顺序或票数变化导致跨页漏项。
      const response = await fetchImpl('https://ppg.viviv.com/rest/doodle/block/activity/auth/vote/list', {
        method: 'POST', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VOTE_ID, sort: 3, page, tags: '', title: '', count: PAGE_SIZE }),
      });
      if (!response.ok) throw new Error('快手活动接口暂时不可用');
      const body = await response.json();
      const data = body.data;
      if (body.result !== 1 || !data || data.token !== VOTE_ID ||
          !Number.isSafeInteger(data.totalCount) || data.totalCount < 1 || data.totalCount > PAGE_SIZE * 10 ||
          !Array.isArray(data.items)) throw new Error('快手活动榜单格式发生变化');
      if (page === 1) total = data.totalCount;
      if (data.totalCount !== total || data.items.length !== Math.min(PAGE_SIZE, total - rows.length)) {
        throw new Error('快手活动分页不完整');
      }
      for (const option of data.items) {
        if (!option || !Number.isSafeInteger(option.id) || option.id < 1 || option.id >= previousId ||
            typeof option.title !== 'string' || !option.title.trim() ||
            !Number.isSafeInteger(option.voteCount) || option.voteCount < 0) {
          throw new Error('快手活动顺序或票数格式异常');
        }
        previousId = option.id;
        rows.push({ id: String(option.id), name: option.title.trim(), role: '', votes: option.voteCount });
      }
      if (rows.length === total) break;
    }
    if (rows.length !== total || new Set(rows.map(row => row.name)).size !== total) {
      throw new Error('快手活动英雄重复或缺失');
    }
    rows.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      platform: 'kuaishou', activityId: VOTE_ID, roleSource: 'site',
      source: { name: '快手王者年度人气英雄投票', url: SOURCE_URL },
      startedAt, fetchedAt: new Date(now()).toISOString(), cacheSeconds: ttl / 1000,
      activityStatus: '', total, rows,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { collectKuaishou, VOTE_ID };
