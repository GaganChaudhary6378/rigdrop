create extension if not exists pgcrypto;

create table public.bundles (
  slug text primary key default replace(gen_random_uuid()::text, '-', ''),
  title text not null check (char_length(title) between 1 and 120),
  manifest jsonb not null check (
    jsonb_typeof(manifest) = 'object'
    and octet_length(convert_to(manifest::text, 'UTF8')) <= 2097152
  ),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.bundles enable row level security;

revoke all on table public.bundles from anon, authenticated;
grant select, insert on table public.bundles to anon;

create policy "Anyone can read shared bundles"
on public.bundles for select
to anon
using (true);

create policy "Registry can publish bundles"
on public.bundles for insert
to anon
with check (
  encode(
    digest(
      coalesce(current_setting('request.headers', true)::jsonb ->> 'x-agent-setup-key', ''),
      'sha256'
    ),
    'hex'
  ) = '8c5764e364b37f2b5a47f1157e7f6c137b0423a605f012dd5261c7212d33f318'
);

create index bundles_created_at_idx on public.bundles (created_at desc);
