'use strict';

const { collectBilibili } = require('../lib/hero-votes-bilibili');

const VOTE_ID = '7694268422240177551';
const SOURCE_URL = 'https://ditto.xiaohongshu.net/ditto/vincent/8c87296afbbb4b19bd8d9798c4f1d3e0/dynpath96403b2c?fullscreen=true&resource_instance_id=330367&naviHidden=yes&source=share&countryCode=CN&lang=zh_cn&instance_id=8c87296afbbb4b19bd8d9798c4f1d3e0&page_instance=2683';
const UPSTREAM = 'https://edith.xiaohongshu.com/api/sns/v1/activity_platform/vote/';
const ROLES = ['刺客', '法师', '辅助', '射手', '坦克', '战士'];
const TTL = 5 * 60 * 1000;
const STALE_TTL = 24 * 60 * 60 * 1000;

// 缓存按实例复用；CDN 共享完整响应，不创建数据库表或定时任务。
function createHandler({ fetchImpl = (...args) => fetch(...args), now = Date.now, timeoutMs = 9000 } = {}) {
  const states = new Map(['xhs', 'bilibili'].map(platform => [platform, { snapshot: null, pending: null, retryAfter: 0 }]));

  async function collect() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = new Date(now()).toISOString();
    async function read(path, params) {
      const url = new URL(path, UPSTREAM);
      Object.entries({ vote_id: VOTE_ID, ...params }).forEach(([key, value]) => url.searchParams.set(key, value));
      const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('活动接口暂时不可用');
      const body = await response.json();
      if (body.success !== true || body.code !== 0 || !body.data) throw new Error('活动数据读取失败');
      return body.data;
    }
    try {
      const base = await read('query_vote_base_info', { source: 'share', tab_order_type: '2' });
      const tabs = base.tabs;
      if (base.vote_id !== VOTE_ID || !Array.isArray(tabs) || tabs.length !== ROLES.length ||
          new Set(tabs.map(tab => tab.tab_id)).size !== ROLES.length ||
          !ROLES.every(role => tabs.some(tab => tab.tab_name === role)) ||
          tabs.some(tab => typeof tab.tab_id !== 'string' || !/^\d+$/.test(tab.tab_id))) {
        throw new Error('活动分类发生变化，暂缓更新');
      }
      const rows = [];
      // 每批只请求两组，减少对源站的瞬时请求。
      async function readTab(tab) {
        const result = [];
        const cursors = new Set();
        let cursor = '';
        for (let page = 0; page < 10; page++) {
          const data = await read('query_vote_options_by_tab', {
            tab_id: tab.tab_id, page_size: '100', sort_type: '1', ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(data.options) || !data.options.length || typeof data.has_more !== 'boolean') {
            throw new Error('活动榜单不完整，暂缓更新');
          }
          for (const option of data.options) {
            const name = option.custom_option && option.custom_option.name;
            if (typeof option.id !== 'string' || !/^\d+$/.test(option.id) || option.tab_id !== tab.tab_id ||
                typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(option.score) || option.score < 0 ||
                !Number.isSafeInteger(option.rank) || option.rank < 1) {
              throw new Error('活动票数格式异常，暂缓更新');
            }
            result.push({
              id: option.id, name: name.trim(), role: tab.tab_name, tabId: tab.tab_id,
              votes: option.score, sourceRank: option.rank,
            });
          }
          if (!data.has_more) return result;
          if (typeof data.next_cursor !== 'string' || !data.next_cursor || cursors.has(data.next_cursor)) {
            throw new Error('活动分页异常，暂缓更新');
          }
          cursor = data.next_cursor;
          cursors.add(cursor);
        }
        throw new Error('活动分页超出预期，暂缓更新');
      }
      for (let index = 0; index < tabs.length; index += 2) {
        const groups = await Promise.all(tabs.slice(index, index + 2).map(readTab));
        rows.push(...groups.flat());
      }
      if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.name)).size !== rows.length) {
        throw new Error('活动英雄重复，暂缓更新');
      }
      rows.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'zh-CN'));
      return {
        platform: 'xhs', activityId: VOTE_ID, roleSource: 'activity',
        source: { name: '小红书王者荣耀活动英雄投票', url: SOURCE_URL },
        startedAt, fetchedAt: new Date(now()).toISOString(), cacheSeconds: TTL / 1000,
        activityStatus: typeof base.play_rule_status === 'string' ? base.play_rule_status : '',
        total: rows.length, rows,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      res.status(405).json({ error: '仅支持读取榜单' }); return;
    }
    const platform = req.query && req.query.platform !== undefined ? req.query.platform : 'xhs';
    if (!states.has(platform)) {
      res.status(400).json({ error: '暂不支持该投票平台' }); return;
    }
    const state = states.get(platform);
    try {
      if (!state.snapshot || now() - Date.parse(state.snapshot.fetchedAt) >= TTL) {
        if (now() < state.retryAfter) throw new Error('活动接口稍后重试');
        if (!state.pending) {
          const collectPlatform = platform === 'xhs' ? collect : () => collectBilibili({ fetchImpl, now, timeoutMs, ttl: TTL });
          state.pending = collectPlatform().then(data => { state.snapshot = data; state.retryAfter = 0; })
            .catch(error => { state.retryAfter = now() + 30 * 1000; throw error; })
            .finally(() => { state.pending = null; });
        }
        await state.pending;
      }
      const snapshot = state.snapshot;
      // 使用剩余有效期，避免内存缓存再次进入 CDN 时把五分钟延长。
      const remaining = Math.max(0, Math.floor((TTL - (now() - Date.parse(snapshot.fetchedAt))) / 1000));
      res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${remaining}, must-revalidate`);
      res.status(200).json({ ...snapshot, stale: false });
    } catch (error) {
      const snapshot = state.snapshot;
      if (snapshot && now() - Date.parse(snapshot.fetchedAt) < STALE_TTL) {
        res.status(200).json({ ...snapshot, stale: true, warning: '最新票数暂时获取失败，正在展示上次成功数据' });
      } else {
        res.status(502).json({ error: '英雄热度暂时无法更新，请稍后重试' });
      }
    }
  };
}

module.exports = createHandler();
module.exports._private = { createHandler, TTL, STALE_TTL, VOTE_ID, ROLES };
