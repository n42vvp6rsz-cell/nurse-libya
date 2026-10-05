-- Applied to juxiaorwaiazfjlmkcvm on 2026-10-05. Audit record, not auto-run by the site.
BEGIN;
ALTER POLICY "Users can create own bookings" ON public.bookings
WITH CHECK ((SELECT auth.uid()) = user_id AND status IN ('pending', 'قيد المراجعة'));
CREATE OR REPLACE FUNCTION private.is_current_user_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
SELECT auth.uid() IS NOT NULL AND EXISTS (
 SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
);
$$;
REVOKE ALL ON FUNCTION private.is_current_user_admin() FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_current_user_admin() TO authenticated;
ALTER POLICY "profiles admin update" ON public.profiles
USING ((SELECT private.is_current_user_admin()))
WITH CHECK ((SELECT private.is_current_user_admin()));
COMMIT;
