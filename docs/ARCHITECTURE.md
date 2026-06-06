# 王者荣耀皮肤展示项目架构说明

## 仓库边界

本仓库是网页版代码仓库，需要同时维护本地 Git 和 GitHub 远端：

- 本地路径：`D:\AI\Hok\hok-skins-data`
- GitHub 远端：`https://github.com/dxawdc/hok-skins-data.git`
- 当前主分支：`main`

小程序版本位于同级目录 `D:\AI\Hok\miniprogram`，只维护本地 Git，不同步到 GitHub。

## 网页版组成

- `index.html`：公开展示页，读取公开 API 数据并做前端展示。
- `admin.html`：后台管理页，通过 JWT 调用 `/api/admin/*`。
- `api/admin.js`：Vercel Serverless Function，负责后台登录、用户、皮肤、英雄、资源、图片上传和审计日志。
- `api/resources.js`：公开资源图鉴接口，返回天幕/小兵数据和标签图片字段。
- `vercel.json`：Vercel 路由与 CORS 配置。
- `01_supabase_schema.sql`、`02_import_data.py`、`03_create_admin.sql`：历史建表、导入和后台账号初始化脚本。

## 数据流

公开展示页和小程序目前读取这些线上接口：

- `https://skinsdata.top/api/skins`
- `https://skinsdata.top/api/heroes`
- `https://skinsdata.top/api/resources`

后台管理页读取当前仓库内的接口：

- `/api/admin/login`
- `/api/admin/skins`
- `/api/admin/heroes`
- `/api/admin/resources`
- `/api/admin/images`
- `/api/admin/logs`

图片存储使用 Supabase Storage 的公开 bucket，并通过 `https://skinsdata.top/img` 做 CDN 地址转换。

## 需要收口的现状

当前仓库包含后台管理接口 `api/admin.js` 和公开资源接口 `api/resources.js`。公开展示接口 `/api/skins`、`/api/heroes` 的实现仍不在本仓库内。线上接口目前可访问，并由 Cloudflare 缓存响应；后续迁移、灾备或重建部署前，需要把这部分实现纳入仓库，或者补充独立部署仓库/Worker 的位置。

资源图鉴依赖 `/api/resources` 返回 `tag_img_url` 字段，用于天幕/小兵标签图片展示。如果公开 API 使用显式字段列表或有 Cloudflare 缓存，需要同步加入该字段并刷新缓存。

`01_supabase_schema.sql` 是早期 schema，仍保留 `images` 表和 `skin_img_id/tag_img_id` 字段；当前代码已经使用 Supabase Storage、`skin_img_url/tag_img_url`、`hero_id`、`heroes`、`resources` 等结构。后续数据库迁移应以线上真实 schema 为准，不能直接把该 SQL 当作完整生产 schema 使用。

## 同步流程

网页版常规流程：

```bash
cd D:\AI\Hok\hok-skins-data
npm run check
git status --short
git add .
git commit -m "..."
git push origin main
```

小程序常规流程：

```bash
cd D:\AI\Hok\miniprogram
git status --short
git add .
git commit -m "..."
```

小程序不要添加 GitHub remote，除非之后明确改变同步策略。
