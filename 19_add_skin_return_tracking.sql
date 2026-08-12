-- Add the profile-level switch used by return overview pages.
-- Existing limited skins keep the previous behavior; permanent skins stay excluded.

ALTER TABLE public.skin_profiles
  ADD COLUMN IF NOT EXISTS track_returns BOOLEAN;

UPDATE public.skin_profiles
SET track_returns = (permanent = '否')
WHERE track_returns IS NULL;

ALTER TABLE public.skin_profiles
  ALTER COLUMN track_returns SET DEFAULT FALSE,
  ALTER COLUMN track_returns SET NOT NULL;

COMMENT ON COLUMN public.skin_profiles.track_returns IS
  'Whether this skin is included in return overview statistics; maintained only from the first-release skin form.';
