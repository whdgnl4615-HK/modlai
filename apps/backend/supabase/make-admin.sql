-- ============================================================
-- Promote a user to admin
-- Replace the email with your own, then run in Supabase SQL Editor
-- ============================================================

update public.users
   set role = 'admin'
 where email = 'your-email@example.com';

-- Verify:
select id, email, role, credits
  from public.users
 where role = 'admin';
