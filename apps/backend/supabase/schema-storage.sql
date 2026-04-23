-- ============================================================
-- MODLai Storage Buckets
-- Run AFTER schema.sql in Supabase SQL Editor
-- ============================================================

-- ─────────────────────────────────────────────
-- BUCKETS
-- ─────────────────────────────────────────────
-- generated-images: final AI outputs (public, CDN-cached)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generated-images', 'generated-images', true, 10485760,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- user-uploads: reference photos, accessories, model photos (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-uploads', 'user-uploads', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

-- ─────────────────────────────────────────────
-- STORAGE POLICIES
-- Path convention: <bucket>/<user_id>/<uuid>.<ext>
-- ─────────────────────────────────────────────

-- generated-images bucket: public read, authenticated write (to own folder)
drop policy if exists "generated_images_public_read" on storage.objects;
create policy "generated_images_public_read"
  on storage.objects for select
  using (bucket_id = 'generated-images');

drop policy if exists "generated_images_owner_write" on storage.objects;
create policy "generated_images_owner_write"
  on storage.objects for insert
  with check (
    bucket_id = 'generated-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "generated_images_owner_delete" on storage.objects;
create policy "generated_images_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'generated-images'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin(auth.uid())
    )
  );

-- user-uploads bucket: owner-only access
drop policy if exists "uploads_owner_select" on storage.objects;
create policy "uploads_owner_select"
  on storage.objects for select
  using (
    bucket_id = 'user-uploads'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin(auth.uid())
    )
  );

drop policy if exists "uploads_owner_insert" on storage.objects;
create policy "uploads_owner_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'user-uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "uploads_owner_delete" on storage.objects;
create policy "uploads_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'user-uploads'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin(auth.uid())
    )
  );

-- Note: The backend (Vercel functions) uses the service_role key which
-- bypasses these policies entirely. That's how we upload AI-generated
-- images to the user's folder on their behalf.
