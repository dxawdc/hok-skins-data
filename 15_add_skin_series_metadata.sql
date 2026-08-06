-- 套系分类与细分标签：仅战令限定、赛季限定、生肖限定使用细分标签。
alter table public.skin_series
  add column if not exists series_type text not null default 'other',
  add column if not exists sub_tag text,
  add column if not exists sub_tag_sort integer not null default 0;

alter table public.skin_series
  drop constraint if exists skin_series_type_check;
alter table public.skin_series
  add constraint skin_series_type_check
  check (series_type in ('other', 'battle_pass', 'season_limited', 'zodiac_limited'));

alter table public.skin_series
  drop constraint if exists skin_series_sub_tag_check;
alter table public.skin_series
  add constraint skin_series_sub_tag_check
  check (
    (series_type = 'other' and sub_tag is null)
    or (series_type in ('battle_pass', 'season_limited', 'zodiac_limited') and length(trim(coalesce(sub_tag, ''))) > 0)
  );

create index if not exists idx_skin_series_type_sub_tag_sort
  on public.skin_series(series_type, sub_tag_sort desc, sub_tag);
