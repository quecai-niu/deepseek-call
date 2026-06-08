-- Conversation management schema for Supabase/Postgres.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content text not null default '',
  reasoning_content text,
  model text,
  token_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  mime_type text,
  byte_size bigint,
  storage_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.tool_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  status text not null default 'completed',
  input jsonb not null default '{}'::jsonb,
  output text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  summary text not null,
  message_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_user_updated
  on public.conversations(user_id, updated_at desc);

create index if not exists idx_messages_conversation_created
  on public.messages(conversation_id, created_at asc);

create index if not exists idx_messages_user_conversation
  on public.messages(user_id, conversation_id);

create index if not exists idx_attachments_conversation
  on public.attachments(conversation_id, created_at desc);

create index if not exists idx_tool_runs_conversation
  on public.tool_runs(conversation_id, created_at desc);

create index if not exists idx_conversation_summaries_conversation
  on public.conversation_summaries(conversation_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.tool_runs enable row level security;
alter table public.conversation_summaries enable row level security;

drop policy if exists "profiles are owned by user" on public.profiles;
create policy "profiles are owned by user"
on public.profiles
for all
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "conversations are owned by user" on public.conversations;
create policy "conversations are owned by user"
on public.conversations
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "messages are owned by user" on public.messages;
create policy "messages are owned by user"
on public.messages
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "attachments are owned by user" on public.attachments;
create policy "attachments are owned by user"
on public.attachments
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "tool runs are owned by user" on public.tool_runs;
create policy "tool runs are owned by user"
on public.tool_runs
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "conversation summaries are owned by user" on public.conversation_summaries;
create policy "conversation summaries are owned by user"
on public.conversation_summaries
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
