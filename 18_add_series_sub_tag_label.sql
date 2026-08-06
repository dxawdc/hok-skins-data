-- 套系子分类改为可选的自定义名称；非空即表示该套系启用子分类。
alter table public.skin_series
  add column if not exists sub_tag_label text;

alter table public.skin_series
  drop constraint if exists skin_series_sub_tag_label_check;
alter table public.skin_series
  add constraint skin_series_sub_tag_label_check
  check (
    sub_tag_label is null
    or char_length(trim(sub_tag_label)) between 1 and 24
  );

-- 保留已有三类限定套系的使用方式，并允许后续在后台自行改名或关闭。
update public.skin_series
set sub_tag_label = case series_type
  when 'battle_pass' then '赛季编号'
  when 'season_limited' then '赛季编号'
  when 'zodiac_limited' then '生肖年份'
  else null
end
where sub_tag_label is null
  and series_type in ('battle_pass', 'season_limited', 'zodiac_limited');
