-- Store Mini Program avatars separately from public skin assets.
-- Run this migration before deploying api/user.js.

alter table public.miniprogram_users
  add column if not exists avatar_path text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-avatars',
  'user-avatars',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists miniprogram_server_manages_avatars on storage.objects;
create policy miniprogram_server_manages_avatars
on storage.objects
for all
to service_role
using (bucket_id = 'user-avatars')
with check (bucket_id = 'user-avatars');

comment on column public.miniprogram_users.avatar_path
is 'Private storage path for a Mini Program avatar. Public URLs must not be persisted.';
