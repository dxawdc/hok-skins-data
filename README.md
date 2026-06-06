# 王者荣耀皮肤展示项目

这是网页版代码仓库，包含公开展示页、后台管理页和 Vercel 后台管理接口。小程序版本位于同级目录 `D:\AI\Hok\miniprogram`，两者保持独立 Git 边界。

## 目录

- `index.html`：网页版公开展示页
- `admin.html`：网页版后台管理页
- `api/admin.js`：后台管理 API
- `docs/ARCHITECTURE.md`：架构、同步边界和部署现状
- `01_supabase_schema.sql`：历史建表脚本，当前不等同于完整生产 schema
- `02_import_data.py`：历史数据导入脚本
- `03_create_admin.sql`：后台账号初始化脚本

## 本地检查

```bash
npm install
npm run check
```

`npm run check` 会对 `api/admin.js` 做 Node.js 语法检查。

## 同步策略

网页版需要提交到本地 Git 并推送 GitHub：

```bash
git add .
git commit -m "..."
git push origin main
```

小程序版本只维护本地 Git，不推送 GitHub。

## 常见问题

**Q：更新了 Excel 后前台什么时候生效？**
A：立即生效，前台每次打开都从数据库实时加载。

**Q：能回滚误操作吗？**
A：每次修改都记录在**操作日志**里，可以看到改之前的值，但需要手动还原。
   Supabase 免费版有 Point-in-Time Recovery，可以找 Supabase 支持。

**Q：图片怎么更新？**
A：重新上传 Excel 时会自动提取并更新图片。已有图片不会被覆盖（upsert）。

**Q：网站访问速度慢怎么办？**
A：Vercel 的 CDN 在国内访问可能较慢。可以考虑：
- 绑定自定义域名并套 Cloudflare CDN
- 或者换用国内的 [Railway](https://railway.app) 部署
