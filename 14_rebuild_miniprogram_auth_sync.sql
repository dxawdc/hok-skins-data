-- Destructively rebuild the unpublished Mini Program auth/profile/marks feature.
-- All existing Mini Program users, sessions, marks and mutation receipts are
-- test data and are intentionally discarded.
--
-- The application server is the only database client for this feature. It uses
-- the service_role key, derives a SHA-256 hash from each opaque session token,
-- and never exposes OpenID, UnionID, token hashes or private avatar paths.

begin;

-- This shared trigger function is used below. Pin its lookup path so trigger
-- execution cannot resolve attacker-controlled objects from another schema.
alter function public.update_updated_at()
  set search_path = pg_catalog, public;

-- Retire the legacy avatar policy. Do not delete storage.objects or buckets in
-- SQL: that would remove metadata while leaving orphaned backing blobs. The old
-- private user-avatars bucket can be emptied/deleted later through Storage API.
-- Drop the v2 policy as well so this destructive migration is safely rerunnable.
drop policy if exists miniprogram_server_manages_avatars on storage.objects;
drop policy if exists miniprogram_server_manages_avatars_v2 on storage.objects;

update storage.buckets
set public = false
where id = 'user-avatars';

drop function if exists public.read_miniprogram_marks(uuid, bigint);
drop function if exists public.apply_miniprogram_mark_changes(uuid, jsonb, text, bigint);
drop function if exists public.apply_miniprogram_mark_changes(uuid, jsonb, text);
drop function if exists public.enforce_miniprogram_session_limits() cascade;
drop function if exists public.prune_miniprogram_mark_mutations() cascade;

drop table if exists public.miniprogram_mark_mutations cascade;
drop table if exists public.miniprogram_sessions cascade;
drop table if exists public.miniprogram_skin_marks cascade;
drop table if exists public.miniprogram_users cascade;

create table public.miniprogram_users (
  id uuid primary key default gen_random_uuid(),
  openid text not null unique,
  unionid text,
  nickname text not null default '',
  avatar_path text not null default '',
  avatar_updated_at timestamptz,
  marks_revision bigint not null default 0,
  last_login_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint miniprogram_users_openid_check check (
    openid = btrim(openid)
    and char_length(openid) between 1 and 128
    and openid !~ '[[:cntrl:]]'
  ),
  constraint miniprogram_users_unionid_check check (
    unionid is null
    or (
      unionid = btrim(unionid)
      and char_length(unionid) between 1 and 128
      and unionid !~ '[[:cntrl:]]'
    )
  ),
  constraint miniprogram_users_nickname_check check (
    nickname = btrim(nickname)
    and char_length(nickname) <= 80
    and nickname !~ '[[:cntrl:]]'
  ),
  constraint miniprogram_users_avatar_path_check check (
    char_length(avatar_path) <= 512
    and (
      avatar_path = ''
      or (
        avatar_path = btrim(avatar_path)
        and avatar_path !~ '(^/|://|(^|/)\.\.(/|$))'
        and avatar_path !~ '[[:cntrl:]]'
      )
    )
  ),
  constraint miniprogram_users_avatar_timestamp_check check (
    (avatar_path = '' and avatar_updated_at is null)
    or (avatar_path <> '' and avatar_updated_at is not null)
  ),
  constraint miniprogram_users_marks_revision_check check (marks_revision >= 0)
);

create unique index miniprogram_users_unionid_key
  on public.miniprogram_users (unionid)
  where unionid is not null;

create table public.miniprogram_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.miniprogram_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint miniprogram_sessions_token_hash_check check (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint miniprogram_sessions_expiry_check check (expires_at > created_at),
  constraint miniprogram_sessions_last_seen_check check (last_seen_at >= created_at),
  constraint miniprogram_sessions_revoked_check check (
    revoked_at is null or revoked_at >= created_at
  )
);

create index idx_miniprogram_sessions_user_active
  on public.miniprogram_sessions (user_id, expires_at desc)
  where revoked_at is null;

create index idx_miniprogram_sessions_expires
  on public.miniprogram_sessions (expires_at);

create table public.miniprogram_skin_marks (
  user_id uuid not null references public.miniprogram_users(id) on delete cascade,
  skin_key text not null,
  mark_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, skin_key),
  constraint miniprogram_skin_marks_key_check check (
    skin_key = btrim(skin_key)
    and char_length(skin_key) between 1 and 300
    and skin_key !~ '[[:cntrl:]]'
  ),
  constraint miniprogram_skin_marks_type_check check (
    mark_type in ('owned', 'follow')
  )
);

create index idx_miniprogram_skin_marks_user_updated
  on public.miniprogram_skin_marks (user_id, updated_at desc);

-- One immutable receipt is stored for every attempted mutation, including a
-- base-revision conflict. A conflicted mutation ID is consumed permanently;
-- after pull/rebase the client must submit the changes under a new mutation ID.
create table public.miniprogram_mark_mutations (
  user_id uuid not null references public.miniprogram_users(id) on delete cascade,
  mutation_id text not null,
  base_revision bigint not null,
  changes jsonb not null,
  result_revision bigint not null,
  result_mark_count bigint not null,
  conflict boolean not null,
  created_at timestamptz not null default now(),

  primary key (user_id, mutation_id),
  constraint miniprogram_mark_mutations_id_check check (
    mutation_id = btrim(mutation_id)
    and char_length(mutation_id) between 8 and 100
    and mutation_id !~ '[[:cntrl:]]'
  ),
  constraint miniprogram_mark_mutations_base_revision_check check (
    base_revision >= 0
  ),
  constraint miniprogram_mark_mutations_changes_check check (
    jsonb_typeof(changes) = 'array'
    and jsonb_array_length(changes) between 1 and 200
  ),
  constraint miniprogram_mark_mutations_result_revision_check check (
    result_revision >= 0
  ),
  constraint miniprogram_mark_mutations_result_count_check check (
    result_mark_count between 0 and 2000
  )
);

create index idx_miniprogram_mark_mutations_created
  on public.miniprogram_mark_mutations (
    user_id,
    created_at desc,
    mutation_id desc
  );

alter table public.miniprogram_users enable row level security;
alter table public.miniprogram_sessions enable row level security;
alter table public.miniprogram_skin_marks enable row level security;
alter table public.miniprogram_mark_mutations enable row level security;

alter table public.miniprogram_users force row level security;
alter table public.miniprogram_sessions force row level security;
alter table public.miniprogram_skin_marks force row level security;
alter table public.miniprogram_mark_mutations force row level security;

revoke all on table public.miniprogram_users
  from public, anon, authenticated, service_role;
revoke all on table public.miniprogram_sessions
  from public, anon, authenticated, service_role;
revoke all on table public.miniprogram_skin_marks
  from public, anon, authenticated, service_role;
revoke all on table public.miniprogram_mark_mutations
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.miniprogram_users to service_role;
grant select, insert, update, delete on table public.miniprogram_sessions to service_role;
-- Direct mark writes are intentionally forbidden. Only the SECURITY DEFINER
-- mutation RPC may change marks or receipts, preserving revision invariants.
grant select on table public.miniprogram_skin_marks to service_role;

-- Serialize session creation on the owning user. Before a new active session is
-- inserted, revoke all but the seven newest currently active sessions, making
-- the post-insert hard limit eight. Terminal sessions normally remain available
-- for 30 days, while a secondary cap keeps only the 64 most recent terminal
-- rows so a high-frequency login loop cannot grow this table without bound.
create function public.enforce_miniprogram_session_limits()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.revoked_at is not null or new.expires_at <= now() then
    raise exception 'a new session must be active' using errcode = '22023';
  end if;

  perform 1
  from public.miniprogram_users as u
  where u.id = new.user_id
  for update;

  if not found then
    raise exception 'session user not found' using errcode = '23503';
  end if;

  delete from public.miniprogram_sessions as s
  where s.user_id = new.user_id
    and (s.revoked_at is not null or s.expires_at <= now())
    and coalesce(s.revoked_at, s.expires_at) < now() - interval '30 days';

  update public.miniprogram_sessions as s
  set revoked_at = now()
  where s.id in (
    select active_session.id
    from public.miniprogram_sessions as active_session
    where active_session.user_id = new.user_id
      and active_session.revoked_at is null
      and active_session.expires_at > now()
    order by active_session.created_at desc, active_session.id desc
    offset 7
  );

  delete from public.miniprogram_sessions as s
  where s.id in (
    select terminal_session.id
    from public.miniprogram_sessions as terminal_session
    where terminal_session.user_id = new.user_id
      and (
        terminal_session.revoked_at is not null
        or terminal_session.expires_at <= now()
      )
    order by
      coalesce(terminal_session.revoked_at, terminal_session.expires_at) desc,
      terminal_session.created_at desc,
      terminal_session.id desc
    offset 64
  );

  return new;
end;
$function$;

create trigger miniprogram_sessions_enforce_limits
before insert on public.miniprogram_sessions
for each row execute function public.enforce_miniprogram_session_limits();

-- Keep mutation receipts for 120 days under normal traffic, with a hard safety
-- cap of 1,000 rows per user. The hard cap wins under unusually high traffic so
-- storage remains bounded; it preserves the new receipt plus the 999 newest
-- previous receipts. If an evicted mutation ID is replayed, baseRevision still
-- protects concurrent state and each change is an idempotent per-key set/delete.
create function public.prune_miniprogram_mark_mutations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  -- The mutation RPC already holds this lock. Acquiring it here as well makes
  -- the bound remain correct if another trusted database path inserts a receipt.
  perform 1
  from public.miniprogram_users as u
  where u.id = new.user_id
  for update;

  if not found then
    raise exception 'mutation user not found' using errcode = '23503';
  end if;

  delete from public.miniprogram_mark_mutations as m
  where m.user_id = new.user_id
    and m.created_at < now() - interval '120 days';

  delete from public.miniprogram_mark_mutations as m
  where m.user_id = new.user_id
    and m.mutation_id in (
      select older.mutation_id
      from public.miniprogram_mark_mutations as older
      where older.user_id = new.user_id
        and older.mutation_id <> new.mutation_id
      order by older.created_at desc, older.mutation_id desc
      offset 999
    );

  return new;
end;
$function$;

create trigger miniprogram_mark_mutations_prune
before insert on public.miniprogram_mark_mutations
for each row execute function public.prune_miniprogram_mark_mutations();

drop trigger if exists miniprogram_users_updated_at on public.miniprogram_users;
create trigger miniprogram_users_updated_at
before update on public.miniprogram_users
for each row execute function public.update_updated_at();

drop trigger if exists miniprogram_skin_marks_updated_at on public.miniprogram_skin_marks;
create trigger miniprogram_skin_marks_updated_at
before update on public.miniprogram_skin_marks
for each row execute function public.update_updated_at();

-- Apply one optimistic-concurrency batch.
--
-- Contract:
--   p_changes: 1..200 objects shaped as {"key": string,
--              "type": "owned" | "follow" | null}.
--   p_base_revision: the revision of the complete local snapshot on which the
--                    client applied this batch.
--   result: exactly one row (revision, mark_count, duplicate, conflict).
--
-- The user row lock serializes all writers for an account. If base_revision is
-- stale, no marks are changed and revision is not incremented. The conflict is
-- nevertheless recorded so an exact retry returns the exact first response.
create function public.apply_miniprogram_mark_changes(
  p_user_id uuid,
  p_changes jsonb,
  p_mutation_id text,
  p_base_revision bigint
)
returns table (
  revision bigint,
  mark_count bigint,
  duplicate boolean,
  conflict boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_change jsonb;
  v_key text;
  v_type text;
  v_current_revision bigint;
  v_result_revision bigint;
  v_count bigint;
  v_previous public.miniprogram_mark_mutations%rowtype;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  if p_base_revision is null or p_base_revision < 0 then
    raise exception 'invalid base revision' using errcode = '22023';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'changes must be an array' using errcode = '22023';
  end if;

  if jsonb_array_length(p_changes) not between 1 and 200 then
    raise exception 'changes must contain between 1 and 200 items'
      using errcode = '22023';
  end if;

  if p_mutation_id is null
     or p_mutation_id <> btrim(p_mutation_id)
     or char_length(p_mutation_id) not between 8 and 100
     or p_mutation_id ~ '[[:cntrl:]]' then
    raise exception 'invalid mutation id' using errcode = '22023';
  end if;

  -- Validate the complete batch before taking a user lock. Duplicate keys are
  -- allowed intentionally and are applied in array order (last item wins).
  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change) <> 'object'
       or not (v_change ? 'key')
       or jsonb_typeof(v_change -> 'key') <> 'string' then
      raise exception 'each change must contain a string key'
        using errcode = '22023';
    end if;

    v_key := v_change ->> 'key';
    if v_key <> btrim(v_key)
       or char_length(v_key) not between 1 and 300
       or v_key ~ '[[:cntrl:]]' then
      raise exception 'invalid skin key' using errcode = '22023';
    end if;

    if not (v_change ? 'type')
       or jsonb_typeof(v_change -> 'type') not in ('string', 'null') then
      raise exception 'each change must contain a string or null type'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_change -> 'type') = 'string' then
      v_type := v_change ->> 'type';
      if v_type not in ('owned', 'follow') then
        raise exception 'invalid mark type' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- All mutations for one user pass through this lock. It also makes duplicate
  -- mutation requests deterministic when they arrive concurrently.
  select u.marks_revision
  into v_current_revision
  from public.miniprogram_users as u
  where u.id = p_user_id
  for update;

  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select m.*
  into v_previous
  from public.miniprogram_mark_mutations as m
  where m.user_id = p_user_id
    and m.mutation_id = p_mutation_id;

  if found then
    if v_previous.base_revision <> p_base_revision
       or v_previous.changes <> p_changes then
      raise exception 'mutation id was already used with a different request'
        using errcode = '22023';
    end if;

    return query
    select
      v_previous.result_revision,
      v_previous.result_mark_count,
      true,
      v_previous.conflict;
    return;
  end if;

  if p_base_revision <> v_current_revision then
    select count(*)
    into v_count
    from public.miniprogram_skin_marks as s
    where s.user_id = p_user_id;

    insert into public.miniprogram_mark_mutations (
      user_id,
      mutation_id,
      base_revision,
      changes,
      result_revision,
      result_mark_count,
      conflict
    ) values (
      p_user_id,
      p_mutation_id,
      p_base_revision,
      p_changes,
      v_current_revision,
      v_count,
      true
    );

    return query select v_current_revision, v_count, false, true;
    return;
  end if;

  -- Any later validation or limit exception rolls back this entire call.
  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_key := v_change ->> 'key';

    if jsonb_typeof(v_change -> 'type') = 'null' then
      delete from public.miniprogram_skin_marks
      where user_id = p_user_id
        and skin_key = v_key;
    else
      v_type := v_change ->> 'type';
      insert into public.miniprogram_skin_marks (user_id, skin_key, mark_type)
      values (p_user_id, v_key, v_type)
      on conflict (user_id, skin_key) do update
      set mark_type = excluded.mark_type;
    end if;
  end loop;

  select count(*)
  into v_count
  from public.miniprogram_skin_marks as s
  where s.user_id = p_user_id;

  if v_count > 2000 then
    raise exception 'mark limit exceeded' using errcode = '22023';
  end if;

  update public.miniprogram_users
  set marks_revision = marks_revision + 1
  where id = p_user_id
  returning marks_revision into v_result_revision;

  insert into public.miniprogram_mark_mutations (
    user_id,
    mutation_id,
    base_revision,
    changes,
    result_revision,
    result_mark_count,
    conflict
  ) values (
    p_user_id,
    p_mutation_id,
    p_base_revision,
    p_changes,
    v_result_revision,
    v_count,
    false
  );

  return query select v_result_revision, v_count, false, false;
end;
$function$;

-- Return a revision and its matching complete snapshot in one SQL statement.
-- PostgreSQL evaluates the revision and JSON aggregate against the same MVCC
-- statement snapshot. This avoids PostgREST's default 1,000-row limit and a
-- revision read racing separately fetched marks pages. On a hit, marks is [].
create function public.read_miniprogram_marks(
  p_user_id uuid,
  p_known_revision bigint default null
)
returns table (
  revision bigint,
  not_modified boolean,
  mark_count bigint,
  marks jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select
    u.marks_revision as revision,
    (
      p_known_revision is not null
      and p_known_revision = u.marks_revision
    ) as not_modified,
    aggregated.mark_count,
    aggregated.marks
  from public.miniprogram_users as u
  cross join lateral (
    select
      count(*)::bigint as mark_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object('key', s.skin_key, 'type', s.mark_type)
          order by s.skin_key
        ) filter (
          where not (
            p_known_revision is not null
            and p_known_revision = u.marks_revision
          )
        ),
        '[]'::jsonb
      ) as marks
    from public.miniprogram_skin_marks as s
    where s.user_id = u.id
  ) as aggregated
  where u.id = p_user_id;
$function$;

revoke all on function public.apply_miniprogram_mark_changes(uuid, jsonb, text, bigint)
  from public, anon, authenticated;
revoke all on function public.read_miniprogram_marks(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.enforce_miniprogram_session_limits()
  from public, anon, authenticated, service_role;
revoke all on function public.prune_miniprogram_mark_mutations()
  from public, anon, authenticated, service_role;

grant execute on function public.apply_miniprogram_mark_changes(uuid, jsonb, text, bigint)
  to service_role;
grant execute on function public.read_miniprogram_marks(uuid, bigint)
  to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'miniprogram-avatars',
  'miniprogram-avatars',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy miniprogram_server_manages_avatars_v2
on storage.objects
for all
to service_role
using (bucket_id = 'miniprogram-avatars')
with check (bucket_id = 'miniprogram-avatars');

comment on table public.miniprogram_users is
  'Server-only Mini Program identities and optional user-entered profiles.';
comment on column public.miniprogram_users.openid is
  'WeChat OpenID. Never returned to the Mini Program client.';
comment on column public.miniprogram_users.avatar_path is
  'Relative path in the private miniprogram-avatars bucket; never a signed URL.';
comment on table public.miniprogram_sessions is
  'Revocable opaque Mini Program sessions; only lowercase SHA-256 hashes are stored.';
comment on table public.miniprogram_skin_marks is
  'Current per-user owned/follow state, capped at 2,000 rows by the mutation RPC.';
comment on table public.miniprogram_mark_mutations is
  'Immutable idempotency receipts, including optimistic-concurrency conflicts.';
comment on function public.apply_miniprogram_mark_changes(uuid, jsonb, text, bigint) is
  'Atomically validates and applies one revision-guarded, idempotent marks batch.';
comment on function public.read_miniprogram_marks(uuid, bigint) is
  'Atomically returns a revision-aware complete marks snapshot as JSON.';
comment on function public.enforce_miniprogram_session_limits() is
  'Serializes session inserts and bounds each user to 8 active plus 64 terminal sessions.';
comment on function public.prune_miniprogram_mark_mutations() is
  'Retains mutation receipts for 120 days normally and enforces a 1,000-row per-user cap.';

commit;
