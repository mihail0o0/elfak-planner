-- Planer ispita – šema za Supabase (pokreni jednom u SQL Editor-u).
-- Aplikacija čuva podatke kao dokumente (putanja → JSON), isto kao u claude.ai verziji.
--   rokovi/<id>, ispiti/<id>__<n>      zajednički rasporedi (čitaju svi, pišu potvrđeni korisnici)
--   people/<uid>                        javna kartica korisnika (čitaju potvrđeni, piše samo vlasnik)
--   box/<uid>/c/<chatId>                poruke korisnika (čitaju potvrđeni, piše samo vlasnik; privatni četovi su šifrovani)
--   data/users/<uid>/...                lični profil i plan (samo vlasnik)

create table if not exists public.docs (
  path       text primary key,
  parent     text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists docs_parent_idx on public.docs (parent);
alter table public.docs replica identity full;

-- potvrđen nalog: email potvrđen (Google/Facebook su potvrđeni automatski) i nije anoniman
create or replace function public.is_verified() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null and coalesce(u.is_anonymous, false) = false
  );
$$;

-- vlasnik dela baze određen putanjom
create or replace function public.path_owner(p text) returns text
language sql immutable as $$
  select case
    when p like 'people/%' then split_part(p, '/', 2)
    when p like 'box/%' then split_part(p, '/', 2)
    when p like 'data/users/%' then split_part(p, '/', 3)
    else null end;
$$;

create or replace function public.docs_set_parent() returns trigger language plpgsql as $$
begin
  new.parent := regexp_replace(new.path, '/[^/]+$', '');
  new.updated_at := now();
  if length(new.data::text) > 300000 then raise exception 'document too large'; end if;
  return new;
end $$;
drop trigger if exists docs_parent on public.docs;
create trigger docs_parent before insert or update on public.docs for each row execute function public.docs_set_parent();

alter table public.docs enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select using (
  parent in ('rokovi', 'ispiti')
  or ((parent = 'people' or path like 'box/%') and public.is_verified())
  or (path like 'data/users/%' and public.path_owner(path) = auth.uid()::text)
);

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert with check (
  public.is_verified() and (
    parent in ('rokovi', 'ispiti')
    or public.path_owner(path) = auth.uid()::text
  )
);

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update using (
  public.is_verified() and (parent in ('rokovi', 'ispiti') or public.path_owner(path) = auth.uid()::text)
) with check (
  public.is_verified() and (parent in ('rokovi', 'ispiti') or public.path_owner(path) = auth.uid()::text)
);

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete using (
  public.is_verified() and (parent in ('rokovi', 'ispiti') or public.path_owner(path) = auth.uid()::text)
);

-- izmene uživo (poruke, prijatelji)
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- prilozi u porukama: javni bucket (link znaju samo učesnici razgovora), otprema samo potvrđenim korisnicima
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

drop policy if exists attachments_insert on storage.objects;
create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_verified());
drop policy if exists attachments_delete on storage.objects;
create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and owner = auth.uid());
