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

create policy "Allow users to insert their own profile"
  on profiles for insert
  with check (id = auth.uid());

create policy "Allow users to update their own profile"
  on profiles for update
  using (id = auth.uid());

-- Storage bucket policy for private books - select, update, delete
create policy private_book_select
  on storage.objects
  for select using (
      bucket_id = 'private-books'
  and (metadata->>'owner_id')::uuid = auth.uid()
);

create policy private_book_insert
  on storage.objects
  for insert with check (
      bucket_id = 'private-books'
  and (metadata->>'owner_id')::uuid = auth.uid()
);

create policy private_book_update
  on storage.objects
  for update using (
      bucket_id = 'private-books'
  and (metadata->>'owner_id')::uuid = auth.uid()
);

create policy private_book_delete
  on storage.objects
  for delete using (
      bucket_id = 'private-books'
  and (metadata->>'owner_id')::uuid = auth.uid()
);

-- Storage bucket policy for public books - allow reading public books
create policy public_book_read
  on storage.objects
  for select using (bucket_id = 'public-books');

-- Storage bucket policy for public books - only admins and owners can upload
create policy public_book_upload
  on storage.objects
  for insert with check (
      bucket_id = 'public-books'
  and (
    (metadata->>'owner_id')::uuid = auth.uid()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- Storage bucket policy for public books - only admins and owners can update/delete
create policy public_book_manage
  on storage.objects
  for update using (
      bucket_id = 'public-books'
  and (
    (metadata->>'owner_id')::uuid = auth.uid()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy public_book_delete
  on storage.objects
  for delete using (
      bucket_id = 'public-books'
  and (
    (metadata->>'owner_id')::uuid = auth.uid()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
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

-- EPUB Content Functions and Views
-- Function to extract EPUB metadata from json_blob
create or replace function public.get_epub_metadata(book_record books)
returns jsonb as $$
begin
  return book_record.json_blob->'metadata';
end;
$$ language plpgsql stable;

-- Function to extract EPUB structure info from json_blob
create or replace function public.get_epub_structure(book_record books)
returns jsonb as $$
begin
  return book_record.json_blob->'structure';
end;
$$ language plpgsql stable;

-- Function to get chapter count from EPUB content
create or replace function public.get_chapter_count(book_record books)
returns integer as $$
begin
  return coalesce((book_record.json_blob->'structure'->>'totalChapters')::integer, 0);
end;
$$ language plpgsql stable;

-- Function to get word count from EPUB content
create or replace function public.get_word_count(book_record books)
returns integer as $$
begin
  return coalesce((book_record.json_blob->'structure'->>'wordCount')::integer, 0);
end;
$$ language plpgsql stable;

-- Function to get estimated reading time from EPUB content
create or replace function public.get_reading_time(book_record books)
returns integer as $$
begin
  return coalesce((book_record.json_blob->'structure'->>'estimatedReadingTime')::integer, 0);
end;
$$ language plpgsql stable;

-- Function to search within EPUB chapter content
create or replace function public.search_epub_content(
  book_id uuid,
  search_query text
)
returns table(
  chapter_id text,
  chapter_title text,
  chapter_order integer,
  excerpt text,
  rank real
) as $$
begin
  return query
  select 
    (chapter.value->>'id')::text,
    (chapter.value->>'title')::text,
    (chapter.value->>'order')::integer,
    substring(chapter.value->>'textContent' from 1 for 200) as excerpt,
    ts_rank(
      to_tsvector('english', chapter.value->>'textContent'),
      plainto_tsquery('english', search_query)
    ) as rank
  from books b,
       jsonb_array_elements(b.json_blob->'chapters') as chapter
  where b.id = book_id
    and b.json_blob is not null
    and to_tsvector('english', chapter.value->>'textContent') @@ plainto_tsquery('english', search_query)
  order by rank desc, (chapter.value->>'order')::integer;
end;
$$ language plpgsql stable;

-- Function to get table of contents from EPUB
create or replace function public.get_epub_toc(book_record books)
returns jsonb as $$
begin
  return book_record.json_blob->'structure'->'tableOfContents';
end;
$$ language plpgsql stable;

-- Function to get specific chapter content by order
create or replace function public.get_chapter_by_order(
  book_id uuid,
  chapter_order integer
)
returns jsonb as $$
declare
  result jsonb;
begin
  select chapter.value
  into result
  from books b,
       jsonb_array_elements(b.json_blob->'chapters') as chapter
  where b.id = book_id
    and (chapter.value->>'order')::integer = chapter_order;
  
  return result;
end;
$$ language plpgsql stable;

-- Function to get chapter content by ID
create or replace function public.get_chapter_by_id(
  book_id uuid,
  chapter_id text
)
returns jsonb as $$
declare
  result jsonb;
begin
  select chapter.value
  into result
  from books b,
       jsonb_array_elements(b.json_blob->'chapters') as chapter
  where b.id = book_id
    and chapter.value->>'id' = chapter_id;
  
  return result;
end;
$$ language plpgsql stable;

-- Function to update search vector with EPUB content
create or replace function public.update_book_search_vector()
returns trigger as $$
begin
  -- Combine title, author, and all chapter text content for search
  new.search_vector := 
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.author, '')), 'B') ||
    setweight(
      to_tsvector('english', 
        coalesce(
          string_agg(
            chapter.value->>'textContent', ' '
          ), ''
        )
      ), 'C'
    )
  from jsonb_array_elements(coalesce(new.json_blob->'chapters', '[]'::jsonb)) as chapter;
  
  return new;
end;
$$ language plpgsql;

-- Trigger to automatically update search vector when book is inserted/updated
create trigger update_books_search_vector
  before insert or update on books
  for each row execute function update_book_search_vector();

-- View for enhanced book information with EPUB metadata
create view book_details as
select 
  b.*,
  get_chapter_count(b) as chapter_count,
  get_word_count(b) as word_count,
  get_reading_time(b) as reading_time_minutes,
  (b.json_blob->'metadata'->>'publisher') as publisher,
  (b.json_blob->'metadata'->>'publishedDate') as epub_published_date,
  (b.json_blob->'metadata'->>'description') as description,
  (b.json_blob->'parsing'->>'parsedAt') as content_parsed_at,
  (b.json_blob->'parsing'->>'epubVersion') as epub_version,
  case 
    when b.json_blob is not null then true 
    else false 
  end as has_parsed_content
from books b;

-- View for book pairs with aggregated statistics  
create view book_pair_details as
select 
  bp.*,
  fb.title as foreign_title,
  fb.author as foreign_author,
  fb.language_code as foreign_language,
  get_chapter_count(fb) as foreign_chapter_count,
  get_word_count(fb) as foreign_word_count,
  nb.title as native_title,
  nb.author as native_author,
  nb.language_code as native_language,
  get_chapter_count(nb) as native_chapter_count,
  get_word_count(nb) as native_word_count,
  case 
    when get_chapter_count(fb) > 0 and get_chapter_count(nb) > 0 then true
    else false
  end as both_books_parsed
from book_pairs bp
join books fb on bp.foreign_book_id = fb.id
join books nb on bp.native_book_id = nb.id;

-- Indexes for better performance on EPUB queries
create index books_json_metadata_gin on books using gin((json_blob->'metadata'));
create index books_json_structure_gin on books using gin((json_blob->'structure'));
create index books_json_chapters_gin on books using gin((json_blob->'chapters'));