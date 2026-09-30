-- =====================================================================
--  Didriksons Poolkollen – demo-databas
--  Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
--  Filen går att köra igen; då byggs tabellerna om och demodatan återställs.
--
--  Demoinloggningar (lösenord för alla: demo1234)
--    tekniker@poolkollen.demo  – personal, ser alla pooler
--    anna@poolkollen.demo      – kund, ser bara sin egen pool
--    berg@poolkollen.demo      – kund med larm på sin pool
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Rensa (så att filen kan köras igen)
-- ---------------------------------------------------------------------
drop view if exists public.pool_latest;
drop table if exists public.bookings, public.readings, public.profiles, public.pools, public.customers cascade;

-- ---------------------------------------------------------------------
-- Tabeller
-- ---------------------------------------------------------------------
create table public.customers (
  id           uuid primary key default gen_random_uuid(),
  sort         int not null unique,
  name         text not null,
  contact_name text,
  area         text not null
);

create table public.pools (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers on delete cascade,
  name          text not null default 'Pool',
  volume_m3     int  not null default 45,
  sanitizer     text not null default 'Klor',
  -- parametrar för den simulerade sensorn (bara för demon)
  seed          int  not null default 1,
  sim_ph_start  numeric not null,
  sim_ph        numeric not null,
  sim_orp_start int  not null,
  sim_orp       int  not null,
  sim_temp      numeric not null,
  sim_offline   boolean not null default false
);

create table public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text,
  role        text not null check (role in ('staff', 'customer')),
  customer_id uuid references public.customers on delete set null
);

create table public.readings (
  id          bigint generated always as identity primary key,
  pool_id     uuid not null references public.pools on delete cascade,
  measured_at timestamptz not null default now(),
  ph          numeric(4,2),
  orp         int,
  temp        numeric(4,1)
);
create index readings_pool_time on public.readings (pool_id, measured_at desc);

create table public.bookings (
  id          uuid primary key default gen_random_uuid(),
  pool_id     uuid not null references public.pools on delete cascade,
  customer_id uuid not null references public.customers on delete cascade,
  kind        text not null check (kind in ('service', 'stangning', 'oppning')),
  date        date not null,
  slot        text not null,
  start_h     int  not null,
  end_h       int  not null,
  status      text not null default 'ny' check (status in ('ny', 'bekraftad')),
  note        text,
  created_at  timestamptz not null default now()
);
create index bookings_date on public.bookings (date);

-- ---------------------------------------------------------------------
-- Hjälpfunktioner för behörighet
-- ---------------------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'staff');
$$;

create or replace function public.my_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select customer_id from profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Row Level Security: personal ser allt, kunder bara sitt eget
-- ---------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.pools     enable row level security;
alter table public.profiles  enable row level security;
alter table public.readings  enable row level security;
alter table public.bookings  enable row level security;

create policy customers_read on public.customers for select to authenticated
  using (public.is_staff() or id = public.my_customer_id());

create policy pools_read on public.pools for select to authenticated
  using (public.is_staff() or customer_id = public.my_customer_id());

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

create policy readings_read on public.readings for select to authenticated
  using (public.is_staff() or pool_id in (select id from public.pools where customer_id = public.my_customer_id()));

create policy bookings_read on public.bookings for select to authenticated
  using (public.is_staff() or customer_id = public.my_customer_id());

create policy bookings_update on public.bookings for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- personal kan ta bort allt; kunder kan avboka egna obekräftade bokningar
create policy bookings_delete on public.bookings for delete to authenticated
  using (public.is_staff() or (customer_id = public.my_customer_id() and status = 'ny'));
-- Nya bokningar skapas bara via funktionen book_visit (som kontrollerar allt).

grant select on public.customers, public.pools, public.profiles, public.readings, public.bookings to authenticated;
grant update, delete on public.bookings to authenticated;

-- Senaste mätvärdet per pool (respekterar RLS)
create view public.pool_latest with (security_invoker = true) as
  select distinct on (r.pool_id) r.pool_id, r.measured_at, r.ph, r.orp, r.temp
  from public.readings r
  order by r.pool_id, r.measured_at desc;
grant select on public.pool_latest to authenticated;

-- ---------------------------------------------------------------------
-- Läsfunktioner för appen (respekterar RLS)
-- ---------------------------------------------------------------------
create or replace function public.pool_trend_24h()
returns table (pool_id uuid, ph numeric[])
language sql stable set search_path = public as $$
  select s.pool_id, array_agg(s.avg_ph order by s.h)
  from (
    select r.pool_id, date_trunc('hour', r.measured_at) as h, round(avg(r.ph), 2) as avg_ph
    from readings r
    where r.measured_at > now() - interval '24 hours'
    group by 1, 2
  ) s
  group by s.pool_id;
$$;

create or replace function public.pool_history(p_pool uuid, p_days int default 7)
returns table (h timestamptz, ph numeric, orp numeric, temp numeric)
language sql stable set search_path = public as $$
  select date_trunc('hour', r.measured_at), round(avg(r.ph), 2), round(avg(r.orp)), round(avg(r.temp), 1)
  from readings r
  where r.pool_id = p_pool and r.measured_at > now() - make_interval(days => p_days)
  group by 1
  order by 1;
$$;

-- Upptagna tider (utan namn) så att kunder kan se lediga tider
create or replace function public.booked_ranges(p_from date, p_to date)
returns table (date date, start_h int, end_h int)
language sql stable security definer set search_path = public as $$
  select b.date, b.start_h, b.end_h from bookings b where b.date between p_from and p_to;
$$;

-- ---------------------------------------------------------------------
-- Bokning (kund)
-- ---------------------------------------------------------------------
create or replace function public.book_visit(p_kind text, p_date date, p_slot text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid := my_customer_id();
  v_pool     uuid;
  v_today    date := (now() at time zone 'Europe/Stockholm')::date;
  v_month    int  := extract(month from p_date);
  v_start    int;
  v_end      int;
  v_id       uuid;
begin
  if v_customer is null then
    raise exception 'Bara kunder kan boka här';
  end if;
  select id into v_pool from pools where customer_id = v_customer order by id limit 1;
  if v_pool is null then
    raise exception 'Hittar ingen pool kopplad till kontot';
  end if;
  if p_kind = 'service' then
    if p_slot not in ('08–09', '09–10', '10–11', '13–14', '14–15', '15–16') then
      raise exception 'Ogiltig tid';
    end if;
  elsif p_kind in ('stangning', 'oppning') then
    if p_slot not in ('08–11', '12–15') then
      raise exception 'Ogiltig tid';
    end if;
  else
    raise exception 'Okänd typ av besök';
  end if;
  if p_date <= v_today then
    raise exception 'Välj ett datum från och med i morgon';
  end if;
  if extract(isodow from p_date) > 5 then
    raise exception 'Vi bokar bara vardagar';
  end if;
  if p_kind = 'oppning' and v_month not between 3 and 5 then
    raise exception 'Vårstart bokas mars–maj';
  end if;
  if p_kind = 'stangning' and v_month not between 8 and 11 then
    raise exception 'Vinterstängning bokas augusti–november';
  end if;
  v_start := split_part(p_slot, '–', 1)::int;
  v_end   := split_part(p_slot, '–', 2)::int;
  if exists (select 1 from bookings where date = p_date and start_h < v_end and end_h > v_start) then
    raise exception 'Tiden hann tyvärr bli bokad, välj en annan';
  end if;
  insert into bookings (pool_id, customer_id, kind, date, slot, start_h, end_h, status)
  values (v_pool, v_customer, p_kind, p_date, p_slot, v_start, v_end, 'ny')
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Simulerade mätvärden (ersätts av riktiga sensorer senare)
-- ---------------------------------------------------------------------
-- Bygger 7 dagars historik, en mätning var 30:e minut
create or replace function public.generate_history() returns void
language plpgsql security definer set search_path = public as $$
declare
  t0 timestamptz := date_trunc('minute', now()) - interval '7 days';
begin
  delete from readings;
  insert into readings (pool_id, measured_at, ph, orp, temp)
  select
    p.id,
    s.ts,
    round((p.sim_ph_start + (p.sim_ph - p.sim_ph_start) * s.shape
           + 0.03 * sin(s.hrs * 0.9 + p.seed) + (random() - 0.5) * 0.02)::numeric, 2),
    round(p.sim_orp_start + (p.sim_orp - p.sim_orp_start) * s.shape
          + 6 * sin(s.hrs * 1.1 + p.seed) + (random() - 0.5) * 6),
    round((p.sim_temp + 0.7 * sin(s.hrs / 24.0 * 2 * pi()))::numeric, 1)
  from pools p
  cross join lateral (
    select ts,
           extract(epoch from ts - t0) / 3600.0 as hrs,
           greatest(0, (extract(epoch from ts - t0) / 604800.0 - 0.6) / 0.4) as shape
    from generate_series(t0, now(), interval '30 minutes') as ts
  ) s
  where not (p.sim_offline and s.ts > now() - interval '3 hours');
end;
$$;

-- Fyller på med nya mätvärden fram till nu (körs av appen och av pg_cron)
create or replace function public.catch_up_readings() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_last timestamptz;
begin
  select max(r.measured_at) into v_last
  from readings r join pools p on p.id = r.pool_id
  where not p.sim_offline;

  if v_last is null or v_last < now() - interval '7 days' then
    perform generate_history();
    return;
  end if;
  if v_last > now() - interval '10 minutes' then
    return;
  end if;

  insert into readings (pool_id, measured_at, ph, orp, temp)
  select p.id, ts,
         round((p.sim_ph + (random() - 0.5) * 0.05)::numeric, 2),
         round(p.sim_orp + (random() - 0.5) * 10),
         round((p.sim_temp + 0.7 * sin(extract(epoch from ts) / 86400.0 * 2 * pi()) + (random() - 0.5) * 0.3)::numeric, 1)
  from pools p
  cross join generate_series(v_last + interval '10 minutes', now(), interval '10 minutes') as ts
  where not p.sim_offline;

  delete from readings where measured_at < now() - interval '14 days';
end;
$$;

-- ---------------------------------------------------------------------
-- Demobokningar (datum räknas från innevarande vecka)
-- ---------------------------------------------------------------------
create or replace function public.seed_bookings() returns void
language plpgsql security definer set search_path = public as $$
declare
  w0 date := date_trunc('week', (now() at time zone 'Europe/Stockholm'))::date; -- måndag denna vecka
  r  record;
  k  int := 0;
  j  int;
  v_slot text;
begin
  delete from bookings;

  insert into bookings (pool_id, customer_id, kind, date, slot, start_h, end_h, status, note)
  select p.id, c.id, x.kind, w0 + x.dayoff, x.slot,
         split_part(x.slot, '–', 1)::int, split_part(x.slot, '–', 2)::int, x.status, x.note
  from (values
    ('Ekström',    'stangning', 0, '08–11', 'bekraftad', null),
    ('Gustafsson', 'stangning', 0, '12–15', 'bekraftad', null),
    ('Holm',       'service',   0, '15–16', 'bekraftad', 'Lågt redox'),
    ('Carlsson',   'stangning', 1, '08–11', 'bekraftad', null),
    ('Berg',       'service',   1, '15–16', 'bekraftad', 'pH-larm'),
    ('Dahlgren',   'stangning', 2, '08–11', 'bekraftad', null),
    ('Isaksson',   'stangning', 2, '12–15', 'ny',        null),
    ('Jansson',    'service',   2, '15–16', 'bekraftad', 'pH lågt'),
    ('Forsberg',   'service',   3, '08–09', 'bekraftad', 'Enheten offline'),
    ('Nyberg',     'stangning', 3, '12–15', 'bekraftad', null),
    ('Olsson',     'stangning', 4, '08–11', 'ny',        null),
    ('Persson',    'stangning', 4, '12–15', 'bekraftad', null),
    ('Lindqvist',  'service',   7, '08–09', 'bekraftad', 'Kalibrering'),
    ('Svensson',   'stangning', 7, '12–15', 'bekraftad', null),
    ('Wallin',     'stangning', 8, '08–11', 'ny',        null),
    ('Öberg',      'stangning', 9, '08–11', 'bekraftad', null)
  ) as x(name, kind, dayoff, slot, status, note)
  join customers c on c.name = x.name
  join pools p on p.customer_id = c.id;

  -- 17 genomförda vinterstängningar de två senaste veckorna
  for r in
    select c.id as cid, p.id as pid
    from customers c join pools p on p.customer_id = c.id
    where c.name not in ('Andersson', 'Ekström', 'Gustafsson', 'Carlsson', 'Dahlgren', 'Isaksson',
                         'Nyberg', 'Olsson', 'Persson', 'Svensson', 'Wallin', 'Öberg')
      and c.sort > 7
    order by c.sort
    limit 17
  loop
    j := k / 2;
    v_slot := case when k % 2 = 0 then '08–11' else '12–15' end;
    insert into bookings (pool_id, customer_id, kind, date, slot, start_h, end_h, status)
    values (r.pid, r.cid, 'stangning', w0 - 14 + (j / 5) * 7 + (j % 5), v_slot,
            split_part(v_slot, '–', 1)::int, split_part(v_slot, '–', 2)::int, 'bekraftad');
    k := k + 1;
  end loop;
end;
$$;

-- Återställer demon (knapp i appen, bara för personal)
create or replace function public.reset_demo() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_staff() then
    raise exception 'Bara personal kan återställa demon';
  end if;
  perform generate_history();
  perform seed_bookings();
end;
$$;

-- Vem får anropa vad
revoke execute on function public.generate_history(), public.seed_bookings() from public, anon, authenticated;
revoke execute on function public.catch_up_readings(), public.reset_demo(), public.book_visit(text, date, text),
  public.booked_ranges(date, date), public.pool_trend_24h(), public.pool_history(uuid, int) from public, anon;
grant execute on function public.catch_up_readings(), public.reset_demo(), public.book_visit(text, date, text),
  public.booked_ranges(date, date), public.pool_trend_24h(), public.pool_history(uuid, int) to authenticated;

-- ---------------------------------------------------------------------
-- Demokunder och pooler (42 st)
-- ---------------------------------------------------------------------
insert into public.customers (sort, name, contact_name, area) values
  (1, 'Andersson', 'Anna Andersson', 'Ryd'),
  (2, 'Berg', 'Per Berg', 'Hjulsbro'),
  (3, 'Jansson', 'Lena Jansson', 'Slaka'),
  (4, 'Dahlgren', 'Mats Dahlgren', 'Malmslätt'),
  (5, 'Holm', 'Karin Holm', 'Tannefors'),
  (6, 'Lindqvist', 'Johan Lindqvist', 'Skäggetorp'),
  (7, 'Forsberg', 'Eva Forsberg', 'Ljungsbro'),
  (8, 'Carlsson', 'Erik Carlsson', 'Vallastaden'),
  (9, 'Ekström', 'Maria Ekström', 'Sturefors'),
  (10, 'Gustafsson', 'Anders Gustafsson', 'Lambohov'),
  (11, 'Isaksson', 'Sara Isaksson', 'Johannelund'),
  (12, 'Nyberg', 'Lars Nyberg', 'Berga'),
  (13, 'Olsson', 'Ingrid Olsson', 'Hackefors'),
  (14, 'Persson', 'Nils Persson', 'Gottfridsberg'),
  (15, 'Svensson', 'Emma Svensson', 'Ekholmen'),
  (16, 'Wallin', 'Oskar Wallin', 'Tornby'),
  (17, 'Öberg', 'Helena Öberg', 'Vidingsjö'),
  (18, 'Axelsson', 'Jonas Axelsson', 'Garnisonen'),
  (19, 'Bengtsson', 'Camilla Bengtsson', 'Linghem'),
  (20, 'Björk', 'Fredrik Björk', 'Vikingstad'),
  (21, 'Blom', 'Linda Blom', 'Nykil'),
  (22, 'Danielsson', 'Peter Danielsson', 'Ullstämma'),
  (23, 'Engström', 'Sofia Engström', 'Kärna'),
  (24, 'Eriksson', 'Magnus Eriksson', 'Tallboda'),
  (25, 'Falk', 'Annika Falk', 'Ekholmen'),
  (26, 'Fredriksson', 'Henrik Fredriksson', 'Ryd'),
  (27, 'Hansson', 'Malin Hansson', 'Lambohov'),
  (28, 'Hedlund', 'Stefan Hedlund', 'Sturefors'),
  (29, 'Hellström', 'Jenny Hellström', 'Malmslätt'),
  (30, 'Jakobsson', 'Daniel Jakobsson', 'Hjulsbro'),
  (31, 'Johansson', 'Therese Johansson', 'Vidingsjö'),
  (32, 'Karlsson', 'Mikael Karlsson', 'Garnisonen'),
  (33, 'Larsson', 'Ulrika Larsson', 'Tornby'),
  (34, 'Lund', 'Andreas Lund', 'Linghem'),
  (35, 'Magnusson', 'Elin Magnusson', 'Vikingstad'),
  (36, 'Mattsson', 'Tobias Mattsson', 'Nykil'),
  (37, 'Nilsson', 'Kristina Nilsson', 'Ullstämma'),
  (38, 'Nordin', 'Patrik Nordin', 'Kärna'),
  (39, 'Petersson', 'Ida Petersson', 'Tallboda'),
  (40, 'Sandberg', 'Robert Sandberg', 'Johannelund'),
  (41, 'Sjöberg', 'Louise Sjöberg', 'Berga'),
  (42, 'Strand', 'Martin Strand', 'Hackefors');

-- Pooler med "berättelse" (larm, varningar, offline)
insert into public.pools (customer_id, volume_m3, seed, sim_ph_start, sim_ph, sim_orp_start, sim_orp, sim_temp, sim_offline)
select c.id, s.vol, c.sort, s.ph0, s.ph1, s.orp0, s.orp1, s.temp, s.off
from public.customers c
join (values
  (1,  45, 7.40, 7.40, 712, 712, 21.5, false),
  (2,  45, 7.42, 7.90, 718, 588, 19.8, false),  -- Berg: pH stiger, redox faller → larm
  (3,  50, 7.35, 6.80, 740, 781, 20.2, false),  -- Jansson: pH för lågt → larm
  (4,  42, 7.45, 7.70, 705, 664, 20.4, false),  -- Dahlgren: pH på väg upp → varning
  (5,  48, 7.40, 7.40, 700, 618, 21.3, false),  -- Holm: lågt redox → varning
  (6,  44, 7.45, 7.55, 705, 636, 19.1, false),  -- Lindqvist: redox på väg ner → varning
  (7,  46, 7.40, 7.40, 710, 710, 20.0, true),   -- Forsberg: enheten offline
  (8,  40, 7.32, 7.32, 735, 735, 22.1, false),
  (9,  52, 7.48, 7.48, 701, 701, 18.9, false),
  (10, 45, 7.30, 7.30, 740, 740, 21.0, false),
  (11, 47, 7.38, 7.38, 719, 719, 20.7, false),
  (12, 43, 7.42, 7.42, 725, 725, 20.1, false),
  (13, 49, 7.36, 7.36, 708, 708, 19.6, false),
  (14, 45, 7.44, 7.44, 732, 732, 21.8, false),
  (15, 41, 7.34, 7.34, 716, 716, 20.9, false),
  (16, 55, 7.46, 7.46, 698, 698, 19.4, false),
  (17, 44, 7.39, 7.39, 744, 744, 21.2, false)
) as s(sort, vol, ph0, ph1, orp0, orp1, temp, off) on s.sort = c.sort;

-- Övriga pooler mår bra
insert into public.pools (customer_id, volume_m3, seed, sim_ph_start, sim_ph, sim_orp_start, sim_orp, sim_temp, sim_offline)
select c.id,
       40 + (c.sort * 7) % 16,
       c.sort,
       7.30 + ((c.sort * 37) % 23) / 100.0,
       7.30 + ((c.sort * 37) % 23) / 100.0,
       690 + (c.sort * 53) % 60,
       690 + (c.sort * 53) % 60,
       18.5 + ((c.sort * 29) % 40) / 10.0,
       false
from public.customers c
where c.sort >= 18;

-- ---------------------------------------------------------------------
-- Demoinloggningar
-- ---------------------------------------------------------------------
do $$
declare
  u    record;
  v_id uuid;
begin
  for u in
    select * from (values
      ('tekniker@poolkollen.demo', 'Tekniker', 'staff', null::int),
      ('anna@poolkollen.demo', 'Anna Andersson', 'customer', 1),
      ('berg@poolkollen.demo', 'Per Berg', 'customer', 2)
    ) as t(email, full_name, role, sort)
  loop
    select id into v_id from auth.users where email = u.email;
    if v_id is null then
      v_id := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', u.email,
        extensions.crypt('demo1234', extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
        '', '', '', ''
      );
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), v_id, v_id::text,
              jsonb_build_object('sub', v_id::text, 'email', u.email, 'email_verified', true),
              'email', now(), now(), now());
    end if;
    insert into public.profiles (id, full_name, role, customer_id)
    values (v_id, u.full_name, u.role, (select id from public.customers where sort = u.sort));
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Fyll på demodata
-- ---------------------------------------------------------------------
select public.reset_demo();

-- ---------------------------------------------------------------------
-- Nya mätvärden var 10:e minut via pg_cron (valfritt – appen fyller
-- även på själv när någon öppnar den)
-- ---------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron kunde inte aktiveras (%). Demon fungerar ändå.', sqlerrm;
  end;
  begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'poolkollen-matvarden';
    perform cron.schedule('poolkollen-matvarden', '*/10 * * * *', 'select public.catch_up_readings()');
  exception when others then
    raise notice 'Schemaläggning hoppades över (%). Demon fungerar ändå.', sqlerrm;
  end;
end;
$$;

-- Klart! Kontroll: ska visa 42 pooler och tre demokonton.
select
  (select count(*) from public.pools)    as pooler,
  (select count(*) from public.readings) as matvarden,
  (select count(*) from public.bookings) as bokningar,
  (select count(*) from public.profiles) as demokonton;
