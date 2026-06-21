-- Align special-resource fields and model return events after first releases.

drop policy if exists "Public read available star legend resources"
  on public.star_legend_resources;
drop policy if exists "Public read available star outfit resources"
  on public.star_outfit_resources;
drop policy if exists "Public read available yuanliu suit resources"
  on public.yuanliu_suit_resources;

alter table public.star_legend_resources
  drop column is_available,
  drop column quality,
  add column parent_resource_id bigint,
  add constraint star_legend_parent_resource_fkey
    foreign key (parent_resource_id)
    references public.star_legend_resources(id)
    on delete cascade,
  add constraint star_legend_release_parent_check
    check (
      (release_type = '首发' and parent_resource_id is null)
      or (release_type = '返场' and parent_resource_id is not null)
    );

alter table public.star_outfit_resources
  drop column is_available,
  add column quality text not null default '绿色',
  add column parent_resource_id bigint,
  add constraint star_outfit_quality_check
    check (quality in ('绿色', '蓝色', '紫色', '金色')),
  add constraint star_outfit_parent_resource_fkey
    foreign key (parent_resource_id)
    references public.star_outfit_resources(id)
    on delete cascade,
  add constraint star_outfit_release_parent_check
    check (
      (release_type = '首发' and parent_resource_id is null)
      or (release_type = '返场' and parent_resource_id is not null)
    );

update public.yuanliu_suit_resources
set quality = '绿色'
where quality is null or quality not in ('绿色', '蓝色', '紫色', '金色');

alter table public.yuanliu_suit_resources
  drop column is_available,
  alter column quality set default '绿色',
  alter column quality set not null,
  add column parent_resource_id bigint,
  add constraint yuanliu_suit_quality_check
    check (quality in ('绿色', '蓝色', '紫色', '金色')),
  add constraint yuanliu_suit_parent_resource_fkey
    foreign key (parent_resource_id)
    references public.yuanliu_suit_resources(id)
    on delete cascade,
  add constraint yuanliu_suit_release_parent_check
    check (
      (release_type = '首发' and parent_resource_id is null)
      or (release_type = '返场' and parent_resource_id is not null)
    );

create index idx_star_legend_parent_resource
  on public.star_legend_resources(parent_resource_id);
create index idx_star_outfit_parent_resource
  on public.star_outfit_resources(parent_resource_id);
create index idx_yuanliu_suit_parent_resource
  on public.yuanliu_suit_resources(parent_resource_id);

create policy "Public read star legend resources"
  on public.star_legend_resources for select
  to anon, authenticated
  using (true);
create policy "Public read star outfit resources"
  on public.star_outfit_resources for select
  to anon, authenticated
  using (true);
create policy "Public read yuanliu suit resources"
  on public.yuanliu_suit_resources for select
  to anon, authenticated
  using (true);
