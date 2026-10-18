-- Replace the shared publishing key with Supabase Auth accounts.
alter table public.bundles
  add column owner_id uuid references auth.users (id) on delete set null,
  add column review jsonb check (review is null or jsonb_typeof(review) = 'object');

create index bundles_owner_created_idx on public.bundles (owner_id, created_at desc);

drop policy "Registry can publish bundles" on public.bundles;
drop policy "Anyone can read shared bundles" on public.bundles;

-- Inserts come only from the publishing API (secret key), after the server review.
-- owner_id is not readable by the public.
revoke all on table public.bundles from anon, authenticated;
grant select (slug, title, manifest, checksum, review, created_at) on table public.bundles to anon, authenticated;
grant delete on table public.bundles to authenticated;

create policy "Anyone can read shared bundles"
on public.bundles for select
to anon, authenticated
using (true);

create policy "Owners can delete their bundles"
on public.bundles for delete
to authenticated
using (owner_id = (select auth.uid()));

create function public.check_bundle_publisher() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is null then
    raise exception 'Bundle owner is required';
  end if;
  if (select count(*) from public.bundles where owner_id = new.owner_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Daily publishing limit reached (20 bundles in 24 hours)';
  end if;
  return new;
end;
$$;

create trigger bundles_check_publisher
before insert on public.bundles
for each row execute function public.check_bundle_publisher();
