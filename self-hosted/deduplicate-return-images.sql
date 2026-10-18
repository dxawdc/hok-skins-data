-- Run in a caller-owned transaction against the isolated hokskins database only.
-- A dry run can shadow both source tables with temporary copies first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE image_dedup_before ON COMMIT DROP AS
SELECT count(*) count,
       md5(string_agg((to_jsonb(s) - ARRAY['skin_img_id','tag_img_id','skin_img_url','tag_img_url','updated_at'])::text, '' ORDER BY id)) checksum
FROM skins s;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skins s LEFT JOIN skin_profiles p ON p.id=s.skin_profile_id WHERE p.id IS NULL) THEN
    RAISE EXCEPTION 'Unlinked skin records must be reviewed first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM skin_profiles p
    LEFT JOIN LATERAL (SELECT * FROM skins WHERE skin_profile_id=p.id AND type='首发' ORDER BY date NULLS LAST,id LIMIT 1) f ON true
    WHERE f.id IS NULL OR NULLIF(p.skin_img_url,'') IS NULL
      OR NULLIF(p.skin_img_url,'') IS DISTINCT FROM NULLIF(f.skin_img_url,'')
      OR NULLIF(p.tag_img_url,'') IS DISTINCT FROM NULLIF(f.tag_img_url,'')
  ) THEN RAISE EXCEPTION 'Profile images must match the first release before deduplication'; END IF;
END $$;

WITH changed AS (
  UPDATE skins s
  SET skin_img_url=p.skin_img_url,
      tag_img_url=p.tag_img_url,
      skin_img_id=regexp_replace(regexp_replace(split_part(p.skin_img_url,'?',1),'^.*/',''),'\.[^.]+$',''),
      tag_img_id=CASE WHEN NULLIF(p.tag_img_url,'') IS NULL THEN NULL
                     ELSE regexp_replace(regexp_replace(split_part(p.tag_img_url,'?',1),'^.*/',''),'\.[^.]+$','') END,
      updated_at=now()
  FROM skin_profiles p
  WHERE s.skin_profile_id=p.id AND s.type='返场'
    AND (s.skin_img_url IS DISTINCT FROM p.skin_img_url OR s.tag_img_url IS DISTINCT FROM p.tag_img_url)
  RETURNING s.id
)
SELECT json_build_object('updated_return_records',count(*)) FROM changed;

DO $$
DECLARE after_count bigint; after_checksum text;
BEGIN
  SELECT count(*),md5(string_agg((to_jsonb(s) - ARRAY['skin_img_id','tag_img_id','skin_img_url','tag_img_url','updated_at'])::text, '' ORDER BY id))
    INTO after_count,after_checksum FROM skins s;
  IF NOT EXISTS(SELECT 1 FROM image_dedup_before WHERE count=after_count AND checksum=after_checksum) THEN
    RAISE EXCEPTION 'Non-image record data changed';
  END IF;
  IF EXISTS(SELECT 1 FROM skins s JOIN skin_profiles p ON p.id=s.skin_profile_id
            WHERE s.skin_img_url IS DISTINCT FROM p.skin_img_url OR s.tag_img_url IS DISTINCT FROM p.tag_img_url) THEN
    RAISE EXCEPTION 'Image references are still inconsistent';
  END IF;
END $$;
SELECT json_build_object('records',count(*),'profiles',count(DISTINCT skin_profile_id),
  'return_records',count(*) FILTER(WHERE type='返场'),
  'skin_images',count(DISTINCT skin_img_url),'tag_images',count(DISTINCT tag_img_url)) FROM skins;
