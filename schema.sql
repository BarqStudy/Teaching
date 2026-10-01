-- =====================================================
-- منصة الخصوصيين — Supabase (SQL Editor ← New query ← Run)
-- =====================================================
create extension if not exists pgcrypto;

create table tutors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  whatsapp text default '',
  telegram text default '',
  bio text default '',
  rating int default 0 check (rating between 0 and 100),
  subjects jsonb not null default '[]',   -- [{name,onsite,remote,trial}]
  created_at timestamptz default now()
);

create table requests (                    -- طلبات التسجيل كخصوصي
  id uuid primary key default gen_random_uuid(),
  name text not null,
  whatsapp text default '',
  telegram text default '',
  bio text default '',
  subjects jsonb not null default '[]',
  tg_id text,
  created_at timestamptz default now()
);

create table terms (                       -- الشروط والتعهد
  id uuid primary key default gen_random_uuid(),
  text text not null,
  sort int default 0
);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid references tutors(id) on delete cascade,
  tg_id text not null,
  who text default '',
  score int not null check (score between 1 and 100),
  comment text default '',
  created_at timestamptz default now(),
  unique (tutor_id, tg_id)                 -- تقييم واحد لكل طالب
);

-- ===== الصلاحيات (RLS) =====
alter table tutors   enable row level security;
alter table requests enable row level security;
alter table terms    enable row level security;
alter table ratings  enable row level security;

-- الجميع: قراءة الخصوصيين والشروط والتقييمات
create policy "read tutors"  on tutors  for select using (true);
create policy "read terms"   on terms   for select using (true);
create policy "read ratings" on ratings for select using (true);
-- الجميع: إرسال طلب تسجيل وإضافة تقييم
create policy "send request" on requests for insert with check (true);
create policy "add rating"   on ratings  for insert with check (true);
-- الأدمن فقط (مستخدم مسجّل دخول): كل شي
create policy "admin tutors"   on tutors   for all to authenticated using (true) with check (true);
create policy "admin requests" on requests for all to authenticated using (true) with check (true);
create policy "admin terms"    on terms    for all to authenticated using (true) with check (true);
create policy "admin ratings"  on ratings  for all to authenticated using (true) with check (true);

-- شروط افتراضية
insert into terms (text, sort) values
 ('أتعهد بالالتزام بالمواعيد المتفق عليها مع الطالب.',1),
 ('أتعهد بتقديم شرح صحيح وأمين للمادة دون غش أو مبالغة في الوعود.',2),
 ('أتعهد بالالتزام بالأسعار المعلنة في المنصة وعدم زيادتها دون اتفاق مسبق.',3),
 ('أتعهد باحترام الطلاب والحفاظ على خصوصيتهم.',4),
 ('أقرّ بأن للإدارة الحق في إيقاف حسابي عند مخالفة الشروط.',5);
