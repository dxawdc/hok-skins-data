# youtiao.fun/hokskins 独立图片存储

本目录仅用于现有 `/opt/hokskins` 独立站，不部署到 Vercel，也不修改 GDN 应用、数据库或 `/api/`、`/admin` 路由。

2026-10-18 新增公开接口缓存、图片版本缓存及刷新修复，详见 [优化与发布说明](OPTIMIZATION-2026-10-18.md)。这些本地改动需配套发布，不能从源码状态推断生产已更新。

## 图片与记录

- 原图：`/opt/hokskins/storage/public/originals/hokskins/img/{skin,tag,hero,resource}/...`。
- 缩略图：同一存储下 `public/thumbs/{60,80,120,160,200,320}/hokskins/img/...`。保持图片比例和格式，小于目标尺寸的原图直接复用；大图与未知尺寸回退原图。
- Nginx 仅在 `/hokskins/img/` 读取上述文件，图片不经过 Node API 的请求限流。新图片上传后返回带修改版本的本地 URL。
- `image-store.cjs` 适配现有后台的 Storage 上传/删除调用；只允许 `skin-images` 桶和四种资源目录，验证路径、体积、格式与解码结果。每个服务进程串行处理图片，限制队列长度。Python/Pillow 生成缩略图后才原子替换公开文件。
- API 将已知旧站图片地址转换为 `https://youtiao.fun/hokskins/img/`。数据库保留历史地址标识以兼容回滚；网页和后台实际请求本地文件，图片不再回源旧站。新上传的图片直接保存本地地址。
- 新站的后台已在新增、编辑返场时继承皮肤档案图片。`deduplicate-return-images.sql` 清理迁移前的历史冗余引用，以与首发一致的皮肤档案为准，不删除记录，也不改价格、日期等业务字段。

## 2026-10-18 迁移基线

独立副本包含 831 款皮肤、831 条首发和 722 条返场，共 1,553 条记录。本次统一 677 条返场记录的皮肤/标签图片引用，引用图片由 3,332 张减至 2,002 张（皮肤 831、标签 812、英雄 133、资源 226）。旧 Supabase 图片与旧站数据不删除。

`inventory-images.py --canonical` 可在迁移前生成去重后的候选清单；不带参数时检查全部现存引用。只有核实皮肤档案与首发图片一致后，才能使用候选清单。

备份：`/opt/hokskins/backups/images-20261018/`，包含独立站代码、原 Nginx 片段、systemd 单元、皮肤表数据及可精确恢复的图片字段。图片复制与 SHA-256/解码校验记录位于 `/opt/hokskins/storage/migration/`。去重前已复制的额外文件移到该目录的 `excluded-before-dedup/`，不公开提供。

## 发布与回滚

先按照 `D:/AI/GDN/docs/DEPLOYMENT_AND_REVIEW.md` 确认当前 youtiao 服务器。`prepare-site.py` 从人工检查并备份的独立站文件生成补丁，校验关键文件摘要，拒绝覆盖未知版本。代码、Nginx 片段、systemd 存储写权限必须配套发布。

1. 复制原图，验证完整清单，生成缩略图，再运行 `verify-images.py` 全量校验。
2. 数据去重先在临时表副本中演练，正式执行时由调用方包裹事务；SQL 内部检查记录数和非图片字段校验值。
3. `nginx-image-variants.conf` 安装到 `/etc/nginx/conf.d/`；`nginx-image-location.conf` 安装到 `/etc/nginx/snippets/hokskins-images.conf`，仅由现有 `hokskins.conf` 引用。
4. 将 `hokskins-storage.conf` 作为 `hokskins-web.service` 的 drop-in，并把独立存储归属设为 `hokskins:hokskins`。不改变 GDN 的写权限。
5. `nginx -t` 成功后平滑 reload，仅重启 `hokskins-web.service`；不要停止或重启 `gdn-server.service`。
6. 验收原图/缩略图、本地后台上传与删除、未授权上传拒绝、桌面和手机页面；比较 GDN 首页、后台、健康接口、文章接口、域名验证文件和服务 PID。

回滚时恢复备份中的独立 app 与 `hokskins.conf`，移除本次新增的 Nginx 图片片段、变量配置和 systemd drop-in，再检查 Nginx 并重启独立站。去重仅统一引用，回滚页面仍可访问首发图片；如需恢复原始图片字段，按备份 JSON 中的记录 ID 更新对应字段，勿清空或整体替换业务表。

本地检查：`npm run check`（Python/Pillow 依赖见根目录 `requirements.txt`）。图片迁移任务使用独立 systemd 临时单元，限制 CPU、内存和 IO 优先级；不与主站进程混用。

## 后续新增资源同步

先对比旧站与新站的英雄、皮肤档案、事件、套系、关联和个性资源表，仅补充缺失数据；不要覆盖新站的人工编辑，也不要重新引入返场独立图片。

`sync-new-skins.py` 接收经核对的 `skin_profiles` 与 `skins` JSON 导出，只支持新皮肤及其首发事件。默认在事务中演练后回滚，显式 `--apply` 才写入；已有 ID、关联错误或首发图片不一致会拒绝同步。正式写入前备份独立数据库并复制验证缺失图片，写入后重新生成图片清单及更新前台数据缓存版本。

独立后台 API 必须通过 `res.json` 返回数据，以使用服务器的本地图片地址转换。`prepare-admin.py` 生成该适配；`prepare-site.py` 同时修正后台刷新时的 `/me` 请求，使其携带登录令牌。旧站源文件不受这些适配影响。

2026-10-18 后续同步新增蚩奼「猞我其谁」与盾山「一塔千年」，新站现有 833 款皮肤、1,555 条记录、2,006 张引用图片。详见 `SYNC-2026-10-18.md`。
