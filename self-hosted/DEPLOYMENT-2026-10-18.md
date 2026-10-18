# 图片去重与迁移验收

生产地址：<https://youtiao.fun/hokskins/>。发布范围为 `/opt/hokskins` 独立副本、其专用 Nginx 图片片段及服务写权限；未修改旧站 Supabase 数据或源图片。

## 数据与图片

- 831 款皮肤，首发 831 条、返场 722 条，共 1,553 条记录。
- 677 条返场记录改为使用皮肤档案中的首发图片；SQL 验证记录数及非图片业务字段未变。
- 原引用图片 3,332 张，迁移去重后 2,002 张，减少 1,330 张重复资源。
- 迁移原图 348,637,086 字节；生成 8,104 张缩略图。全部原图与缩略图已解码校验，原图逐一记录 SHA-256。
- 公网检查 2,002 个图片地址，全部 HTTP 200 且由本地存储返回，无失败。
- 后台使用的本地存储适配器已验证上传、公开读取字节一致、删除后 404；未登录的图片上传 API 返回 401。未使用管理员账号执行完整界面上传操作。

## 页面与原服务

- 桌面皮肤页、资源列表与资源详情、390 × 844 手机皮肤页及搜索交互通过；已加载图片无裂图，来源均为 youtiao.fun，控制台无错误。
- 原首页、后台、健康接口、文章接口、域名验证文件的 HTTP 状态与响应摘要和迁移前一致。
- GDN 主服务 PID 保持 1902108，启动时间保持 2026-10-14 11:16:21 CST；文章数保持 3,812。
- `/etc/nginx/sites-enabled/gdn` 的 SHA-256 保持 `9b107b54590538460f54e13adef58eff5e4da314cf3944d121162dfecac5aee2`。
- Nginx 配置校验通过，使用平滑 reload；仅重启独立 `hokskins-web.service`。GDN、独立网页、独立数据及 Nginx 服务均为 active。
- 本地 `npm run check` 63 项测试通过；生成页面脚本及 Node/Python 文件语法检查通过。

## 证据与回滚

服务器备份位于 `/opt/hokskins/backups/images-20261018/`。图片清单、复制摘要、全量文件校验及公网检查位于 `/opt/hokskins/storage/migration/`。旧站图片保留作为迁移回退来源。

本地验收记录位于 `D:/AI/Hok/logs/hokskins-image-migration-20261018/`；桌面和手机截图位于 `D:/AI/Hok/output/playwright/hokskins-migrated-{desktop,mobile}.png`。回滚步骤见本目录 README。
