-- 钻石夺宝属于免费获取；战令按皮肤价值点数区分免费与付费。
-- 规则优先级：战令 > 免费关键词 > 赛季/赛年 > 付费。

ALTER TABLE public.skin_profiles
  DROP CONSTRAINT IF EXISTS skin_profiles_first_obtain_type_check;

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
  WHEN r.obtain LIKE '%战令%' AND p.skin_value_points = 0 THEN '战令-免费'
  WHEN r.obtain LIKE '%战令%' THEN '战令-付费'
  WHEN r.obtain LIKE '%钻石夺宝%' THEN '免费'
  ELSE p.first_obtain_type
END
FROM first_release r
WHERE p.id = r.skin_profile_id
  AND (r.obtain LIKE '%战令%' OR r.obtain LIKE '%钻石夺宝%');

ALTER TABLE public.skin_profiles
  ADD CONSTRAINT skin_profiles_first_obtain_type_check
  CHECK (first_obtain_type IN ('付费', '免费', '赛季/赛年', '战令-免费', '战令-付费'));

COMMENT ON COLUMN public.skin_profiles.first_obtain_type IS
  'Initial acquisition category. Battle-pass skins are split by skin_value_points: 0 is free, otherwise paid.';
