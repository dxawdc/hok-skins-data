# 公开数据与图片缓存

部署目标为已有的 `wzry-img-proxy`，域名为 `skinsdata.top` 和 `www.skinsdata.top`。此目录不负责 Vercel 网页或微信小程序发布。

## 请求路径

未缓存的默认入口先规范化 URL，再通过 `ctx.exports.PublicCache.fetch()` 进入原生 Workers Cache。原生缓存负责分层填充与并发请求合并；它与 zone 的 Tiered Cache 开关、旧 `caches.default` 是不同机制。

- 仅缓存 GET/HEAD 的 `/api/skins`、`/api/heroes`、`/api/resources` 和公开 `/img/` 图片。
- 两个域名、无意义的版本/跟踪参数共用缓存。皮肤分页保留 `limit`/`offset`；手动刷新按分钟合并。
- 路由末尾 `*` 覆盖查询参数，但代码对 API 路径做精确匹配。后台、登录、收藏等接口不进入共享缓存。
- 图片尺寸限定为 60、80、120、160、240、320、480、640、960、1280，质量按尺寸归一化。WebP 与原格式分开缓存。
- 公开 API 仍回源现有 Vercel 接口，保留皮肤档案、系列和全部资源类别。`global_fetch_private_origin` 保证同 zone 回源不会重新进入 Worker 路由。
- 皮肤边缘 TTL 为 30 分钟，英雄/资源为 2 小时；浏览器 TTL 为 60 秒。边缘响应使用 `Cloudflare-CDN-Cache-Control: max-age=..., stale-if-error=86400`，避免 `s-maxage` 禁止返回旧缓存。
- 新图片缓存 30 天，故障时允许使用旧缓存 7 天。已有旧节点图片缓存仍可读取，不执行全站清缓存。
- 配额错误返回 503、`EGRESS_QUOTA_EXCEEDED` 和 `no-store`，并在执行节点设置 60 秒短路，减少重复失败回源。其他错误不伪装成成功空数组。
- 跨版本保留公开缓存。未来变更公开数据结构时，需要规划缓存失效，不能仅靠升级 Worker 版本清理旧结果。

缓存不是永久备份；从未缓存的数据和图片，在源站受限时仍不可用。本方案未开通 R2、未调整 Supabase 付费套餐。

## 检查与部署

在仓库根目录执行：

```powershell
npm run check
npx --yes wrangler@4.151.0 deploy --dry-run --config cloudflare/wrangler.jsonc
```

获准部署后，可使用已授权的 Cloudflare MCP 上传版本并部署，或使用 Wrangler。MCP multipart 元数据使用 `cache_options`，对应 Wrangler 的 `cache`；同时发送 `exports` 配置，保证默认入口不缓存、`PublicCache` 缓存。两个 JavaScript 模块必须一同上传。版本上传与生产部署是两个步骤，路由单独核对。

验收应检查两个域名和带参数接口、缓存命中、错误不缓存、登录接口隔离，并读取生产部署 ID。Supabase 额度恢复后，还需确认三个公开接口均为 200 数组，并连续请求验证 HIT 和数据结构。

## 2026-10-15 部署记录

- 版本：`45e58450-1456-4e67-b6fe-8c91d430780d`
- 部署：`e24ed8f9-7504-4a61-94cb-4bc7cc64ec17`，100% 流量。
- 原版本：`3c0c3ed5-4888-4406-a6ad-6463d782630c`。
- 主域名 3 条精确 API 路由改为末尾带 `*`，增加 `www` 的 4 条对应路由；原主域名图片路由保留。
- 公网验证：旧 120px 图片返回 200，后续主域名及 `www` 归一化请求均为 HIT、4652 bytes；用户资料接口仍为 401、no-store，且无 Worker 构建标识。
- 三个公开 API 均正确识别尚未解除的 Supabase `exceed_egress_quota`，返回 503、no-store。此次部署没有恢复源站额度，也不能据此宣称完整数据已恢复。

部署前的脱敏备份和验收截图保存于工作区 `logs/cache-optimization-20261015/`，不提交私有凭据。

## 2026-10-18 图片回源修复

旧版 `/legacy` 的部分图片返回 `502 INVALID_UPSTREAM`，但相同 Supabase 原图及缩略图返回 `200 image/*`。源站公开图片响应带有 Cloudflare `__cf_bm` Cookie，原来的全量 `Set-Cookie` 拒绝逻辑误伤了图片缓存未命中的请求。

`2026-10-18-image-cookie-fix` 仅允许公开图片回源携带 `__cf_bm`，输出仍使用白名单响应头，不向客户端或缓存转发 Cookie。API Cookie、其他图片 Cookie、非图片响应和非 200 状态继续被拒绝。新增回归测试覆盖原图、缩略图、混合 Cookie 及错误内容；本地检查与 Worker 打包 dry-run 通过。上线需单独部署已有 `wzry-img-proxy`，仅推送 Vercel 网页代码不会更新 Worker。

参考：[Cloudflare Cookie 说明](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)。

本次修复发布前的生产版本为 `45e58450-1456-4e67-b6fe-8c91d430780d`，部署为 `e24ed8f9-7504-4a61-94cb-4bc7cc64ec17`。修复不改变八条路由及缓存配置；如需撤销本次修复，将该版本恢复为 100% 即可。发布状态与部署 ID 以实际发布验收记录为准。

## 回滚方式

通过 Workers Deployments API 将上述原版本设为 100%。若同时恢复旧路由，应把主域名三条 API 路由改回精确路径，并删除本次新加的四条 `www` 路由。旧版本的字段映射较早，回滚会恢复原来的路由遗漏和数据结构问题；不能只回滚代码却保留扩大后的 API 路由而不验证。不要使用脱敏源码覆盖线上旧版本，也不要全站 purge。

参考：[Workers Cache 配置](https://developers.cloudflare.com/workers/cache/configuration/)、[入口间缓存](https://developers.cloudflare.com/workers/cache/examples/)。
