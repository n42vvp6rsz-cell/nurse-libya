-- REVIEW DRAFT ONLY. Not applied by this audit or by the static website.
-- Target: juxiaorwaiazfjlmkcvm, catalog inspected 2026-10-07.
-- No data backfills, role grants to users, seed rows, auth changes, or table drops.
-- Apply only after review and controlled verification against this exact schema.
-- Existing rows remain intact; unreviewed courses cease to be public after this patch.

BEGIN;

-- Already granted in the October 5 fix; retained for invoker wrappers/guards.
GRANT USAGE ON SCHEMA private TO authenticated;

-- Reuse the existing recursion-safe current-user helper. Never read editable JWT
-- metadata for authorization or add a claim/bootstrap-admin endpoint.
DO $policies$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles admin read') THEN
    CREATE POLICY "profiles admin read" ON public.profiles FOR SELECT TO authenticated
      USING ((SELECT private.is_current_user_admin()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='course_enrollments' AND policyname='course enrollment admin read') THEN
    CREATE POLICY "course enrollment admin read" ON public.course_enrollments FOR SELECT TO authenticated
      USING ((SELECT private.is_current_user_admin()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bookings' AND policyname='bookings admin read') THEN
    CREATE POLICY "bookings admin read" ON public.bookings FOR SELECT TO authenticated
      USING ((SELECT private.is_current_user_admin()));
  END IF;
END
$policies$;

-- Existing restrictive application INSERT guard remains unchanged. Pending-only
-- decisions are locked, atomic, and verify promotion; government stays unpromotable
-- until a separate government workflow/role contract is deliberately defined.
CREATE OR REPLACE FUNCTION public.approve_provider_application(
  p_application_id uuid, p_approve boolean
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_user_id uuid;
  v_requested_role text;
  v_application_status text;
  v_saved_role text;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.is_current_user_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE='42501';
  END IF;
  IF p_application_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'application and decision are required';
  END IF;
  SELECT a.user_id, a.requested_role, a.status
    INTO v_user_id, v_requested_role, v_application_status
    FROM public.provider_applications a WHERE a.id=p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application not found'; END IF;
  IF v_application_status <> 'pending' THEN
    RAISE EXCEPTION 'application was already reviewed; refresh the queue';
  END IF;
  IF p_approve THEN
    IF v_requested_role NOT IN ('doctor','nurse','hospital','clinic','laboratory','pharmacy','ambulance','instructor') THEN
      RAISE EXCEPTION 'requested role cannot be approved by this workflow';
    END IF;
    -- A provider application must never demote an administrator.
    SELECT p.role INTO v_saved_role FROM public.profiles p WHERE p.id=v_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'applicant profile not found'; END IF;
    IF v_saved_role='admin' THEN RAISE EXCEPTION 'administrator role cannot be replaced by a provider application'; END IF;
    UPDATE public.profiles p SET role=v_requested_role WHERE p.id=v_user_id
      RETURNING p.role INTO v_saved_role;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 OR v_saved_role IS DISTINCT FROM v_requested_role THEN
      RAISE EXCEPTION 'profile promotion was not saved';
    END IF;
  END IF;
  UPDATE public.provider_applications a
    SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
        reviewed_by=auth.uid(), reviewed_at=clock_timestamp()
    WHERE a.id=p_application_id AND a.status='pending';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'application changed; refresh the queue'; END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.approve_provider_application(uuid,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_provider_application(uuid,boolean) TO authenticated;

-- Provider owners retain their existing content permissions but cannot set the
-- independent verification flag. Content edits return records to review; a pure
-- attempted self-verification does not promote them. Existing rows are not backfilled.
-- Narrow admin policies permit review, not arbitrary creation/deletion of a record.
CREATE OR REPLACE FUNCTION private.guard_provider_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.id:=OLD.id; NEW.created_at:=OLD.created_at;
    IF TG_TABLE_NAME IN ('doctors','nurses') THEN NEW.profile_id:=OLD.profile_id;
    ELSE NEW.owner_profile_id:=OLD.owner_profile_id;
    END IF;
  END IF;
  IF NOT private.is_current_user_admin() THEN
    IF TG_OP='INSERT' THEN NEW.verified:=false;
    ELSIF (to_jsonb(NEW)-ARRAY['verified','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['verified','updated_at']) THEN NEW.verified:=false;
    ELSE NEW.verified:=OLD.verified;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION private.guard_provider_verification() FROM PUBLIC, anon, authenticated;

DO $providers$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['doctors','nurses','hospitals','laboratories','pharmacies'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_table AND policyname=v_table||' admin read') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT private.is_current_user_admin()))',v_table||' admin read',v_table);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_table AND policyname=v_table||' admin update') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT private.is_current_user_admin())) WITH CHECK ((SELECT private.is_current_user_admin()))',v_table||' admin update',v_table);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=format('public.%I',v_table)::regclass AND tgname='guard_provider_verification_trigger') THEN
      EXECUTE format('CREATE TRIGGER guard_provider_verification_trigger BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.guard_provider_verification()',v_table);
    END IF;
  END LOOP;
END
$providers$;

-- Course authoring can draft/resubmit/deactivate; approval and activation belong to
-- staff. Content edits withdraw the old approval. This does not fabricate lesson,
-- payment, or auto-enrollment actions, and does not backfill existing reviews.
CREATE OR REPLACE FUNCTION private.guard_course_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE v_admin boolean:=private.is_current_user_admin(); v_content_changed boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.id:=OLD.id;
    NEW.publisher_id:=OLD.publisher_id;
    NEW.created_at:=OLD.created_at;
    v_content_changed :=
      (to_jsonb(NEW)-ARRAY['id','publisher_id','created_at','updated_at','review_status','review_note','status','published_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['id','publisher_id','created_at','updated_at','review_status','review_note','status','published_at']);
  END IF;
  IF NOT v_admin THEN
    IF TG_OP='INSERT' THEN
      NEW.review_status:=CASE WHEN NEW.review_status='draft' THEN 'draft' ELSE 'pending' END;
      NEW.status:='closed'; NEW.review_note:=NULL; NEW.published_at:=NULL;
    ELSIF v_content_changed THEN
      NEW.review_status:='pending'; NEW.status:='closed';
      NEW.review_note:=NULL; NEW.published_at:=NULL;
    ELSIF OLD.review_status IN ('draft','rejected') AND NEW.review_status='pending' THEN
      NEW.review_status:='pending'; NEW.status:='closed';
      NEW.review_note:=NULL; NEW.published_at:=NULL;
    ELSE
      NEW.review_status:=OLD.review_status; NEW.review_note:=OLD.review_note;
      NEW.published_at:=OLD.published_at;
      -- Allow withdrawal but never owner activation of a closed course.
      NEW.status:=CASE WHEN NEW.status='closed' THEN 'closed' ELSE OLD.status END;
    END IF;
  END IF;
  IF NEW.status='active' AND NEW.review_status<>'approved' THEN
    RAISE EXCEPTION 'only an approved course may be active';
  END IF;
  IF NEW.status='active' THEN NEW.published_at:=coalesce(NEW.published_at,clock_timestamp()); END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION private.guard_course_publication() FROM PUBLIC, anon, authenticated;
DO $course_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.courses'::regclass AND tgname='guard_course_publication_trigger') THEN
    CREATE TRIGGER guard_course_publication_trigger BEFORE INSERT OR UPDATE ON public.courses
      FOR EACH ROW EXECUTE FUNCTION private.guard_course_publication();
  END IF;
END
$course_trigger$;
ALTER POLICY "courses public read" ON public.courses
  USING (status='active' AND review_status='approved');

-- Conservative enrollment: a request remains pending, including free courses.
-- No caller can self-mark paid/accepted/completed. Paid requests are not checkout.
ALTER POLICY "course enrollment own insert" ON public.course_enrollments
WITH CHECK (
  user_id=(SELECT auth.uid()) AND status='pending'
  AND EXISTS (
    SELECT 1 FROM public.courses c
    WHERE c.id=course_enrollments.course_id AND c.status='active' AND c.review_status='approved'
    AND (
      ((c.is_free OR coalesce(c.price,0)=0) AND course_enrollments.payment_status='free')
      OR (NOT c.is_free AND coalesce(c.price,0)>0 AND course_enrollments.payment_status IN ('unpaid','pending'))
    )
  )
);

-- Admin booking review: no broad client booking UPDATE policy is added. The private
-- privileged implementation exists solely to atomically review these two linked rows.
-- A public invoker wrapper exposes the deliberately small checked API to PostgREST.
-- Status vocabulary stays compatible with the static UI: pending -> confirmed/cancelled,
-- confirmed -> completed/cancelled. Linked requests use accepted/completed/cancelled.
-- Existing participant UPDATE remains available for unlinked legacy requests.
-- Linked request authority can be changed only by a stored administrator, so a
-- client cannot bypass the atomic booking transition by writing the request table.
-- The private trigger needs owner privileges only to detect a link hidden by
-- bookings RLS from an assigned provider. It is not a callable client endpoint.
CREATE OR REPLACE FUNCTION private.guard_linked_request_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_outer_role text:=coalesce(nullif(current_setting('role',true),'none'),session_user);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.service_request_id=OLD.id) THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    -- Deliberate no-JWT maintenance by existing trusted database/backend roles.
    -- current_setting('role') retains an outer PostgREST client role even inside
    -- SECURITY DEFINER; current_user alone would always be the function owner.
    IF v_outer_role IN ('postgres','supabase_admin','service_role') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'authentication required for a linked request' USING ERRCODE='42501';
  END IF;
  IF NOT private.is_current_user_admin() AND
    ROW(NEW.id,NEW.requester_id,NEW.service_id,NEW.assigned_provider_id,NEW.status,NEW.created_at)
      IS DISTINCT FROM
    ROW(OLD.id,OLD.requester_id,OLD.service_id,OLD.assigned_provider_id,OLD.status,OLD.created_at) THEN
    RAISE EXCEPTION 'linked request authority requires booking review' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION private.guard_linked_request_authority() FROM PUBLIC, anon, authenticated;
DO $request_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.service_requests'::regclass AND tgname='guard_linked_request_authority_trigger') THEN
    CREATE TRIGGER guard_linked_request_authority_trigger BEFORE UPDATE ON public.service_requests
      FOR EACH ROW EXECUTE FUNCTION private.guard_linked_request_authority();
  END IF;
END
$request_trigger$;

CREATE OR REPLACE FUNCTION private.review_booking(
  p_booking_id uuid, p_expected_status text, p_new_status text
) RETURNS TABLE(id uuid,status text,service_request_id uuid,service_request_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_booking_status text; v_booking_owner uuid; v_booking_provider uuid; v_request_id uuid;
  v_request_status text; v_request_owner uuid; v_request_provider uuid; v_current text;
  v_request_target text; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.is_current_user_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE='42501';
  END IF;
  IF p_booking_id IS NULL OR p_expected_status IS NULL OR p_new_status IS NULL
     OR p_new_status NOT IN ('confirmed','completed','cancelled') THEN
    RAISE EXCEPTION 'invalid booking review';
  END IF;
  SELECT b.status,b.user_id,b.provider_profile_id,b.service_request_id
    INTO v_booking_status,v_booking_owner,v_booking_provider,v_request_id
    FROM public.bookings b WHERE b.id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  IF v_booking_status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'booking changed; refresh before reviewing';
  END IF;
  v_current:=CASE WHEN v_booking_status IN ('pending','قيد المراجعة') THEN 'pending'
                  WHEN v_booking_status IN ('confirmed','تم التأكيد') THEN 'confirmed'
                  ELSE v_booking_status END;
  IF NOT ((v_current='pending' AND p_new_status IN ('confirmed','cancelled'))
       OR (v_current='confirmed' AND p_new_status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'booking transition is not allowed';
  END IF;
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'booking has no linked request; legacy reconciliation is required';
  END IF;
  SELECT r.status,r.requester_id,r.assigned_provider_id INTO v_request_status,v_request_owner,v_request_provider
    FROM public.service_requests r WHERE r.id=v_request_id FOR UPDATE;
  IF NOT FOUND OR v_request_owner IS DISTINCT FROM v_booking_owner THEN
    RAISE EXCEPTION 'linked request does not match the booking';
  END IF;
  IF v_booking_provider IS NOT NULL AND v_request_provider IS DISTINCT FROM v_booking_provider THEN
    RAISE EXCEPTION 'linked provider changed; reconcile before reviewing';
  END IF;
  v_request_target:=CASE WHEN p_new_status='confirmed' THEN 'accepted' ELSE p_new_status END;
  IF (p_new_status='confirmed' AND v_request_status NOT IN ('pending','accepted'))
     OR (p_new_status='completed' AND v_request_status NOT IN ('accepted','on_the_way','in_progress'))
     OR (p_new_status='cancelled' AND v_request_status NOT IN ('pending','accepted','on_the_way','in_progress')) THEN
    RAISE EXCEPTION 'linked request state changed; refresh before reviewing';
  END IF;
  UPDATE public.service_requests r SET status=v_request_target,updated_at=clock_timestamp()
    WHERE r.id=v_request_id AND r.status=v_request_status;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'linked request was not updated'; END IF;
  UPDATE public.bookings b SET status=p_new_status
    WHERE b.id=p_booking_id AND b.status=p_expected_status;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'booking was not updated'; END IF;
  RETURN QUERY SELECT p_booking_id,p_new_status,v_request_id,v_request_target;
END
$fn$;
REVOKE ALL ON FUNCTION private.review_booking(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.review_booking(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_booking(
  p_booking_id uuid, p_expected_status text, p_new_status text
) RETURNS TABLE(id uuid,status text,service_request_id uuid,service_request_status text)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT * FROM private.review_booking(p_booking_id,p_expected_status,p_new_status);
$fn$;
REVOKE ALL ON FUNCTION public.review_booking(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_booking(uuid,text,text) TO authenticated;

-- Read-only capability marker for guarded frontend writes. It is installed only
-- with this entire transaction; it reads no rows and conveys no admin authority.
CREATE OR REPLACE FUNCTION public.nurse_app_contract_version()
RETURNS integer LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT 1;
$fn$;
REVOKE ALL ON FUNCTION public.nurse_app_contract_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nurse_app_contract_version() TO authenticated;

COMMIT;

-- Required controlled validation before any deployment:
-- * Non-admin signup/updates cannot acquire a role or set provider verified=true.
-- * Admin pending approval promotes exactly one non-admin profile; terminal/replayed
--   decisions and government promotion reject without partially saving the application.
-- * Ordinary course INSERT/edit cannot publish/approve; staff approve publishes; draft
--   and rejected courses are absent publicly. Free pending and paid pending inserts
--   succeed only for approved active courses; claimed paid/active enrollment rejects.
-- * Admin review_booking changes both linked statuses atomically; stale status, wrong
--   caller, terminal transition, missing/mismatched link reject. Own bookings stay private.
-- This SQL has not been applied or executed against patient/user rows. Remaining direct
-- Unlinked service_requests participant UPDATE permissions retain their legacy behavior;
-- they require a separate workflow contract before an unrestricted requester/provider editor.
