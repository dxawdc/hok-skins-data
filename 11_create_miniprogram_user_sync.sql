-- 微信小程序用户资料与皮肤标记云同步。
-- 仅由服务端 service_role 访问；匿名客户端不直接读取或写入这些表。

create table if not exists public.miniprogram_users (
  openid text primary key,
  nickname text not null default '',
  avatar_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.miniprogram_skin_marks (
  openid text not null references public.miniprogram_users(openid) on delete cascade,
  skin_key text not null check (char_length(trim(skin_key)) between 1 and 300),
  mark_type text not null check (mark_type in ('owned', 'follow')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (openid, skin_key)
);

create index if not exists idx_miniprogram_skin_marks_openid_updated_at
  on public.miniprogram_skin_marks (openid, updated_at desc);

alter table public.miniprogram_users enable row level security;
alter table public.miniprogram_skin_marks enable row level security;

revoke all on table public.miniprogram_users from anon, authenticated;
revoke all on table public.miniprogram_skin_marks from anon, authenticated;
grant select, insert, update, delete on table public.miniprogram_users to service_role;
grant select, insert, update, delete on table public.miniprogram_skin_marks to service_role;

drop trigger if exists miniprogram_users_updated_at on public.miniprogram_users;
create trigger miniprogram_users_updated_at
before update on public.miniprogram_users
for each row execute function public.update_updated_at();

drop trigger if exists miniprogram_skin_marks_updated_at on public.miniprogram_skin_marks;
create trigger miniprogram_skin_marks_updated_at
before update on public.miniprogram_skin_marks
for each row execute function public.update_updated_at();

comment on table public.miniprogram_users is 'WeChat Mini Program user profile, accessed only by server-side code.';
comment on table public.miniprogram_skin_marks is 'Cloud-synced owned/follow marks for a Mini Program user.';
