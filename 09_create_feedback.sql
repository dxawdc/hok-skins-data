-- Create user feedback table for Mini Program submissions.

create table if not exists public.feedback (
  id bigserial primary key,
  reporter text not null check (char_length(trim(reporter)) between 1 and 80),
  content text not null check (char_length(trim(content)) between 1 and 150),
  source text not null default 'miniprogram',
  page text not null default '',
  user_agent text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_created_at
  on public.feedback(created_at desc);

alter table public.feedback enable row level security;

comment on table public.feedback is 'User feedback submitted from the Mini Program.';
comment on column public.feedback.reporter is 'Wechat, phone number, nickname, or other contact name.';
comment on column public.feedback.content is 'Feedback content, capped at 150 characters.';
