-- UCVM Timetable: relational schema behind supabase-compat.js.
--
-- Every Firestore collection is a table keyed by the document id. Columns are
-- typed; supabase-compat.js stores a value in `extra`, under its original field
-- name, whenever it doesn't fit its column (numInstructors: "" for example).
-- Firestore never enforced a shape, so that keeps every document reading back
-- exactly as written while the typed columns stay clean. Non-key columns are
-- nullable for the same reason: documents are built up by partial writes.
--
-- id columns use COLLATE "C" so ORDER BY id matches Firestore's byte ordering.
-- Rows arrive in that order and the lab tables list stations by arrival order.
--
-- Session ids stored on history, change-log and request rows deliberately have
-- no foreign key: sessions are hard-deleted and those rows outlive them.

-- ── Tables ──────────────────────────────────────────────────────────────
create table public.courses (
  code         text primary key,
  dept         text not null,
  name         text not null,
  program_year smallint not null check (program_year between 1 and 3)
);

create table public.sessions (
  id                           text collate "C" primary key,
  date                         date,
  day                          text,
  week                         integer,
  date_range                   text,
  academic_cycle               text,
  start_time                   time,
  end_time                     time,
  year                         smallint check (year between 1 and 3),
  type                         text check (type in ('LEC','LAB','SRL','Quiz/Midterm','OSCE','Exam','Holiday','Event')),
  course                       text,
  course_name                  text,
  course_dept                  text,
  topic                        text,
  room                         text,
  "group"                      text,
  lab_group_id                 text,
  lab_column                   text,
  primary_instructor           text,
  secondary_instructor         text,
  primary_instructor_display   text,
  secondary_instructor_display text,
  finalized_instructors        text,
  instructor_proposed          text,
  num_instructors              integer,
  notes                        text,
  row_id                       text,
  sort_order                   text,
  created_at                   timestamptz,
  updated_at                   timestamptz,
  extra                        jsonb not null default '{}'::jsonb
);
create index sessions_date_id_idx on public.sessions (date, id);

-- Every save stores the whole session, so snapshot stays JSON: old versions
-- must remain restorable even if the session columns change later.
create table public.sessions_history (
  id         text collate "C" primary key,
  session_id text,
  saved_at   timestamptz,
  snapshot   jsonb not null default '{}'::jsonb
);
create index sessions_history_session_idx on public.sessions_history (session_id, saved_at desc);

create table public.change_log (
  id                 text collate "C" primary key,
  session_id         text,
  course_label       text,
  session_topic      text,
  session_year       text,
  session_type       text,
  session_start_time text,
  session_date       text,
  session_week       integer,
  changed_at         timestamptz,
  extra              jsonb not null default '{}'::jsonb
);
create index change_log_changed_at_idx on public.change_log (changed_at desc, id desc);

create table public.change_log_fields (
  change_log_id text collate "C" not null references public.change_log(id) on delete cascade,
  position      integer not null,
  field_label   text not null,
  old_value     text not null,
  new_value     text not null,
  primary key (change_log_id, position)
);

create table public.roster (
  id     text collate "C" primary key,  -- '{year}_{ucid}'
  year   text check (year in ('year1','year2','year3')),
  ucid   text,
  group6 text,
  group5 text,
  group4 text,
  group3 text,
  group2 text,
  extra  jsonb not null default '{}'::jsonb
);

-- Known ids: sessionsVersion, rosterNotice, stagingRefresh (status etc. in extra).
create table public.settings (
  id         text collate "C" primary key,
  value      text,
  updated_at timestamptz,
  extra      jsonb not null default '{}'::jsonb
);

create table public.authorized_users (
  id          text collate "C" primary key,  -- lower-cased email
  email       text,
  name        text,
  role        text check (role in ('cc','instructor','adfad','dvm_office','adc')),
  imported_at timestamptz,
  extra       jsonb not null default '{}'::jsonb
);

create table public.users (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text,
  name           text,
  name_lower     text,
  role           text check (role in ('cc','instructor','adfad','dvm_office','adc')),
  requested_role text check (requested_role in ('cc','instructor','adfad','dvm_office','adc')),
  status         text check (status in ('pending','active','rejected','revoked')),
  created_at     timestamptz,
  reviewed_by    text,
  reviewed_at    timestamptz,
  revoked_by     text,
  revoked_at     timestamptz,
  extra          jsonb not null default '{}'::jsonb
);
create index users_status_idx on public.users (status);
create index users_email_idx on public.users (email);

create table public.access_requests (
  id           text collate "C" primary key,
  name         text,
  email        text,
  claimed_role text check (claimed_role in ('cc','instructor','adfad','dvm_office','adc')),
  note         text,
  status       text check (status in ('pending','fulfilled','rejected')),
  created_at   timestamptz,
  reviewed_by  text,
  reviewed_at  timestamptz,
  extra        jsonb not null default '{}'::jsonb
);
create index access_requests_status_idx on public.access_requests (status);

create table public.change_requests (
  id                       text collate "C" primary key,
  request_type             text check (request_type in ('topic','type_change','swap')),
  status                   text check (status in ('pending_faculty_b','pending','pending_dvm','approved','rejected')),
  session_id               text,
  session_summary          jsonb,
  session_a_id             text,
  session_a_summary        jsonb,
  session_b_id             text,
  session_b_summary        jsonb,
  old_topic                text,
  new_topic                text,
  old_type                 text,
  new_type                 text,
  swap_fields              jsonb,
  swap_field_labels        jsonb,
  faculty_b_name           text,
  faculty_b_name_lower     text,
  reason                   text,
  requested_by_uid         text,
  requested_by_email       text,
  requested_by_name        text,
  requested_by_role        text,
  created_at               timestamptz,
  rejected_stage           text,
  review_note              text,
  reviewed_by_uid          text,
  reviewed_by_email        text,
  reviewed_by_name         text,
  reviewed_by_role         text,
  reviewed_at              timestamptz,
  checklist_invite_update  boolean,
  checklist_dvm_hub_update boolean,
  checklist_d2l_update     boolean,
  extra                    jsonb not null default '{}'::jsonb
);
create index change_requests_status_idx on public.change_requests (status);
create index change_requests_requested_by_idx on public.change_requests (requested_by_uid);
create index change_requests_faculty_b_idx on public.change_requests (faculty_b_name_lower);

-- One row per stage object (facultyBReview, adfadReview, dvmReview, adcReview).
create table public.change_request_reviews (
  request_id     text collate "C" not null references public.change_requests(id) on delete cascade,
  stage          text not null check (stage in ('faculty_b','adfad','dvm_office','adc')),
  decision       text not null check (decision in ('approved','rejected')),
  reviewer_uid   text,
  reviewer_email text,
  reviewer_name  text,
  reviewer_role  text,
  note           text,
  reviewed_at    timestamptz,
  primary key (request_id, stage)
);

create table public.admin_audit_log (
  id          text collate "C" primary key,
  type        text,
  summary     text,
  detail      jsonb,
  actor_uid   text,
  actor_email text,
  at          timestamptz,
  extra       jsonb not null default '{}'::jsonb
);

-- ── Role helpers (same names and meaning as firestore.rules) ────────────
create function public.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'dvmprogram@ucalgary.ca'
$$;

-- SECURITY DEFINER: these read users from inside users' own policies.
create function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.users where id = auth.uid() and status = 'active'
$$;

create function public.my_name_lower() returns text
language sql stable security definer set search_path = '' as $$
  select name_lower from public.users where id = auth.uid()
$$;

create function public.is_approver() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(public.my_role() in ('adfad','dvm_office','adc'), false)
$$;

-- Replaces writesAllowed(): blocks browser writes during a staging refresh.
create function public.writes_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.settings
    where id = 'stagingRefresh' and extra ->> 'status' in ('refreshing','failed')
  )
$$;

-- firestore.rules allows only the admin here, but approvals.js writes these
-- tables while signed in as DVM Office or ADC when it applies a final approval,
-- so those two roles are included or that step could never succeed.
create function public.can_write_timetable() returns boolean
language sql stable set search_path = '' as $$
  select public.is_admin() or coalesce(public.my_role() in ('dvm_office','adc'), false)
$$;

create function public.can_update_change_request(faculty_b text) returns boolean
language sql stable set search_path = '' as $$
  select public.is_approver() or public.is_admin()
      or (faculty_b is not null and faculty_b = public.my_name_lower())
$$;

-- ── Single write path for supabase-compat.js ────────────────────────────
-- One call is one transaction, which is what makes a Firestore batch atomic
-- here. SECURITY INVOKER, so the policies below decide what's allowed.
--
-- ops: [{ op, table, key, cols, extra_set, extra_del }]
--   create   insert a new row
--   replace  overwrite the whole row, or insert it
--   merge    change only the given columns, or insert
--   update   change only the given columns; the row must exist
--   delete   delete rows matching key
create function public.apply_writes(ops jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  allowed constant text[] := array['sessions','sessions_history','change_log','change_log_fields','roster',
    'settings','authorized_users','users','access_requests','change_requests','change_request_reviews','admin_audit_log'];
  stamp text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  o jsonb; tbl text; kind text; rowkey jsonb; cols jsonb; extra_set jsonb; extra_del text[];
  where_sql text; data jsonb; col_list text; assign text; has_extra boolean; visible boolean; n bigint;
begin
  ops := replace(ops::text, '__SUPABASE_COMPAT_SERVER_TS__', stamp)::jsonb;

  for o in select value from jsonb_array_elements(ops) loop
    tbl := o ->> 'table';
    kind := o ->> 'op';
    if not tbl = any(allowed) then
      raise exception 'apply_writes: table % is not writable', tbl using errcode = '42501';
    end if;
    rowkey := o -> 'key';
    cols := coalesce(o -> 'cols', '{}'::jsonb);
    extra_set := coalesce(o -> 'extra_set', '{}'::jsonb);
    extra_del := array(select jsonb_array_elements_text(coalesce(o -> 'extra_del', '[]'::jsonb)));

    select string_agg(format('%I.%I = %L', tbl, k, v), ' and ') into where_sql from jsonb_each_text(rowkey) as e(k, v);

    if kind = 'delete' then
      execute format('delete from %I where %s', tbl, where_sql);
      get diagnostics n = row_count;
      -- RLS turns a refused write into "0 rows"; Firestore reports it as an error.
      if n = 0 then
        execute format('select exists (select 1 from %I where %s)', tbl, where_sql) into visible;
        if visible then raise exception 'Missing or insufficient permissions.' using errcode = '42501'; end if;
      end if;
      continue;
    end if;

    data := rowkey || cols;
    has_extra := exists (select 1 from pg_attribute
      where attrelid = format('public.%I', tbl)::regclass and attname = 'extra' and not attisdropped);
    if has_extra then data := data || jsonb_build_object('extra', extra_set); end if;
    select string_agg(format('%I', k), ', ') into col_list from jsonb_object_keys(data) as k;

    if kind = 'create' then
      execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)', tbl, col_list, col_list, tbl) using data;
      continue;
    end if;

    if kind = 'replace' then
      select string_agg(format('%I = r.%I', attname, attname), ', ') into assign from pg_attribute
        where attrelid = format('public.%I', tbl)::regclass and attnum > 0 and not attisdropped
          and not rowkey ? attname::text;
    else
      select string_agg(p, ', ') into assign from (
        select format('%I = r.%I', k, k) as p from jsonb_object_keys(cols) as k
        union all
        select format('extra = (%I.extra - $2) || $3', tbl)
          where has_extra and (extra_set <> '{}'::jsonb or cardinality(extra_del) > 0)
      ) parts;
    end if;
    if assign is null then
      -- Nothing to change, but the row still has to exist for update/merge.
      assign := (select format('%I = r.%I', k, k) from jsonb_object_keys(rowkey) as k limit 1);
    end if;
    execute format('update %I set %s from jsonb_populate_record(null::%I, $1) as r where %s', tbl, assign, tbl, where_sql)
      using data, extra_del, extra_set;

    get diagnostics n = row_count;
    if n = 0 then
      execute format('select exists (select 1 from %I where %s)', tbl, where_sql) into visible;
      if visible then raise exception 'Missing or insufficient permissions.' using errcode = '42501'; end if;
      if kind = 'update' then
        raise exception 'No document to update: %/%', tbl, rowkey using errcode = 'P0002';
      end if;
      execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)', tbl, col_list, col_list, tbl) using data;
    end if;
  end loop;
end;
$$;

-- The browser can't delete its own Supabase login, so "Delete my account" and
-- the blocked-signup rollback come through here.
create function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users where id = auth.uid()
$$;

-- ── Row-level security (mirrors firestore.rules) ────────────────────────
alter table public.courses                enable row level security;
alter table public.sessions               enable row level security;
alter table public.sessions_history       enable row level security;
alter table public.change_log             enable row level security;
alter table public.change_log_fields      enable row level security;
alter table public.roster                 enable row level security;
alter table public.settings               enable row level security;
alter table public.authorized_users       enable row level security;
alter table public.users                  enable row level security;
alter table public.access_requests        enable row level security;
alter table public.change_requests        enable row level security;
alter table public.change_request_reviews enable row level security;
alter table public.admin_audit_log        enable row level security;

create policy read_all on public.courses           for select using (true);
create policy read_all on public.sessions          for select using (true);
create policy read_all on public.sessions_history  for select using (true);
create policy read_all on public.change_log        for select using (true);
create policy read_all on public.change_log_fields for select using (true);
create policy read_all on public.settings          for select using (true);
create policy read_all on public.roster            for select using (true);

create policy timetable_write on public.sessions          for all to authenticated using (public.can_write_timetable() and public.writes_allowed()) with check (public.can_write_timetable() and public.writes_allowed());
create policy timetable_write on public.sessions_history  for all to authenticated using (public.can_write_timetable() and public.writes_allowed()) with check (public.can_write_timetable() and public.writes_allowed());
create policy timetable_write on public.change_log        for all to authenticated using (public.can_write_timetable() and public.writes_allowed()) with check (public.can_write_timetable() and public.writes_allowed());
create policy timetable_write on public.change_log_fields for all to authenticated using (public.can_write_timetable() and public.writes_allowed()) with check (public.can_write_timetable() and public.writes_allowed());
create policy timetable_write on public.settings          for all to authenticated using (public.can_write_timetable() and public.writes_allowed()) with check (public.can_write_timetable() and public.writes_allowed());
create policy admin_write     on public.roster            for all to authenticated using (public.is_admin() and public.writes_allowed()) with check (public.is_admin() and public.writes_allowed());

-- Postgres can't split Firestore's get from list, so these two are own-row or
-- admin. The app only ever reads its own row here.
create policy own_or_admin on public.authorized_users for select to authenticated
  using (public.is_admin() or id = lower(auth.jwt() ->> 'email'));
create policy admin_write on public.authorized_users for all to authenticated
  using (public.is_admin() and public.writes_allowed()) with check (public.is_admin() and public.writes_allowed());

create policy own_or_admin on public.users for select to authenticated using (id = auth.uid() or public.is_admin());
create policy create_own   on public.users for insert to authenticated with check (id = auth.uid() and public.writes_allowed());
create policy admin_update on public.users for update to authenticated using (public.is_admin() and public.writes_allowed()) with check (public.is_admin() and public.writes_allowed());
create policy delete_own   on public.users for delete to authenticated using (public.writes_allowed() and (public.is_admin() or id = auth.uid()));

create policy anyone_create on public.access_requests for insert to anon, authenticated with check (public.writes_allowed());
create policy admin_read    on public.access_requests for select to authenticated using (public.is_admin());
create policy admin_update  on public.access_requests for update to authenticated using (public.is_admin() and public.writes_allowed()) with check (public.is_admin() and public.writes_allowed());

create policy signed_in_read   on public.change_requests for select to authenticated using (true);
create policy signed_in_create on public.change_requests for insert to authenticated with check (public.writes_allowed());
create policy reviewers_update on public.change_requests for update to authenticated
  using (public.writes_allowed() and public.can_update_change_request(faculty_b_name_lower))
  with check (public.writes_allowed() and public.can_update_change_request(faculty_b_name_lower));

create policy signed_in_read on public.change_request_reviews for select to authenticated using (true);
create policy reviewers_write on public.change_request_reviews for all to authenticated
  using (public.writes_allowed() and exists (select 1 from public.change_requests c where c.id = request_id and public.can_update_change_request(c.faculty_b_name_lower)))
  with check (public.writes_allowed() and exists (select 1 from public.change_requests c where c.id = request_id and public.can_update_change_request(c.faculty_b_name_lower)));

create policy admin_read      on public.admin_audit_log for select to authenticated using (public.is_admin());
create policy reviewer_create on public.admin_audit_log for insert to authenticated with check (public.writes_allowed() and (public.is_admin() or public.is_approver()));

-- ── Grants: Supabase grants everything by default, so start from nothing ─
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant select on public.courses, public.sessions, public.sessions_history, public.change_log,
  public.change_log_fields, public.settings, public.roster to anon;
grant insert on public.access_requests to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

grant execute on function public.is_admin(), public.my_role(), public.my_name_lower(), public.is_approver(),
  public.writes_allowed(), public.can_write_timetable(), public.can_update_change_request(text),
  public.apply_writes(jsonb) to anon, authenticated, service_role;
grant execute on function public.delete_my_account() to authenticated;

-- ── Realtime: only the three public feeds the app listens to ────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.settings, public.change_log, public.roster;
  end if;
end $$;

-- ── Reference data (courseData.js) ──────────────────────────────────────
insert into public.courses (code, dept, name, program_year) VALUES
  ('200','VTMD','Introduction to Veterinary Medicine',1),
  ('202','VTMD','Professional Identity Formation I',1),
  ('204','VTMD','Exploring Veterinary Medicine I',1),
  ('206','VTMD','Healthy Animals I',1),
  ('211','VTMD','Practical Work Experience I',1),
  ('213','VTMD','Animals As Populations',1),
  ('215','VTMD','What Is A Veterinarian',1),
  ('217','VTMD','Healthy Animals II',1),
  ('302','VTMD','Professional Identity Formation II',2),
  ('304','VTMD','Science of What Goes Wrong I',2),
  ('306','VTMD','Science of What Goes Wrong II',2),
  ('308','VTMD','Fundamentals of Diagnosis, Management and Treatment',2),
  ('311','VTMD','Practical Work Experience II',2),
  ('313','VTMD','Veterinarians in Society',2),
  ('315','VTMD','Head, Oral, and Gastrointestinal',2),
  ('317','VTMD','Endocrine, Renal, and Reproduction',2),
  ('319','VTMD','Neonatal, Special Senses, Alternative Species',2),
  ('440','VETM','One Health and Veterinary Practice',3),
  ('501','VETM','Clinical Presentations III',3),
  ('505','VETM','Clinical Skills III',3),
  ('506','VETM','Investigative Veterinary Medicine and Science Communication',3),
  ('508','VETM','Professional Skills III',3),
  ('521','VETM','Equine Medicine and Surgery',3),
  ('522','VETM','Small Animal Medicine and Surgery',3),
  ('523','VETM','Anesthesiology and Therapeutics',3),
  ('525','VETM','Advanced Health Management',3),
  ('530','VETM','Selected Topics in Clinical Medicine',3),
  ('531','VETM','Selected Topics in Small Ruminant, South American Camelid and Non-traditional Livestock Production',3),
  ('540','VETM','Food Animal Medicine and Surgery',3),
  ('541','VETM','Theriogenology',3),
  ('542','VETM','Emergency and Critical Care',3),
  ('550','VETM','Zoological Medicine',3),
  ('551','VETM','Laboratory Animal Medicine',3);
