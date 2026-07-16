-- Prevent repeated submissions from creating identical resource records.
-- parent_resource_id is normalized so first-release records (NULL parent) are also unique.
CREATE UNIQUE INDEX IF NOT EXISTS resources_unique_release_entry_idx
  ON public.resources (
    type,
    name,
    date,
    release_type,
    (COALESCE(parent_resource_id, 0))
  );
