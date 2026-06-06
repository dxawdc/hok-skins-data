-- Add tag image support for personality resources.
-- Run in Supabase SQL Editor if the column is not already present.

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS tag_img_url TEXT;
