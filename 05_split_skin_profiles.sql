-- Split immutable skin profile data from release/return event records.

CREATE TABLE IF NOT EXISTS public.skin_profiles (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  hero_id            BIGINT REFERENCES public.heroes(id) ON DELETE SET NULL,
  hero               TEXT NOT NULL,
  quality            TEXT NOT NULL DEFAULT '其他',
  tag                TEXT DEFAULT '',
  permanent          TEXT NOT NULL DEFAULT '否' CHECK (permanent IN ('是','否')),
  skin_img_url       TEXT,
  tag_img_url        TEXT,
  notes              TEXT,
  first_release_date DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hero_id, name)
);

ALTER TABLE public.skin_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read skin_profiles"
  ON public.skin_profiles FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TRIGGER skin_profiles_updated_at
  BEFORE UPDATE ON public.skin_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.skins
  ADD COLUMN IF NOT EXISTS skin_profile_id BIGINT REFERENCES public.skin_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_skin_profiles_hero_name ON public.skin_profiles(hero_id, name);
CREATE INDEX IF NOT EXISTS idx_skin_profiles_hero ON public.skin_profiles(hero);
CREATE INDEX IF NOT EXISTS idx_skin_profiles_quality ON public.skin_profiles(quality);
CREATE INDEX IF NOT EXISTS idx_skins_profile_id ON public.skins(skin_profile_id);

WITH groups AS (
  SELECT DISTINCT hero_id, hero, name
  FROM public.skins
  WHERE hero_id IS NOT NULL AND NULLIF(name,'') IS NOT NULL
), resolved AS (
  SELECT
    g.hero_id,
    COALESCE((SELECT s.hero FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), g.hero) AS hero,
    g.name,
    COALESCE(NULLIF((SELECT CASE WHEN s.quality = '伴生' THEN '其他' ELSE s.quality END FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT CASE WHEN s.quality = '伴生' THEN '其他' ELSE s.quality END FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.quality,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1),
             '其他') AS quality,
    COALESCE(NULLIF((SELECT s.tag FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT s.tag FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.tag,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1),
             '') AS tag,
    COALESCE(NULLIF((SELECT s.permanent FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT s.permanent FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.permanent,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1),
             '否') AS permanent,
    COALESCE(NULLIF((SELECT s.skin_img_url FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT s.skin_img_url FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.skin_img_url,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1)) AS skin_img_url,
    COALESCE(NULLIF((SELECT s.tag_img_url FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT s.tag_img_url FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.tag_img_url,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1)) AS tag_img_url,
    COALESCE(NULLIF((SELECT s.notes FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1), ''),
             (SELECT s.notes FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND NULLIF(s.notes,'') IS NOT NULL ORDER BY s.date, s.id LIMIT 1)) AS notes,
    (SELECT s.date FROM public.skins s WHERE s.hero_id = g.hero_id AND s.name = g.name AND s.type = '首发' ORDER BY s.date, s.id LIMIT 1) AS first_release_date
  FROM groups g
)
INSERT INTO public.skin_profiles (hero_id, hero, name, quality, tag, permanent, skin_img_url, tag_img_url, notes, first_release_date)
SELECT hero_id, hero, name, quality, tag, permanent, skin_img_url, tag_img_url, notes, first_release_date
FROM resolved
ON CONFLICT (hero_id, name) DO UPDATE SET
  hero = EXCLUDED.hero,
  quality = EXCLUDED.quality,
  tag = EXCLUDED.tag,
  permanent = EXCLUDED.permanent,
  skin_img_url = EXCLUDED.skin_img_url,
  tag_img_url = EXCLUDED.tag_img_url,
  notes = EXCLUDED.notes,
  first_release_date = EXCLUDED.first_release_date;

UPDATE public.skins s
SET skin_profile_id = p.id
FROM public.skin_profiles p
WHERE s.hero_id = p.hero_id
  AND s.name = p.name
  AND (s.skin_profile_id IS NULL OR s.skin_profile_id <> p.id);
