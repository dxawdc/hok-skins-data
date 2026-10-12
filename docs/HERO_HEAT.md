# 英雄热度接口

`GET /api/hero-votes?platform=xhs|bilibili|kuaishou` 为小程序提供各平台王者荣耀活动投票数据。不传 `platform` 时默认小红书，兼容原客户端。只允许读取固定活动，不接收任意上游地址，不需要登录态、新环境变量、数据库迁移或定时任务。

| 平台 | 活动 | 接入状态 |
| --- | --- | --- |
| 小红书 `xhs` | `7694268422240177551` | 已接通，职业使用源站活动分组 |
| B站 `bilibili` | `23ERAmwloghv9uc00`，组 `24ERA2wloghvqw600` | 已接通，职业与分路关联本站英雄库 |
| 快手 `kuaishou` | `v_HZQHiKhZ` | 已接通，精确整数票数；职业与分路关联本站英雄库 |

不支持的平台返回 400；任一平台数据异常时不伪造零票。各平台独立展示，不合并票数。

## 数据流程

小红书首次访问读取活动基础信息，再分批读取刺客、法师、辅助、射手、坦克、战士六组投票选项；有下一页时继续读取。每批并发两组。

B站读取活动页实际使用的 `/x/activity_components/vote_new/rank`，每页 50 条，按源站总数读取后续页，沿用第一页的 `random_version`，避免随机顺序改变导致缺项。不携带 Cookie、CSRF 或账号凭据。活动链接：https://www.bilibili.com/blackboard/era/dNS5HFYbtej7HKqX.html 。

快手读取活动页的 `/rest/doodle/block/activity/auth/vote/list`，固定活动 `v_HZQHiKhZ`，匿名 POST 仅查询榜单。每页最多 100 条，使用组件支持的最新选项顺序（`sort: 3`），核对 ID 严格降序、总数、跨页唯一性和整数票数。默认顺序可能随机，不能直接依赖默认顺序分页。活动链接：https://ppg.viviv.com/doodle/tslqAYIR.html 。

每个平台整轮限时 9 秒。全部成功且分类、票数、ID、分页与重复项校验通过后发布完整快照。任一页或分组失败不发布部分榜单。

返回字段：

- `activityId`：源站活动 ID，保持字符串避免大整数精度丢失。
- `platform`：平台标识；`roleSource` 为 `activity`（源站分组）或 `site`（客户端关联本站资料）。
- `source`：活动来源名称和原始链接。
- `startedAt` / `fetchedAt`：本轮拉取开始、完成时间，UTC ISO 字符串。不同分类在一个短时间窗口内读取，不是源站原子快照。
- `cacheSeconds`：正常缓存时长 300 秒。
- `activityStatus`：源站活动状态原值。
- `total` / `rows`：投票选项数量及全部英雄。
- 每条英雄包括 `id`、`name`、`role`、`votes`。B站、快手没有职业分组，`role` 为空，由小程序关联本站资料并支持多职业筛选。小红书另外含 `tabId`、`sourceRank`，后者是源站职业分类排名；小程序全榜及分路排名自行按票数计算，同票并列。
- `stale` / `warning`：是否因刷新失败返回旧数据及提示。

## 缓存与故障

内存缓存、同实例请求合并、失败退避和客户端缓存均按平台隔离。Vercel CDN 通过带平台查询参数的 URL 与 `s-maxage` 共享完整响应。CDN 使用快照的剩余有效秒数，不在命中内存缓存后再延长五分钟。浏览器使用 `max-age=0`；客户端缓存也按 `fetchedAt` 判断有效期。筛选和排序在小程序本地完成。切换平台保留筛选条件，旧平台的晚到响应不会覆盖新平台榜单。

刷新失败时，实例内存在 24 小时以内的成功快照就返回 `stale: true`，保留原时间并禁止 CDN 缓存此失败响应；没有可用快照时返回 502。失败后退避 30 秒。小程序也保留最近成功数据作为网络异常兜底，超过一天不再展示。

Serverless 实例重启或扩容后内存缓存可能丢失，跨实例不保证只有一次上游请求。无持久化意味着首次访问且源站异常时会显示错误状态；此方案不提供历史曲线、票数增量或永久快照。

## 发布与验证

1. 部署 `api/hero-votes.js`、`lib/hero-votes-bilibili.js`、`lib/hero-votes-kuaishou.js` 及现有 `vercel.json` 路由到 Vercel。部署环境需能访问 `edith.xiaohongshu.com` 、`api.bilibili.com` 、`ppg.viviv.com`，本机验证不等同于云端连通性。
2. 分别验证 `/api/hero-votes?platform=xhs` 、`/api/hero-votes?platform=bilibili` 、`/api/hero-votes?platform=kuaishou` 返回 JSON、正确平台、完整榜单、真实 `fetchedAt` 和正常缓存标记。连续请求应在有效期内保留时间，过期后再更新。
3. 小程序运行 `node --test tests/hero-heat.test.js` 后用微信开发者工具编译、预览和真机检查。仍仅请求 `https://www.skinsdata.top`，无需新增源平台 request 域名。

后端检查沿用 `npm run check`，其中自动包含 `test/hero-votes.test.js`。覆盖并发合并、缓存时间、分页、数据不完整、源站失败退避、超时与旧数据过期。

2026-10-12 本机真实请求验证：127 位英雄，六组数量分别为刺客 17、法师 29、辅助 21、射手 20、坦克 9、战士 31。这是验证时的观测值，代码未将英雄数量硬编码。

来源为活动页面使用的读取接口，不是有稳定性承诺的公开开发者 API；活动或接口变化时可能需要更新适配。

2026-10-12 B站本机验证：127 位英雄，3 页，ID 和名称均无重复，全部关联到本站英雄职业、分路资料。

2026-10-12 快手本机核验：两页 100 + 27 条，共 127 位唯一英雄，返回 `voteCount` 精确整数；不使用登录 Cookie 或用户账号凭据。
