-- ENUMS
create type visibility_enum as enum ('public','private');
create type book_side_enum as enum ('foreign','native');

-- PROFILES
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  role text default 'user',
  created_at timestamptz default now()
);

-- BOOKS
create table books (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles,
  visibility visibility_enum not null,
  language_code char(2) not null,
  side book_side_enum not null,
  title text not null,
  author text,
  published_on date,
  cover_url text,
  epub_path text,
  json_blob jsonb,
  is_deleted boolean default false,
  search_vector tsvector,
  created_at timestamptz default now()
);

create index books_json_gin on books using gin(json_blob);
create index books_fts_gin on books using gin(search_vector);

-- BOOK‑PAIRS
create table book_pairs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles,
  foreign_book_id uuid not null references books,
  native_book_id uuid not null references books,
  alignment jsonb,
  created_at timestamptz default now()
);

-- READING PROGRESS
create table reading_progress (
  id bigint generated always as identity primary key,
  user_id uuid references profiles,
  pair_id uuid references book_pairs,
  cfi_location text,
  percent numeric,
  updated_at timestamptz default now()
);

-- SAVED WORDS
create table saved_words (
  id bigint generated always as identity primary key,
  user_id uuid references profiles,
  pair_id uuid references book_pairs,
  lemma text,
  inflection text,
  context text,
  created_at timestamptz default now()
);

create index saved_words_ctx_gin on saved_words
  using gin(to_tsvector('simple', context));

-- DICTIONARY TABLES
create table dictionary_inflections (
  inflection text primary key,
  lemma text,
  lang char(2)
);

create table lemmas (
  lemma text primary key,
  lang char(2),
  definition jsonb
);

-- Enable RLS
alter table profiles         enable row level security;
alter table books            enable row level security;
alter table book_pairs       enable row level security;
alter table reading_progress enable row level security;
alter table saved_words      enable row level security;

-- BOOKS
create policy read_public_books
  on books for select
  using (visibility = 'public' and is_deleted = false);

create policy owner_books
  on books for all
  using (owner_id = auth.uid());

create policy admin_override_books
  on books for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));

-- BOOK‑PAIRS
create policy read_pairs
  on book_pairs for select
  using (
       owner_id = auth.uid()
    or (select visibility from books b where b.id = foreign_book_id) = 'public'
       and (select visibility from books b where b.id = native_book_id) = 'public'
  );

create policy owner_pairs
  on book_pairs for all
  using (owner_id = auth.uid());

-- WORDS & PROGRESS
create policy own_words
  on saved_words for all
  using (user_id = auth.uid());

create policy own_progress
  on reading_progress for all
  using (user_id = auth.uid());

-- PROFILES
create policy "Allow users to read their own profile"
  on profiles for select
  using (id = auth.uid());

create policy "Allow users to update their own profile"
  on profiles for update
  using (id = auth.uid());

-- Storage bucket policy for private books
create policy private_book_owner
  on storage.objects
  for all using (
      bucket_id = 'private-books'
  and (metadata->>'owner_id')::uuid = auth.uid()
);

-- Function to handle new user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', 'User'),
    'user'
  );
  return new;
exception
  when unique_violation then
    -- Profile already exists, update it if needed
    update public.profiles 
    set display_name = coalesce(new.raw_user_meta_data->>'display_name', display_name)
    where id = new.id;
    return new;
end;
$$ language plpgsql security definer;

-- Trigger to automatically create profile on user signup
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Function to set admin role for a user
create or replace function public.set_user_admin(user_email text)
returns void as $$
begin
  update public.profiles 
  set role = 'admin'
  where id = (select id from auth.users where email = user_email);
  
  if not found then
    raise exception 'User with email % not found', user_email;
  end if;
end;
$$ language plpgsql security definer;