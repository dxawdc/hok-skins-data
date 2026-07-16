# 王者荣耀皮肤展示项目（网页版）

这是公开仓库，提供网页版公开展示页、后台管理页，以及部署在 Vercel 的公开/后台 API。小程序版本位于同级目录 `../miniprogram`，两个目录是独立 Git 仓库。

## 项目结构

- `index.html`：公开展示页，读取 `/api/skins`、`/api/heroes`、`/api/resources`。
- `admin.html`：后台管理页，登录后调用 `/api/admin/*`。
- `api/skins.js`：公开皮肤接口，支持 `limit` 和 `offset` 查询参数。
- `api/heroes.js`：公开英雄接口。
- `api/resources.js`：公开资源图鉴接口。
- `api/user.js`：微信小程序登录、用户头像资料与已拥有/关注标记同步接口。
- `api/admin.js`：后台管理 API，包含登录、用户、皮肤、英雄、资源、图片上传和操作日志。
- `vercel.json`：Vercel 路由与 CORS 配置。
- `docs/ARCHITECTURE.md`：架构、数据流、部署和仓库边界说明。
- `01_*.sql` 到 `08_*.sql`：历史数据库建表/迁移脚本，应以线上真实 schema 为准。
- `02_import_data.py`：历史数据导入脚本。
- `maintenance.html`：维护页备用页面。

## 本地检查

```bash
npm install
npm run check
```

`npm run check` 会对 `api/admin.js`、`api/skins.js`、`api/heroes.js`、`api/resources.js` 做 Node.js 语法检查。

## 环境变量

部署到 Vercel 时需要配置：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `JWT_SECRET`
- `WECHAT_MINIPROGRAM_APP_ID`（未配置时使用代码中的当前小程序 AppID）
- `WECHAT_MINIPROGRAM_APP_SECRET`
- `MINIPROGRAM_SESSION_TTL_DAYS`（可选，默认 30，范围 1–90）

公开接口代码允许读取 `SUPABASE_ANON_KEY` 作为兜底，但后台管理接口必须使用 `SUPABASE_SERVICE_KEY`。

`WECHAT_MINIPROGRAM_APP_SECRET` 仅配置在服务端，用于将 `wx.login` 返回的临时 code 换取 OpenID；绝不能写入小程序源码。小程序会话使用服务端生成的随机 opaque token，数据库只保存 SHA-256 哈希，不再需要 JWT 密钥。

## 小程序用户同步部署

当前小程序登录/同步功能尚未上线，部署 v2 前执行破坏性迁移 `14_rebuild_miniprogram_auth_sync.sql`。它会清空测试用户、会话和收藏数据，创建可撤销会话、带 revision/幂等收据的收藏同步表与私有头像桶。必须先完成迁移再部署 `api/user.js`。

新头像只保存在私有 `miniprogram-avatars` 桶中，接口按需返回一小时有效的签名 URL 及 `avatarExpiresAt`。旧 `user-avatars` 测试桶需通过 Storage API 清空后删除。

资料响应中的 `nickname` 可直接展示；`hasNickname` 明确区分用户填写的昵称与“收藏用户”占位文案，`hasAvatar` 则表示服务端是否保存了真实头像。客户端不得把占位资料回写为用户授权资料。

## 数据与图片

公开展示页、小程序和后台都围绕同一套 Supabase 数据。图片存储在 Supabase Storage，并通过 `https://skinsdata.top/img` 做 CDN 地址转换。

当前公开接口：

- `https://skinsdata.top/api/skins`
- `https://skinsdata.top/api/heroes`
- `https://skinsdata.top/api/resources`

## 仓库同步

网页版是公开 GitHub 仓库，常规流程：

```bash
git status --short
npm run check
git add .
git commit -m "..."
git push origin main
```

提交备注统一使用中文，简洁说明本次变更内容，例如：

```bash
git commit -m "修复小程序元流套装展示"
```

小程序版是独立私有仓库，不要把小程序源码复制或提交到本仓库。

## 常见问题

**后台修改数据后，前台什么时候生效？**

保存后数据库立即更新；公开页和小程序会在下次请求或本地缓存过期后读取新数据。Vercel/CDN 缓存可能造成短时间延迟。

**误操作能回滚吗？**

后台修改会写入操作日志，可以根据日志手动还原。数据库级恢复应以 Supabase 项目当前备份能力为准。

**图片怎么更新？**

在后台对应皮肤、英雄或资源的编辑表单中重新上传并保存。
