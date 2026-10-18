# 小程序用户服务迁移

目标：`https://youtiao.fun/hokskins/api/user/*`。服务、数据库和存储仅属于独立 `hokskins` 项目。公开数据和图片已迁至同一站点，原 youtiao/GDN 服务保持不变。

## 数据切换

2026-10-18 16:34:27（北京时间）开放新站用户服务。最终源数据已冻结写入，导出并在目标事务内导入；逐字段规范化时间格式后比较 SHA-256：

| 表 | 行数 | 验证摘要 |
| --- | ---: | --- |
| miniprogram_users | 338 | `1eaffa3fea23f154acddaa65603a9d67a6efcb751227414f74b0a439d8765a1d` |
| miniprogram_sessions | 512 | `735c29a93818c9d34570eb05ce302e11cff022913085af93bd9289c05f072097` |
| miniprogram_skin_marks | 46,588 | `b7a1f6156e9765c8363524eccaff7f610ebd4ba693f04d5eb6a451956b228513` |
| miniprogram_mark_mutations | 29,267 | `849f4fde07c34a0628c1c7894ea9c196de01a752c98734a7fa40097179f78b9c` |

保留用户 ID、会话 token_hash、到期/撤销状态、收藏版本和幂等回执，未清空用户收藏。源站 64 个头像已复制并校验格式和大小，文件摘要保存在服务器私有迁移清单。以上数量为切换时快照，之后用户正常使用会改变数量。

`migrate-users.py` 仅操作四张用户表；默认导入演练后回滚，`--apply` 才提交。新服务启用标记存在时拒绝覆盖数据。导入临时关闭触发器以避免历史会话被裁剪、历史时间戳被重写，并预先校验用户外键及头像引用。

## 服务与兼容

- `prepare-user-service.py` 从校验过摘要的服务器副本生成适配，只改独立服务器、数据客户端和专用 Nginx 片段。JSON 与 multipart 由原用户 API 的有界解析器处理。
- `avatar-store.cjs` 将头像保存在 `/opt/hokskins/storage/private/miniprogram-avatars`，不进入公开图片目录。读链接绑定对象路径、用途及最长一小时有效期；不记录签名 URL 访问日志，响应禁止缓存。
- 上传上限保持 2 MB；仅 `/hokskins/api/user/profile/avatar` 的 Nginx 请求体上限放宽到 3 MB，包含 multipart 开销。
- 微信 AppID/AppSecret 在 `/etc/hokskins/service.env`（root、0600）。配置通过受保护的临时预览部署及接收方公钥加密迁移，未重置密钥；临时部署、远程分支、传输私钥及源服务凭证已删除。
- 原 `skinsdata.top` 和 `www.skinsdata.top` 的 `/api/user*` 由 Cloudflare 转发新站，严格限制路由/方法，只转发必要请求头，流式传输头像，禁止缓存，不跟随上游重定向。
- Worker 版本 `88333642-cd48-4657-894f-be67cee463d6`，部署 `e5092003-bd0f-4796-badb-2c7428552898`。公开图片/数据缓存逻辑保持原样。
- 旧 Supabase 的 service_role 已撤销用户/会话 INSERT、UPDATE、DELETE 及收藏变更 RPC EXECUTE，避免旧函数或在途请求继续写入第二份数据。导出回执临时 SELECT 权限已收回。源数据和头像保留。

## 验收与备份

68 项 Web/Worker/存储测试通过，Worker dry-run 构建通过。使用独立临时账号对新站、旧站 apex、旧站 www 分别验证鉴权、资料修改、收藏读写、重复回执、冲突、未修改版本、头像上传/读取、未签名访问拒绝、退出撤销；测试账号和头像随后清理。

GDN 首页、后台、健康接口、文章接口、域名校验文件的状态/摘要均与迁移前一致，服务 PID 保持 1902108，文章数保持 3,812；主 Nginx 站点配置摘要未变。只重启独立 hokskins-web，Nginx 平滑 reload。

备份 `/opt/hokskins/backups/users-20261018/` 包含迁移前数据库/应用/Nginx 片段及最终源数据 JSON（仅 root 可读）。本地操作证据位于 `D:/AI/Hok/logs/miniprogram-migration-20261018/`。

**切换后不要恢复旧数据库快照或直接解除源库写入限制。** 新用户写入已以新站为准，回退必须先停写、导出新站增量并迁回旧站核对。只回退应用代码时也必须保留这份用户数据库、私有头像和微信配置；旧兼容代理不能指向另一份可写用户库。
