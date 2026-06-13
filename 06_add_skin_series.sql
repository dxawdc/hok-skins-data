create table if not exists public.skin_series (
  id bigserial primary key,
  name text not null unique,
  description text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.skin_profile_series (
  skin_profile_id bigint not null references public.skin_profiles(id) on delete cascade,
  series_id bigint not null references public.skin_series(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (skin_profile_id, series_id)
);

create index if not exists idx_skin_profile_series_profile
  on public.skin_profile_series(skin_profile_id);
create index if not exists idx_skin_profile_series_series
  on public.skin_profile_series(series_id);
create index if not exists idx_skin_series_sort_name
  on public.skin_series(sort_order, name);

alter table public.skin_series enable row level security;
alter table public.skin_profile_series enable row level security;

do $$ begin
  create policy "Public read skin series" on public.skin_series
    for select using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Public read skin profile series" on public.skin_profile_series
    for select using (true);
exception when duplicate_object then null;
end $$;
