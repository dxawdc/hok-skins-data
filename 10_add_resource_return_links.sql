-- Model return events for standard resources (canopies and minions).
-- Run this after 09_create_feedback.sql in the Supabase SQL editor.

alter table public.resources
  add column if not exists parent_resource_id bigint
  references public.resources(id) on delete cascade;

create index if not exists idx_resources_parent_resource
  on public.resources(parent_resource_id);
