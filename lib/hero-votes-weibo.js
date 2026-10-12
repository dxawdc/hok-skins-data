'use strict';

const SOURCE_URL = 'https://m.weibo.cn/c/wbox?id=c0p9sg9tw9&page=pages/recommendanime/mainpage&activity_id=59';
const PROVIDER_URL = 'https://pvp.91m.top/tools/5acd9';
// 转供接口不提供总数字段，按本次活动已核验的完整名单数量校验；变更时重新核验。
const EXPECTED_TOTAL = 127;

async function collectWeibo({ fetchImpl, now, timeoutMs, ttl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date(now()).toISOString();
  try {
    const url = new URL('https://api.91m.top/hero/app');
    url.search = new URLSearchParams({ type: 'getRanking', aid: '-1', bid: '0', cid: '0', did: '0',
      platform: 'wb', lang: 'zh-CN', ref: '', host: 'pvp.91m.top', gameType: 'wzry' }).toString();
    const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('微博转供接口暂时不可用');
    const body = await response.json();
    const result = body.data && body.data.result;
    if (!body.status || body.status.code !== 200 || !result || result.platform !== 'wb' ||
        !Array.isArray(result.rows) || result.rows.length !== EXPECTED_TOTAL || typeof result.content !== 'string') {
      throw new Error('微博转供榜单不完整');
    }
    // 仅提取更新时间文本，不向客户端转发或渲染第三方 HTML。
    const match = result.content.match(/最后更新时间\s*[:：]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?=<|\s|$)/);
    if (!match) throw new Error('微博来源更新时间缺失');
    const sourceUpdatedAt = match[1].replace(' ', 'T') + ':00+08:00';
    const sourceTime = Date.parse(sourceUpdatedAt);
    const normalized = new Date(sourceTime + 8 * 3600000);
    if (!Number.isFinite(sourceTime) || normalized.toISOString().slice(0, 16).replace('T', ' ') !== match[1] ||
        sourceTime > now() + 60000 || now() - sourceTime >= 24 * 3600000) {
      throw new Error('微博来源时间异常或已过期');
    }
    const rows = result.rows.map(item => {
      if (!item || !Number.isSafeInteger(item.heroId) || item.heroId < 1 ||
          typeof item.heroName !== 'string' || !item.heroName.trim() ||
          typeof item.allVoteNum !== 'number' || !Number.isFinite(item.allVoteNum) || item.allVoteNum < 0) {
        throw new Error('微博转供票数格式异常');
      }
      const votes = Math.round(item.allVoteNum * 10000);
      if (!Number.isSafeInteger(votes)) throw new Error('微博转供票数超出范围');
      return { id: String(item.heroId), name: item.heroName.trim(), role: '', votes, approximate: true };
    });
    if (new Set(rows.map(row => row.id)).size !== EXPECTED_TOTAL || new Set(rows.map(row => row.name)).size !== EXPECTED_TOTAL) {
      throw new Error('微博转供英雄重复');
    }
    rows.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      platform: 'weibo', activityId: '59', roleSource: 'site',
      source: { name: '微博年度人气英雄票选', url: SOURCE_URL,
        provider: { name: '苏苏的荣耀助手', url: PROVIDER_URL } },
      sourceUpdatedAt, approximate: true,
      startedAt, fetchedAt: new Date(now()).toISOString(), cacheSeconds: ttl / 1000,
      activityStatus: '', total: rows.length, rows,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { collectWeibo, EXPECTED_TOTAL };
