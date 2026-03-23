

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
