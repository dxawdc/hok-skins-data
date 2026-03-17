# 王者荣耀皮肤数据库 · 部署说明

## 目录结构

```
项目/
├── api/
│   └── admin.py          # 后台 API（Vercel Serverless）
├── public/
│   ├── index.html        # 前台展示页面（需另行替换）
│   └── admin.html        # 后台管理界面
├── 01_supabase_schema.sql   # 建表 SQL
├── 02_import_data.py        # 初始数据导入脚本
├── 03_create_admin.sql      # 创建初始管理员
├── requirements.txt         # Python 依赖
└── vercel.json              # Vercel 配置
```

---

## 第一步：Supabase 建表

1. 登录 [supabase.com](https://supabase.com)，进入你的项目
2. 左侧菜单 → **SQL Editor** → **New query**
3. 复制 `01_supabase_schema.sql` 全部内容粘贴进去，点 **Run**
4. 再运行 `03_create_admin.sql`（创建初始管理员账号）

**记录以下信息（后面用到）：**
- Project URL：`Settings → API → Project URL`
- **anon key**：`Settings → API → anon public`
- **service_role key**：`Settings → API → service_role secret`（⚠️ 不要泄露）

---

## 第二步：导入初始数据

在你的电脑上运行（需要 Python 3.9+）：

```bash
pip install supabase pandas openpyxl pillow

# 编辑 02_import_data.py，填入：
# SUPABASE_URL = "https://xxx.supabase.co"
# SUPABASE_KEY = "你的 service_role key"
# EXCEL_PATH   = "王者荣耀皮肤数据统计__含图片_.xlsx"

python 02_import_data.py
```

导入完成后会显示：`✅ 导入完成！共 1425 条记录，xxx 张图片`

---

## 第三步：上传代码到 GitHub

1. 在 [github.com](https://github.com) 新建一个**私有仓库**（Private）
2. 把整个项目文件夹上传进去

   ```bash
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/你的用户名/仓库名.git
   git push -u origin main
   ```

---

## 第四步：在 Vercel 部署

1. 登录 [vercel.com](https://vercel.com)
2. 点 **Add New Project** → 选择你刚创建的 GitHub 仓库
3. Framework Preset 选 **Other**
4. 点开 **Environment Variables**，添加以下三个变量：

   | 变量名 | 值 |
   |--------|-----|
   | `SUPABASE_URL` | `https://xxx.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | 你的 service_role key |
   | `JWT_SECRET` | 随机字符串，如 `sk_wz_2024_xxxxxxxxxxx`（自己随便打一串） |

5. 点 **Deploy**，等待 1-2 分钟

部署完成后 Vercel 会给你一个免费域名，如 `your-project.vercel.app`

---

## 第五步：验证

| 地址 | 说明 |
|------|------|
| `https://your-project.vercel.app` | 前台展示页面 |
| `https://your-project.vercel.app/admin` | 后台管理页面 |

- 用 `admin` / `Admin@2024` 登录后台（**立即修改密码**）
- 后台可以：创建其他用户、编辑皮肤数据、上传 Excel 更新

---

## 后续更新数据

### 方式 A：后台上传 Excel（推荐）

1. 打开 `https://your-project.vercel.app/admin`
2. 左侧菜单 → **Excel 导入**
3. 选择模式（追加/全量覆盖）
4. 拖入 Excel 文件 → 点**开始导入**

### 方式 B：直接在后台编辑

1. 左侧菜单 → **皮肤数据**
2. 找到对应记录 → 点**编辑**
3. 修改字段 → **保存**

### 方式 C：Supabase 控制台直接改

1. Supabase → **Table Editor** → 选择 `skins` 表
2. 点击单元格直接修改

---

## 多用户管理

后台支持多个账号，不同角色权限不同：

| 角色 | 权限 |
|------|------|
| 管理员（admin） | 全部功能，含用户管理、日志查看 |
| 编辑者（editor） | 皮肤数据查看/编辑、Excel 导入 |

创建新用户：后台 → **用户管理** → **新建用户**

---

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
