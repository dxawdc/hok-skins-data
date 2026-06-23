# 王者荣耀皮肤展示项目架构说明

## 仓库边界

- `hok-skins-data`：网页版公开仓库，包含公开页面、后台页面、Vercel API 和数据库迁移脚本。
- `miniprogram`：微信小程序私有仓库，独立提交和推送，不并入公开仓库。

两个仓库共享线上 Supabase 数据和图片资源，但代码、发布流程和 Git 历史相互独立。

## 网页版组成

- `index.html`：公开展示页，使用浏览器本地缓存、筛选、统计和图表能力展示数据。
- `admin.html`：后台管理页，通过 JWT 调用 `/api/admin/*`。
- `api/skins.js`：公开皮肤接口，读取 `skins`、`skin_profiles` 和 `skin_profile_series`。
- `api/heroes.js`：公开英雄接口，读取可用英雄。
- `api/resources.js`：公开资源接口，读取可用资源。
- `api/admin.js`：Vercel Serverless Function，负责后台登录、用户、皮肤、英雄、系列、资源、图片上传和审计日志。
- `vercel.json`：Vercel 路由与 CORS 配置。
- `01_*.sql` 到 `08_*.sql`：历史 schema 与迁移脚本，不应直接等同于完整生产 schema。

## 数据流

公开展示页和小程序读取：

- `/api/skins`
- `/api/heroes`
- `/api/resources`

后台管理页读取：

- `/api/admin/login`
- `/api/admin/me`
- `/api/admin/users`
- `/api/admin/skin-profiles`
- `/api/admin/series`
- `/api/admin/skins`
- `/api/admin/heroes`
- `/api/admin/resources`
- `/api/admin/special-resources`
- `/api/admin/images`
- `/api/admin/logs`

图片存储使用 Supabase Storage 公开 bucket，并通过 `https://skinsdata.top/img` 做 CDN 地址转换。

## 部署

网页版部署目标是 Vercel。部署前需要配置：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `JWT_SECRET`

公开接口设置了浏览器/CDN 缓存响应头；后台接口通过 JWT 鉴权，不应公开 service key。

## 小程序关系

小程序通过 `utils/api.js` 优先读取 `https://www.skinsdata.top` 下的公开接口。皮肤和资源接口失败时，小程序会降级访问 Supabase 只读接口；英雄接口失败时降级为空数据并继续运行。

小程序使用微信本地存储维护主题、拥有/关注标记和接口缓存，后台数据修改不会直接写入小程序本地标记。

## 清理说明

仓库内保留源文件、API、迁移脚本和架构文档。旧的 `docs/index.html`、`docs/admin.html` 属于历史静态页面副本，已由根目录页面和 Vercel 路由替代，不再作为部署入口维护。

## 常规流程

网页版：

```bash
npm run check
git status --short
git add .
git commit -m "..."
git push origin main
```

小程序：

```bash
git status --short
git add .
git commit -m "..."
git push origin main
```

所有后续提交的备注必须使用中文，说明本次提交的实际变更内容；不要再使用英文 commit message。

推送小程序前确认远端是私有仓库。
