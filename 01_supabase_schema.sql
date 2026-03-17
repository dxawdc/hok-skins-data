-- ============================================================
-- 王者荣耀皮肤数据库 - Supabase 建表 SQL
-- 在 Supabase > SQL Editor 中执行此文件
-- ============================================================

-- 1. 皮肤记录主表
CREATE TABLE IF NOT EXISTS skins (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE           NOT NULL,          -- 上线日期
  name          TEXT           NOT NULL,          -- 皮肤名称
  quality       TEXT           NOT NULL,          -- 皮肤品质
  tag           TEXT           DEFAULT '',        -- 皮肤标签说明
  hero          TEXT           NOT NULL,          -- 归属英雄
  job           TEXT           DEFAULT '',        -- 英雄职业/分路
  price         TEXT           DEFAULT '',        -- 价格（原始文本）
  obtain        TEXT           DEFAULT '',        -- 获取方式
  type          TEXT           NOT NULL CHECK (type IN ('首发','返场')),
  permanent     TEXT           DEFAULT '否' CHECK (permanent IN ('是','否')),
  skin_img_id   TEXT           DEFAULT '',        -- 皮肤图片ID（对应 images 表）
  tag_img_id    TEXT           DEFAULT '',        -- 标签图片ID（对应 images 表）
  created_at    TIMESTAMPTZ    DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- 2. 图片存储表（base64，避免 Storage 复杂性）
CREATE TABLE IF NOT EXISTS images (
  img_id        TEXT           PRIMARY KEY,       -- 原始 Excel 图片 ID
  img_type      TEXT           NOT NULL CHECK (img_type IN ('skin','tag')),
  data          TEXT           NOT NULL,          -- base64 编码
  mime_type     TEXT           DEFAULT 'image/jpeg',
  created_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- 3. 操作日志表（记录谁改了什么）
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  operator      TEXT           NOT NULL,          -- 操作人
  action        TEXT           NOT NULL,          -- insert / update / delete / import
  target_id     BIGINT,                           -- 涉及的 skin id（可为空，如批量导入）
  detail        JSONB,                            -- 改动详情
  created_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- 4. 后台用户表
CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT           UNIQUE NOT NULL,
  password_hash TEXT           NOT NULL,          -- bcrypt hash
  display_name  TEXT           DEFAULT '',
  role          TEXT           DEFAULT 'editor' CHECK (role IN ('admin','editor')),
  created_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- ── 自动更新 updated_at ──
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER skins_updated_at
  BEFORE UPDATE ON skins
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 索引（加快查询速度）──
CREATE INDEX IF NOT EXISTS idx_skins_hero   ON skins(hero);
CREATE INDEX IF NOT EXISTS idx_skins_name   ON skins(name);
CREATE INDEX IF NOT EXISTS idx_skins_quality ON skins(quality);
CREATE INDEX IF NOT EXISTS idx_skins_type   ON skins(type);
CREATE INDEX IF NOT EXISTS idx_skins_date   ON skins(date DESC);
CREATE INDEX IF NOT EXISTS idx_skins_hero_name ON skins(hero, name);

-- ── Row Level Security（RLS）──
-- 前端公开只读访问（不需要登录）
ALTER TABLE skins  ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read skins"  ON skins  FOR SELECT USING (true);
CREATE POLICY "public read images" ON images FOR SELECT USING (true);

-- admin_users 和 audit_log 不对外公开（只有 service_role key 才能访问）
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;
-- 不建任何 SELECT policy，即只有 service_role 可读写

-- ============================================================
-- 执行完成后，到下一步运行 Python 导入脚本
-- ============================================================
