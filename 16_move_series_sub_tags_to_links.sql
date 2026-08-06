-- 将细分标签从套系移至“皮肤—套系”关联：同一套系下每款皮肤可独立配置 S42 / 2026马年。
alter table public.skin_profile_series
  add column if not exists sub_tag text,
  add column if not exists sub_tag_sort integer not null default 0;

-- 保留已填写的旧套系细分，并回填给该套系下的所有皮肤关联。
update public.skin_profile_series links
set
  sub_tag = series.sub_tag,
  sub_tag_sort = series.sub_tag_sort
from public.skin_series series
where links.series_id = series.id
  and series.sub_tag is not null
  and length(trim(series.sub_tag)) > 0
  and links.sub_tag is null;

create index if not exists idx_skin_profile_series_series_sub_tag_sort
  on public.skin_profile_series(series_id, sub_tag_sort desc, sub_tag);

drop index if exists public.idx_skin_series_type_sub_tag_sort;
alter table public.skin_series drop constraint if exists skin_series_sub_tag_check;
alter table public.skin_series
  drop column if exists sub_tag,
  drop column if exists sub_tag_sort;
