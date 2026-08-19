-- 首发获取方式类型：属于皮肤资料，只由首发记录维护，返场自动复用。

ALTER TABLE public.skin_profiles
  ADD COLUMN IF NOT EXISTS first_obtain_type TEXT NOT NULL DEFAULT '付费';

ALTER TABLE public.skin_profiles
  DROP CONSTRAINT IF EXISTS skin_profiles_first_obtain_type_check;
ALTER TABLE public.skin_profiles
  ADD CONSTRAINT skin_profiles_first_obtain_type_check
  CHECK (first_obtain_type IN ('付费', '免费', '赛季/赛年', '战令'));

-- 按每个皮肤最早的首发记录初始化。规则优先级：免费 > 赛季/赛年 > 战令 > 付费。
WITH first_release AS (
  SELECT DISTINCT ON (s.skin_profile_id)
    s.skin_profile_id,
    COALESCE(s.obtain, '') AS obtain
  FROM public.skins s
  WHERE s.type = '首发'
    AND s.skin_profile_id IS NOT NULL
  ORDER BY s.skin_profile_id, s.date, s.id
)
UPDATE public.skin_profiles p
SET first_obtain_type = CASE
  WHEN r.obtain LIKE '%碎片%'
    OR r.obtain LIKE '%限时点券%'
    OR r.obtain LIKE '%活动%'
    THEN '免费'
  WHEN r.obtain LIKE '%赛季%'
    OR r.obtain LIKE '%赛年%'
    THEN '赛季/赛年'
  WHEN r.obtain LIKE '%战令%'
    THEN '战令'
  ELSE '付费'
END
FROM first_release r
WHERE p.id = r.skin_profile_id;

COMMENT ON COLUMN public.skin_profiles.first_obtain_type IS
  'Initial acquisition category for the skin. Maintained only from the first-release skin form.';
