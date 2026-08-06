-- 将既有的限定套系纳入正式分类；细分值仍按每款皮肤在关联表中维护。
update public.skin_series
set series_type = case name
  when '战令限定' then 'battle_pass'
  when '赛季限定' then 'season_limited'
  when '生肖限定' then 'zodiac_limited'
  else series_type
end
where name in ('战令限定', '赛季限定', '生肖限定')
  and series_type = 'other';
