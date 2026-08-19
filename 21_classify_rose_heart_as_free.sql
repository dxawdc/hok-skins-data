-- 蔷薇之心兑换属于免费获取方式，修正已有首发资料的初始化分类。

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
SET first_obtain_type = '免费'
FROM first_release r
WHERE p.id = r.skin_profile_id
  AND r.obtain LIKE '%蔷薇之心%';
