-- 创建第一个管理员账号
-- 在 Supabase SQL Editor 中执行
-- 密码：Admin@2024（部署后请立即登录修改）

INSERT INTO admin_users (username, password_hash, display_name, role)
VALUES (
  'admin',
  -- bcrypt hash of 'Admin@2024'，可在 https://bcrypt-generator.com/ 生成
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/lewKyDAVJEoN6LGMC',
  '超级管理员',
  'admin'
);

-- ====================================================
-- 如需自定义密码，在 Python 中运行以下代码生成 hash：
-- import bcrypt
-- pw = b'你的密码'
-- print(bcrypt.hashpw(pw, bcrypt.gensalt()).decode())
-- ====================================================
