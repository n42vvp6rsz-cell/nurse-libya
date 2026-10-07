// Real PostgreSQL execution in an isolated, in-memory WASM database. No network,
// Supabase key, production rows, or real auth identities are used by this test.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { ({ PGlite } = require('/tmp/nurse-libya-sql-runtime/node_modules/@electric-sql/pglite')); }
const catalogFixture = String.raw`
-- Catalog-only snapshot from juxiaorwaiazfjlmkcvm, 2026-10-07.
-- Auth is a synthetic UID adapter, not GoTrue/PostgREST. Wallet AFTER INSERT trigger
-- omitted: its side effects are orthogonal to this migration and not asserted here.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE TABLE public."bookings" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "service" text NOT NULL,
  "patient_name" text NOT NULL,
  "phone" text NOT NULL,
  "booking_date" date NOT NULL,
  "notes" text,
  "status" text DEFAULT 'قيد المراجعة'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "service_request_id" uuid,
  "provider_profile_id" uuid
);
CREATE TABLE public."course_enrollments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "payment_status" text DEFAULT 'unpaid'::text NOT NULL,
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
CREATE TABLE public."courses" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "publisher_id" uuid NOT NULL,
  "title" text NOT NULL,
  "provider_name" text NOT NULL,
  "city" text,
  "start_date" date,
  "end_date" date,
  "price" numeric,
  "seats" integer,
  "description" text NOT NULL,
  "contact_phone" text,
  "registration_url" text,
  "status" text DEFAULT 'active'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "category" text,
  "level" text,
  "duration_minutes" integer,
  "cover_url" text,
  "learning_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "is_free" boolean DEFAULT false NOT NULL,
  "review_status" text DEFAULT 'draft'::text NOT NULL,
  "review_note" text,
  "published_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."doctors" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid,
  "name" text NOT NULL,
  "specialty" text NOT NULL,
  "hospital_name" text,
  "city" text,
  "bio" text,
  "phone" text,
  "photo_url" text,
  "verified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "email" text,
  "consultation_price" numeric(10,2),
  "years_experience" integer DEFAULT 0,
  "latitude" double precision,
  "longitude" double precision
);
CREATE TABLE public."hospitals" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "city" text,
  "address" text,
  "phone" text,
  "whatsapp" text,
  "description" text,
  "image_url" text,
  "verified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "owner_profile_id" uuid,
  "latitude" double precision,
  "longitude" double precision,
  "email" text,
  "website" text,
  "emergency_available" boolean DEFAULT false NOT NULL,
  "opening_hours" jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE TABLE public."laboratories" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "owner_profile_id" uuid,
  "name" text NOT NULL,
  "city" text,
  "address" text,
  "phone" text,
  "whatsapp" text,
  "description" text,
  "image_url" text,
  "latitude" double precision,
  "longitude" double precision,
  "verified" boolean DEFAULT false NOT NULL,
  "open_now" boolean DEFAULT false NOT NULL,
  "opening_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."nurses" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid,
  "name" text NOT NULL,
  "specialty" text,
  "years_experience" integer DEFAULT 0 NOT NULL,
  "city" text,
  "phone" text,
  "bio" text,
  "photo_url" text,
  "verified" boolean DEFAULT false NOT NULL,
  "available_for_home_visits" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."pharmacies" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "owner_profile_id" uuid,
  "name" text NOT NULL,
  "city" text,
  "address" text,
  "phone" text,
  "whatsapp" text,
  "description" text,
  "image_url" text,
  "latitude" double precision,
  "longitude" double precision,
  "verified" boolean DEFAULT false NOT NULL,
  "open_now" boolean DEFAULT false NOT NULL,
  "opening_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."profiles" (
  "id" uuid NOT NULL,
  "full_name" text,
  "phone" text,
  "role" text DEFAULT 'patient'::text NOT NULL,
  "avatar_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."provider_applications" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "requested_role" text NOT NULL,
  "license_number" text,
  "organization_name" text,
  "city" text,
  "phone" text,
  "notes" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."service_requests" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "requester_id" uuid NOT NULL,
  "service_id" uuid,
  "assigned_provider_id" uuid,
  "requested_for" timestamp with time zone,
  "address" text,
  "latitude" double precision,
  "longitude" double precision,
  "notes" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."services" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "image_url" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public."bookings" ADD CONSTRAINT "bookings_pkey" PRIMARY KEY (id);
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_pkey" PRIMARY KEY (id);
ALTER TABLE public."courses" ADD CONSTRAINT "courses_pkey" PRIMARY KEY (id);
ALTER TABLE public."doctors" ADD CONSTRAINT "doctors_pkey" PRIMARY KEY (id);
ALTER TABLE public."hospitals" ADD CONSTRAINT "hospitals_pkey" PRIMARY KEY (id);
ALTER TABLE public."laboratories" ADD CONSTRAINT "laboratories_pkey" PRIMARY KEY (id);
ALTER TABLE public."nurses" ADD CONSTRAINT "nurses_pkey" PRIMARY KEY (id);
ALTER TABLE public."pharmacies" ADD CONSTRAINT "pharmacies_pkey" PRIMARY KEY (id);
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);
ALTER TABLE public."provider_applications" ADD CONSTRAINT "provider_applications_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_pkey" PRIMARY KEY (id);
ALTER TABLE public."services" ADD CONSTRAINT "services_pkey" PRIMARY KEY (id);
ALTER TABLE public."bookings" ADD CONSTRAINT "bookings_provider_profile_id_fkey" FOREIGN KEY (provider_profile_id) REFERENCES profiles(id);
ALTER TABLE public."bookings" ADD CONSTRAINT "bookings_service_request_id_fkey" FOREIGN KEY (service_request_id) REFERENCES service_requests(id);
ALTER TABLE public."bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_course_id_fkey" FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE;
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_course_id_user_id_key" UNIQUE (course_id, user_id);
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_payment_status_check" CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'pending'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'free'::text])));
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text])));
ALTER TABLE public."course_enrollments" ADD CONSTRAINT "course_enrollments_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."courses" ADD CONSTRAINT "courses_duration_minutes_check" CHECK (((duration_minutes IS NULL) OR (duration_minutes >= 0)));
ALTER TABLE public."courses" ADD CONSTRAINT "courses_publisher_id_fkey" FOREIGN KEY (publisher_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."courses" ADD CONSTRAINT "courses_review_status_check" CHECK ((review_status = ANY (ARRAY['draft'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE public."courses" ADD CONSTRAINT "courses_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text])));
ALTER TABLE public."doctors" ADD CONSTRAINT "doctors_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."hospitals" ADD CONSTRAINT "hospitals_owner_profile_id_fkey" FOREIGN KEY (owner_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."laboratories" ADD CONSTRAINT "laboratories_owner_profile_id_fkey" FOREIGN KEY (owner_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."nurses" ADD CONSTRAINT "nurses_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."nurses" ADD CONSTRAINT "nurses_profile_id_key" UNIQUE (profile_id);
ALTER TABLE public."pharmacies" ADD CONSTRAINT "pharmacies_owner_profile_id_fkey" FOREIGN KEY (owner_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_role_check" CHECK ((role = ANY (ARRAY['patient'::text, 'doctor'::text, 'nurse'::text, 'hospital'::text, 'clinic'::text, 'laboratory'::text, 'pharmacy'::text, 'ambulance'::text, 'instructor'::text, 'admin'::text])));
ALTER TABLE public."provider_applications" ADD CONSTRAINT "provider_applications_requested_role_check" CHECK ((requested_role = ANY (ARRAY['doctor'::text, 'nurse'::text, 'hospital'::text, 'clinic'::text, 'laboratory'::text, 'pharmacy'::text, 'ambulance'::text, 'instructor'::text, 'government'::text])));
ALTER TABLE public."provider_applications" ADD CONSTRAINT "provider_applications_reviewed_by_fkey" FOREIGN KEY (reviewed_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."provider_applications" ADD CONSTRAINT "provider_applications_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE public."provider_applications" ADD CONSTRAINT "provider_applications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_assigned_provider_id_fkey" FOREIGN KEY (assigned_provider_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_requester_id_fkey" FOREIGN KEY (requester_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_service_id_fkey" FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'on_the_way'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE public."services" ADD CONSTRAINT "services_slug_key" UNIQUE (slug);
CREATE OR REPLACE FUNCTION private.is_current_user_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'); $function$;

CREATE OR REPLACE FUNCTION public.approve_provider_application(p_application_id uuid, p_approve boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_role text;
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  ) then
    raise exception 'admin access required';
  end if;

  select user_id, requested_role
  into v_user_id, v_role
  from public.provider_applications
  where id = p_application_id
  for update;

  if v_user_id is null then
    raise exception 'application not found';
  end if;

  update public.provider_applications
  set
    status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = (select auth.uid()),
    reviewed_at = now()
  where id = p_application_id;

  if p_approve then
    update public.profiles
    set role = v_role
    where id = v_user_id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.link_booking_service_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare selected_service uuid; selected_slug text; provider_valid boolean := false;
begin
 if auth.uid() is null or new.user_id <> auth.uid() then raise exception 'Authentication required'; end if;
 select id,slug into selected_service,selected_slug from public.services where name=new.service and is_active=true limit 1;
 if selected_service is null then raise exception 'الخدمة غير متاحة'; end if;
 if new.booking_date < (now() at time zone 'Africa/Tripoli')::date then raise exception 'اختر تاريخاً حالياً أو مستقبلياً'; end if;
 if new.provider_profile_id is not null then
  if selected_slug='doctors' then
   select exists(select 1 from public.doctors where profile_id=new.provider_profile_id and verified=true) into provider_valid;
  elsif selected_slug='home-nursing' then
   select exists(select 1 from public.nurses where profile_id=new.provider_profile_id and verified=true and available_for_home_visits=true) into provider_valid;
  elsif selected_slug='hospitals' then
   select exists(select 1 from public.hospitals where owner_profile_id=new.provider_profile_id and verified=true) into provider_valid;
  end if;
  if not provider_valid then raise exception 'مقدم الخدمة غير متاح أو غير موثق لهذه الخدمة'; end if;
 end if;
 insert into public.service_requests(requester_id,service_id,assigned_provider_id,requested_for,notes,status)
 values(new.user_id,selected_service,new.provider_profile_id,new.booking_date::timestamp at time zone 'Africa/Tripoli',
 'الاسم: '||new.patient_name||chr(10)||'الهاتف: '||new.phone||chr(10)||coalesce(new.notes,''),'pending')
 returning id into new.service_request_id;
 return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.protect_profile_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.role := 'patient';
    return new;
  end if;

  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role = 'admin'
    ) then
      return new;
    end if;

    new.role := old.role;
  end if;

  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.is_current_user_admin() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.is_current_user_admin() TO authenticated;
REVOKE ALL ON FUNCTION public.approve_provider_application(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_provider_application(uuid,boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.protect_profile_role() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER link_booking_service_request BEFORE INSERT ON public.bookings FOR EACH ROW EXECUTE FUNCTION link_booking_service_request();
CREATE TRIGGER protect_profile_role_trigger BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION protect_profile_role();
CREATE POLICY "Users can create own bookings" ON public."bookings" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND (status = ANY (ARRAY['pending'::text, 'قيد المراجعة'::text]))));
CREATE POLICY "Users can view own bookings" ON public."bookings" AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "course enrollment admin update" ON public."course_enrollments" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text)))));
CREATE POLICY "course enrollment own insert" ON public."course_enrollments" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM courses c
  WHERE ((c.id = course_enrollments.course_id) AND (c.status = 'active'::text) AND ((((c.is_free = true) OR (COALESCE(c.price, (0)::numeric) = (0)::numeric)) AND (c.status = 'active'::text) AND (course_enrollments.payment_status = 'free'::text)) OR ((c.is_free = false) AND (COALESCE(c.price, (0)::numeric) > (0)::numeric) AND (c.status = 'pending'::text) AND (course_enrollments.payment_status = ANY (ARRAY['unpaid'::text, 'pending'::text])))))))));
CREATE POLICY "course enrollment own read" ON public."course_enrollments" AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "course enrollment owner read" ON public."course_enrollments" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM courses c
  WHERE ((c.id = course_enrollments.course_id) AND (c.publisher_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "courses admin read" ON public."courses" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text)))));
CREATE POLICY "courses admin update" ON public."courses" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text)))));
CREATE POLICY "courses owner delete" ON public."courses" AS PERMISSIVE FOR DELETE TO authenticated USING ((publisher_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "courses owner read" ON public."courses" AS PERMISSIVE FOR SELECT TO authenticated USING ((publisher_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "courses owner update" ON public."courses" AS PERMISSIVE FOR UPDATE TO authenticated USING ((publisher_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((publisher_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "courses provider insert" ON public."courses" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((publisher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['doctor'::text, 'nurse'::text, 'hospital'::text, 'clinic'::text, 'laboratory'::text, 'pharmacy'::text, 'instructor'::text, 'admin'::text])))))));
CREATE POLICY "courses public read" ON public."courses" AS PERMISSIVE FOR SELECT TO anon,authenticated USING ((status = 'active'::text));
CREATE POLICY "doctors owner insert" ON public."doctors" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((profile_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'doctor'::text))))));
CREATE POLICY "doctors owner update" ON public."doctors" AS PERMISSIVE FOR UPDATE TO authenticated USING ((profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "doctors public verified read" ON public."doctors" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (((verified = true) OR (profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "hospitals owner insert" ON public."hospitals" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((owner_profile_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'hospital'::text))))));
CREATE POLICY "hospitals owner update" ON public."hospitals" AS PERMISSIVE FOR UPDATE TO authenticated USING ((owner_profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "hospitals public verified read" ON public."hospitals" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (((verified = true) OR (owner_profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "laboratories owner insert" ON public."laboratories" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((owner_profile_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'laboratory'::text))))));
CREATE POLICY "laboratories owner update" ON public."laboratories" AS PERMISSIVE FOR UPDATE TO authenticated USING ((owner_profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "laboratories public verified read" ON public."laboratories" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (((verified = true) OR (owner_profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "nurses owner insert" ON public."nurses" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((profile_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'nurse'::text))))));
CREATE POLICY "nurses owner update" ON public."nurses" AS PERMISSIVE FOR UPDATE TO authenticated USING ((profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "nurses public verified read" ON public."nurses" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (((verified = true) OR (profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "pharmacies owner insert" ON public."pharmacies" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((owner_profile_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'pharmacy'::text))))));
CREATE POLICY "pharmacies owner update" ON public."pharmacies" AS PERMISSIVE FOR UPDATE TO authenticated USING ((owner_profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "pharmacies public verified read" ON public."pharmacies" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (((verified = true) OR (owner_profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can insert own profile" ON public."profiles" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "Users can update own profile" ON public."profiles" AS PERMISSIVE FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "Users can view own profile" ON public."profiles" AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profile own insert" ON public."profiles" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profile own read" ON public."profiles" AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profile own update" ON public."profiles" AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "profiles admin update" ON public."profiles" AS PERMISSIVE FOR UPDATE TO authenticated USING (( SELECT private.is_current_user_admin() AS is_current_user_admin)) WITH CHECK (( SELECT private.is_current_user_admin() AS is_current_user_admin));
CREATE POLICY "provider applications admin update" ON public."provider_applications" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text)))));
CREATE POLICY "provider applications own insert" ON public."provider_applications" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "provider applications own read" ON public."provider_applications" AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))));
CREATE POLICY "provider_application_pending_insert_guard" ON public."provider_applications" AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (status = 'pending'::text) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL)));
CREATE POLICY "service requests participant read" ON public."service_requests" AS PERMISSIVE FOR SELECT TO authenticated USING (((requester_id = ( SELECT auth.uid() AS uid)) OR (assigned_provider_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))));
CREATE POLICY "service requests requester cancel" ON public."service_requests" AS PERMISSIVE FOR UPDATE TO authenticated USING (((requester_id = ( SELECT auth.uid() AS uid)) OR (assigned_provider_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text)))))) WITH CHECK (((requester_id = ( SELECT auth.uid() AS uid)) OR (assigned_provider_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::text))))));
CREATE POLICY "service requests requester insert" ON public."service_requests" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((requester_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "services public read" ON public."services" AS PERMISSIVE FOR SELECT TO anon,authenticated USING ((is_active = true));
ALTER TABLE public."bookings" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."bookings" TO anon,authenticated,service_role;
ALTER TABLE public."course_enrollments" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."course_enrollments" TO anon,authenticated,service_role;
ALTER TABLE public."courses" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."courses" TO anon,authenticated,service_role;
ALTER TABLE public."doctors" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."doctors" TO anon,authenticated,service_role;
ALTER TABLE public."hospitals" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."hospitals" TO anon,authenticated,service_role;
ALTER TABLE public."laboratories" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."laboratories" TO anon,authenticated,service_role;
ALTER TABLE public."nurses" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."nurses" TO anon,authenticated,service_role;
ALTER TABLE public."pharmacies" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."pharmacies" TO anon,authenticated,service_role;
ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."profiles" TO anon,authenticated,service_role;
ALTER TABLE public."provider_applications" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."provider_applications" TO anon,authenticated,service_role;
ALTER TABLE public."service_requests" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."service_requests" TO anon,authenticated,service_role;
ALTER TABLE public."services" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."services" TO anon,authenticated,service_role;
`;

const migration = fs.readFileSync(path.join(__dirname, '../docs/proposed-database-fixes.sql'), 'utf8');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = uid(1), patient = uid(2), outsider = uid(3), doctor = uid(4);
let db, checks = 0;
async function q(sql, args = []) { return (await db.query(sql, args)).rows; }
async function as(role, user, work) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); }
  finally { await db.exec('RESET ROLE'); await db.exec("SELECT set_config('request.jwt.claim.sub', '', false)"); }
}
async function run(name, work) {
  await work(); checks++; process.stdout.write(`PASS ${name}\n`);
}
async function denies(work, pattern = /./) {
  await assert.rejects(work, error => pattern.test(error.message));
}
async function row(table, id) { return (await q(`SELECT * FROM public.${table} WHERE id=$1`, [id]))[0]; }
async function seed(target = db) {
  const engine=(await target.query("SELECT current_setting('server_version_num')::integer AS version")).rows[0].version;
  assert.equal(Math.trunc(engine/10000),17,'Runtime fixture requires PostgreSQL 17 semantics');
  await target.exec(catalogFixture);
  const roles = ['admin','patient','patient','doctor','nurse','hospital','laboratory','pharmacy','instructor','patient','admin'];
  // Synthetic pre-existing stored roles only. This never runs on a live database.
  await target.exec('ALTER TABLE public.profiles DISABLE TRIGGER protect_profile_role_trigger');
  for (let n=1; n<=roles.length; n++) {
    await target.query('INSERT INTO auth.users(id) VALUES($1)', [uid(n)]);
    await target.query('INSERT INTO public.profiles(id,full_name,role) VALUES($1,$2,$3)', [uid(n), `Synthetic ${n}`, roles[n-1]]);
  }
  await target.exec('ALTER TABLE public.profiles ENABLE TRIGGER protect_profile_role_trigger');
  await target.query("INSERT INTO public.services(id,name,slug) VALUES($1,'Synthetic nursing','home-nursing')", [uid(100)]);
}
async function createDatabase({ applyBase = false } = {}) {
  const isolated = new PGlite();
  try { await seed(isolated);if(applyBase)await isolated.exec(migration);return isolated; }
  catch(error) { await isolated.close();throw error; }
}
async function createCourse(id, overrides = {}) {
  const values = { id, publisher_id: doctor, title:'Synthetic course', provider_name:'Synthetic provider', description:'Synthetic description', is_free:true, price:0, review_status:'approved', status:'active', ...overrides };
  const keys = Object.keys(values);
  await q(`INSERT INTO public.courses(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`, Object.values(values));
}
async function createBooking(id, owner = patient, overrides = {}) {
  const values = { id,user_id:owner,service:'Synthetic nursing',patient_name:'Synthetic patient',phone:'0000000000',booking_date:'2099-01-01',status:'pending',...overrides };
  const keys = Object.keys(values);
  await as('authenticated', owner, () => q(`INSERT INTO public.bookings(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id,service_request_id`, Object.values(values)));
  return row('bookings', id);
}
async function createApplication(id, owner = uid(10), requestedRole = 'nurse') {
  await as('authenticated', owner, () => q('INSERT INTO public.provider_applications(id,user_id,requested_role) VALUES($1,$2,$3)', [id,owner,requestedRole]));
}
async function review(id, expected, next, user = admin) {
  return as('authenticated', user, () => q('SELECT * FROM public.review_booking($1,$2,$3)', [id, expected, next]));
}

async function main() {
  db = new PGlite();
  try {
    await seed();
    process.stdout.write(`${(await q('SELECT version() AS version'))[0].version}\n`);
    // A known defect must first reproduce under the exact old RLS contract.
    await run('baseline approval can mark approved without promoting a cross-user profile', async () => {
      await createApplication(uid(200));
      await as('authenticated', admin, () => q('SELECT public.approve_provider_application($1,true)', [uid(200)]));
      assert.equal((await row('provider_applications',uid(200))).status,'approved');
      assert.equal((await row('profiles',uid(10))).role,'patient');
      await q("UPDATE public.provider_applications SET status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE id=$1",[uid(200)]);
    });
    await run('baseline active draft is publicly visible', async () => {
      await createCourse(uid(300),{ review_status:'draft' });
      assert.equal((await as('anon',null,()=>q('SELECT id FROM public.courses WHERE id=$1',[uid(300)]))).length,1);
    });
    await run('baseline owner can claim verified provider flag', async () => {
      await as('authenticated',doctor,()=>q("INSERT INTO public.doctors(id,profile_id,name,specialty,verified) VALUES($1,$2,$3,'Synthetic specialty',true)",[uid(400),doctor,'Synthetic doctor']));
      assert.equal((await row('doctors',uid(400))).verified,true);
      await q('DELETE FROM public.doctors WHERE id=$1',[uid(400)]);
    });
    await run('baseline participant can change linked request status independently of booking',async()=>{
      const b=await createBooking(uid(190));
      await as('authenticated',patient,()=>q("UPDATE public.service_requests SET status='completed',assigned_provider_id=$1 WHERE id=$2",[doctor,b.service_request_id]));
      assert.equal((await row('service_requests',b.service_request_id)).status,'completed');assert.equal((await row('bookings',uid(190))).status,'pending');
      await q('DELETE FROM public.bookings WHERE id=$1',[uid(190)]);await q('DELETE FROM public.service_requests WHERE id=$1',[b.service_request_id]);
    });
    await run('entire reviewed transaction applies and capability marker returns one', async () => {
      await db.exec(migration);
      assert.equal((await as('authenticated',patient,()=>q('SELECT public.nurse_app_contract_version() AS version')))[0].version,1);
      await denies(()=>as('anon',null,()=>q('SELECT public.nurse_app_contract_version()')),/permission denied/);
    });
    await run('ordinary INSERT and UPDATE cannot obtain administrator role', async () => {
      const fresh=uid(12); await q('INSERT INTO auth.users(id) VALUES($1)',[fresh]);
      await as('authenticated',fresh,()=>q("INSERT INTO public.profiles(id,role) VALUES($1,'admin')",[fresh]));
      assert.equal((await row('profiles',fresh)).role,'patient');
      await as('authenticated',patient,()=>q("UPDATE public.profiles SET role='admin' WHERE id=$1",[patient]));
      assert.equal((await row('profiles',patient)).role,'patient');
    });
    await run('non-admin and anonymous application review reject',async()=>{
      await denies(()=>as('authenticated',patient,()=>q('SELECT public.approve_provider_application($1,true)',[uid(200)])),/admin access required/);
      await denies(()=>as('anon',null,()=>q('SELECT public.approve_provider_application($1,true)',[uid(200)])),/permission denied/);
      assert.equal((await row('provider_applications',uid(200))).status,'pending');
    });
    await run('admin pending approval saves exactly one profile and application',async()=>{
      await as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,true)',[uid(200)]));
      assert.equal((await row('profiles',uid(10))).role,'nurse');
      const app=await row('provider_applications',uid(200));
      assert.equal(app.status,'approved');assert.equal(app.reviewed_by,admin);assert.ok(app.reviewed_at);
    });
    await run('terminal application review cannot be replayed or reversed',async()=>{
      await denies(()=>as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,false)',[uid(200)])),/already reviewed/);
      assert.equal((await row('provider_applications',uid(200))).status,'approved');
      assert.equal((await row('profiles',uid(10))).role,'nurse');
    });
    await run('government approval rejects atomically while rejection remains valid',async()=>{
      await createApplication(uid(201),patient,'government');
      await denies(()=>as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,true)',[uid(201)])),/cannot be approved/);
      const app=await row('provider_applications',uid(201));assert.equal(app.status,'pending');assert.equal(app.reviewed_by,null);
      assert.equal((await row('profiles',patient)).role,'patient');
      await as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,false)',[uid(201)]));
      assert.equal((await row('provider_applications',uid(201))).status,'rejected');
    });
    await run('provider application cannot demote an existing administrator',async()=>{
      await createApplication(uid(202),uid(11),'doctor');
      await denies(()=>as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,true)',[uid(202)])),/administrator role/);
      assert.equal((await row('profiles',uid(11))).role,'admin');assert.equal((await row('provider_applications',uid(202))).status,'pending');
    });
    await run('application INSERT cannot self-approve or forge reviewer data',async()=>{
      await denies(()=>as('authenticated',patient,()=>q("INSERT INTO public.provider_applications(user_id,requested_role,status,reviewed_by) VALUES($1,'doctor','approved',$2)",[patient,admin])),/row-level security/);
    });
    await run('promotion suppression rolls back the application decision',async()=>{
      await createApplication(uid(203),outsider,'doctor');
      await db.exec(`CREATE FUNCTION private.synthetic_suppress_promotion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.role:=OLD.role; RETURN NEW; END $$; CREATE TRIGGER z_synthetic_suppress BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.synthetic_suppress_promotion();`);
      try { await denies(()=>as('authenticated',admin,()=>q('SELECT public.approve_provider_application($1,true)',[uid(203)])),/promotion was not saved/); }
      finally { await db.exec('DROP TRIGGER z_synthetic_suppress ON public.profiles; DROP FUNCTION private.synthetic_suppress_promotion()'); }
      const app=await row('provider_applications',uid(203));assert.equal(app.status,'pending');assert.equal(app.reviewed_by,null);
      assert.equal((await row('profiles',outsider)).role,'patient');
    });
    for(const [table,owner,ownerColumn] of [['doctors',doctor,'profile_id'],['nurses',uid(5),'profile_id'],['hospitals',uid(6),'owner_profile_id'],['laboratories',uid(7),'owner_profile_id'],['pharmacies',uid(8),'owner_profile_id']]) {
      await run(`${table}: owner cannot self-verify and content edits requeue review`,async()=>{
        const id=uid(400+checks);
        await as('authenticated',owner,()=>q(`INSERT INTO public.${table}(id,${ownerColumn},name,verified${table==='doctors'?',specialty':''}) VALUES($1,$2,'Synthetic provider',true${table==='doctors'?",'Synthetic specialty'":''})`,[id,owner]));
        assert.equal((await row(table,id)).verified,false);
        await as('authenticated',owner,()=>q(`UPDATE public.${table} SET verified=true WHERE id=$1`,[id]));
        assert.equal((await row(table,id)).verified,false);
        await as('authenticated',admin,()=>q(`UPDATE public.${table} SET verified=true WHERE id=$1 RETURNING id`,[id]));
        assert.equal((await row(table,id)).verified,true);
        await as('authenticated',owner,()=>q(`UPDATE public.${table} SET name='Changed synthetic provider',verified=true WHERE id=$1`,[id]));
        assert.equal((await row(table,id)).verified,false);
        assert.equal((await as('anon',null,()=>q(`SELECT id FROM public.${table} WHERE id=$1`,[id]))).length,0);
      });
    }
    await run('active draft and rejected courses are hidden from public',async()=>{
      assert.equal((await as('anon',null,()=>q('SELECT id FROM public.courses WHERE id=$1',[uid(300)]))).length,0);
      // Model a pre-migration rejected active row without touching production data.
      await db.exec('ALTER TABLE public.courses DISABLE TRIGGER guard_course_publication_trigger');
      await createCourse(uid(301),{review_status:'rejected'});
      await db.exec('ALTER TABLE public.courses ENABLE TRIGGER guard_course_publication_trigger');
      assert.equal((await as('anon',null,()=>q('SELECT id FROM public.courses WHERE id=$1',[uid(301)]))).length,0);
    });
    await run('owner cannot approve or activate course on INSERT',async()=>{
      await as('authenticated',doctor,()=>createCourse(uid(302),{review_status:'approved',review_note:'forged',published_at:'2099-01-01'}));
      const c=await row('courses',uid(302));assert.equal(c.review_status,'pending');assert.equal(c.status,'closed');assert.equal(c.review_note,null);assert.equal(c.published_at,null);
    });
    await run('admin approval publishes, owner content edit withdraws approval',async()=>{
      await as('authenticated',admin,()=>q("UPDATE public.courses SET review_status='approved',status='active',review_note='Synthetic review' WHERE id=$1",[uid(302)]));
      assert.equal((await as('anon',null,()=>q('SELECT id FROM public.courses WHERE id=$1',[uid(302)]))).length,1);
      await as('authenticated',doctor,()=>q("UPDATE public.courses SET title='Changed title',review_status='approved',status='active' WHERE id=$1",[uid(302)]));
      const c=await row('courses',uid(302));assert.equal(c.review_status,'pending');assert.equal(c.status,'closed');assert.equal(c.review_note,null);assert.equal(c.published_at,null);
    });
    await run('owner may withdraw approved course but cannot reactivate it',async()=>{
      await as('authenticated',admin,()=>q("UPDATE public.courses SET review_status='approved',status='active' WHERE id=$1",[uid(302)]));
      await as('authenticated',doctor,()=>q("UPDATE public.courses SET status='closed' WHERE id=$1",[uid(302)]));
      await as('authenticated',doctor,()=>q("UPDATE public.courses SET status='active' WHERE id=$1",[uid(302)]));
      assert.equal((await row('courses',uid(302))).status,'closed');
    });
    await run('free enrollment is pending only and cannot claim paid or accepted',async()=>{
      await as('authenticated',admin,()=>createCourse(uid(303),{publisher_id:admin}));
      await as('authenticated',patient,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,status,payment_status) VALUES($1,$2,'pending','free')",[uid(303),patient]));
      await denies(()=>as('authenticated',outsider,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,status,payment_status) VALUES($1,$2,'active','free')",[uid(303),outsider])),/row-level security/);
      await denies(()=>as('authenticated',outsider,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,status,payment_status) VALUES($1,$2,'pending','paid')",[uid(303),outsider])),/row-level security/);
      assert.equal((await as('authenticated',outsider,()=>q('SELECT id FROM public.course_enrollments WHERE user_id=$1',[patient]))).length,0);
    });
    await run('paid enrollment stays unpaid pending and rejected courses cannot enroll',async()=>{
      await as('authenticated',admin,()=>createCourse(uid(304),{publisher_id:admin,is_free:false,price:100}));
      await as('authenticated',patient,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,status,payment_status) VALUES($1,$2,'pending','unpaid')",[uid(304),patient]));
      await denies(()=>as('authenticated',outsider,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,payment_status) VALUES($1,$2,'free')",[uid(304),outsider])),/row-level security/);
      await denies(()=>as('authenticated',outsider,()=>q("INSERT INTO public.course_enrollments(course_id,user_id,payment_status) VALUES($1,$2,'free')",[uid(301),outsider])),/row-level security/);
    });
    await run('patient cannot create provider content and owner cannot modify another provider',async()=>{
      await denies(()=>as('authenticated',patient,()=>q("INSERT INTO public.doctors(profile_id,name,specialty) VALUES($1,'Synthetic','Synthetic')",[patient])),/row-level security/);
      const id=uid(499);await as('authenticated',doctor,()=>q("INSERT INTO public.doctors(id,profile_id,name,specialty) VALUES($1,$2,'Synthetic','Synthetic')",[id,doctor]));
      assert.equal((await as('authenticated',outsider,()=>q('UPDATE public.doctors SET verified=true WHERE id=$1 RETURNING id',[id]))).length,0);
      assert.equal((await row('doctors',id)).verified,false);
    });
    await run('booking creation is linked atomically and own rows stay private',async()=>{
      const b=await createBooking(uid(500));assert.ok(b.service_request_id);
      const r=await row('service_requests',b.service_request_id);assert.equal(r.requester_id,patient);assert.equal(r.status,'pending');
      assert.equal((await as('authenticated',outsider,()=>q('SELECT id FROM public.bookings WHERE id=$1',[uid(500)]))).length,0);
      assert.equal((await as('authenticated',admin,()=>q('SELECT id FROM public.bookings WHERE id=$1',[uid(500)]))).length,1);
      await denies(()=>createBooking(uid(599),patient,{status:'completed'}),/row-level security/);
    });
    await run('non-admin and anonymous booking review reject without mutation',async()=>{
      await denies(()=>review(uid(500),'pending','confirmed',patient),/admin access required/);
      await denies(()=>as('anon',null,()=>q('SELECT * FROM public.review_booking($1,$2,$3)',[uid(500),'pending','confirmed'])),/permission denied/);
      assert.equal((await row('bookings',uid(500))).status,'pending');
    });
    await run('invalid booking transition and direct booking UPDATE reject',async()=>{
      await denies(()=>review(uid(500),'pending','completed'),/transition is not allowed/);
      await denies(()=>review(uid(500),'pending','not-a-state'),/invalid booking review/);
      assert.equal((await as('authenticated',patient,()=>q("UPDATE public.bookings SET status='confirmed' WHERE id=$1 RETURNING id",[uid(500)]))).length,0);
      assert.equal((await as('authenticated',admin,()=>q("UPDATE public.bookings SET status='confirmed' WHERE id=$1 RETURNING id",[uid(500)]))).length,0);
    });
    await run('admin confirmation atomically changes booking and linked request',async()=>{
      const result=await review(uid(500),'pending','confirmed');assert.equal(result.length,1);assert.equal(result[0].status,'confirmed');assert.equal(result[0].service_request_status,'accepted');
      const b=await row('bookings',uid(500));assert.equal(b.status,'confirmed');assert.equal((await row('service_requests',b.service_request_id)).status,'accepted');
    });
    await run('stale booking review rejects without changing either linked row',async()=>{
      await denies(()=>review(uid(500),'pending','cancelled'),/booking changed/);
      const b=await row('bookings',uid(500));assert.equal(b.status,'confirmed');assert.equal((await row('service_requests',b.service_request_id)).status,'accepted');
    });
    await run('completion is atomic and terminal review cannot be replayed',async()=>{
      await review(uid(500),'confirmed','completed');
      const b=await row('bookings',uid(500));assert.equal(b.status,'completed');assert.equal((await row('service_requests',b.service_request_id)).status,'completed');
      await denies(()=>review(uid(500),'completed','cancelled'),/transition is not allowed/);
      assert.equal((await row('bookings',uid(500))).status,'completed');
    });
    await run('mismatched request owner rejects both updates',async()=>{
      const b=await createBooking(uid(501));await q('UPDATE public.service_requests SET requester_id=$1 WHERE id=$2',[outsider,b.service_request_id]);
      await denies(()=>review(uid(501),'pending','confirmed'),/does not match/);
      assert.equal((await row('bookings',uid(501))).status,'pending');assert.equal((await row('service_requests',b.service_request_id)).status,'pending');
    });
    await run('mismatched assigned provider rejects both updates',async()=>{
      const b=await createBooking(uid(502));await q('UPDATE public.bookings SET provider_profile_id=$1 WHERE id=$2',[doctor,uid(502)]);await q('UPDATE public.service_requests SET assigned_provider_id=$1 WHERE id=$2',[uid(5),b.service_request_id]);
      await denies(()=>review(uid(502),'pending','confirmed'),/provider changed/);
      assert.equal((await row('bookings',uid(502))).status,'pending');assert.equal((await row('service_requests',b.service_request_id)).status,'pending');
    });
    await run('terminal linked request rejects pending booking confirmation',async()=>{
      const b=await createBooking(uid(503));await q("UPDATE public.service_requests SET status='cancelled' WHERE id=$1",[b.service_request_id]);
      await denies(()=>review(uid(503),'pending','confirmed'),/request state changed/);
      assert.equal((await row('bookings',uid(503))).status,'pending');assert.equal((await row('service_requests',b.service_request_id)).status,'cancelled');
    });
    await run('missing linked request rejects legacy booking review',async()=>{
      await createBooking(uid(504));await q('UPDATE public.bookings SET service_request_id=NULL WHERE id=$1',[uid(504)]);
      await denies(()=>review(uid(504),'pending','confirmed'),/no linked request/);
      assert.equal((await row('bookings',uid(504))).status,'pending');
    });
    await run('pending Arabic status cancellation maps to linked cancelled',async()=>{
      const b=await createBooking(uid(505),patient,{status:'قيد المراجعة'});await review(uid(505),'قيد المراجعة','cancelled');
      assert.equal((await row('bookings',uid(505))).status,'cancelled');assert.equal((await row('service_requests',b.service_request_id)).status,'cancelled');
    });
    await run('failure of second linked UPDATE rolls back the first UPDATE',async()=>{
      const b=await createBooking(uid(506));
      await db.exec(`CREATE FUNCTION private.synthetic_fail_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic booking write failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION private.synthetic_fail_booking();`);
      try { await denies(()=>review(uid(506),'pending','confirmed'),/synthetic booking write failure/); }
      finally { await db.exec('DROP TRIGGER synthetic_fail ON public.bookings; DROP FUNCTION private.synthetic_fail_booking()'); }
      assert.equal((await row('bookings',uid(506))).status,'pending');assert.equal((await row('service_requests',b.service_request_id)).status,'pending');
    });
    await run('requester cannot change linked request authority or status',async()=>{
      const b=await createBooking(uid(507));
      for(const statement of [
        ["UPDATE public.service_requests SET status='completed' WHERE id=$1",[b.service_request_id]],
        ['UPDATE public.service_requests SET assigned_provider_id=$1 WHERE id=$2',[doctor,b.service_request_id]],
        ['UPDATE public.service_requests SET requester_id=$1,assigned_provider_id=$2 WHERE id=$3',[outsider,patient,b.service_request_id]],
        ['UPDATE public.service_requests SET id=$1 WHERE id=$2',[uid(999),b.service_request_id]],
        ['UPDATE public.service_requests SET service_id=NULL WHERE id=$1',[b.service_request_id]],
        ["UPDATE public.service_requests SET created_at='2099-01-01' WHERE id=$1",[b.service_request_id]]
      ]) await denies(()=>as('authenticated',patient,()=>q(...statement)),/requires booking review/);
      const r=await row('service_requests',b.service_request_id);assert.equal(r.status,'pending');assert.equal(r.assigned_provider_id,null);assert.equal(r.requester_id,patient);assert.equal(r.service_id,uid(100));
      assert.equal((await row('bookings',uid(507))).status,'pending');
    });
    await run('assigned provider cannot bypass link detection through bookings RLS',async()=>{
      const b=await createBooking(uid(508));
      await q('UPDATE public.service_requests SET assigned_provider_id=$1 WHERE id=$2',[doctor,b.service_request_id]);
      assert.equal((await as('authenticated',doctor,()=>q('SELECT id FROM public.bookings WHERE id=$1',[uid(508)]))).length,0);
      assert.equal((await as('authenticated',doctor,()=>q('SELECT id FROM public.service_requests WHERE id=$1',[b.service_request_id]))).length,1);
      await denies(()=>as('authenticated',doctor,()=>q("UPDATE public.service_requests SET status='completed' WHERE id=$1",[b.service_request_id])),/requires booking review/);
      await denies(()=>as('authenticated',doctor,()=>q('UPDATE public.service_requests SET requester_id=$1 WHERE id=$2',[outsider,b.service_request_id])),/requires booking review/);
      assert.equal((await row('service_requests',b.service_request_id)).status,'pending');
    });
    await run('linked participant nonauthority edits and no-JWT trusted maintenance remain allowed',async()=>{
      const b=await row('bookings',uid(508));
      await as('authenticated',doctor,()=>q("UPDATE public.service_requests SET notes='Synthetic note',address='Synthetic address' WHERE id=$1",[b.service_request_id]));
      const r=await row('service_requests',b.service_request_id);assert.equal(r.notes,'Synthetic note');assert.equal(r.address,'Synthetic address');
      await as('service_role',null,()=>q("UPDATE public.service_requests SET status='accepted' WHERE id=$1",[b.service_request_id]));
      assert.equal((await row('service_requests',b.service_request_id)).status,'accepted');
      // A no-JWT client role must not inherit the SECURITY DEFINER owner's bypass.
      // Direct function execution is denied, and RLS filters all client update rows.
      await denies(()=>as('authenticated',null,()=>q('SELECT private.guard_linked_request_authority()')),/permission denied/);
      assert.equal((await as('authenticated',null,()=>q("UPDATE public.service_requests SET status='completed' WHERE id=$1 RETURNING id",[b.service_request_id]))).length,0);
      assert.equal((await row('service_requests',b.service_request_id)).status,'accepted');
    });
    await run('guard rejects no-JWT client even if a permissive policy exposes a linked row',async()=>{
      const b=await row('bookings',uid(508));
      await db.exec('CREATE POLICY synthetic_read ON public.service_requests FOR SELECT TO authenticated USING(true); CREATE POLICY synthetic_update ON public.service_requests FOR UPDATE TO authenticated USING(true) WITH CHECK(true)');
      try { await denies(()=>as('authenticated',null,()=>q("UPDATE public.service_requests SET status='completed',notes='Must roll back' WHERE id=$1",[b.service_request_id])),/authentication required/); }
      finally { await db.exec('DROP POLICY synthetic_read ON public.service_requests; DROP POLICY synthetic_update ON public.service_requests'); }
      const r=await row('service_requests',b.service_request_id);assert.equal(r.status,'accepted');assert.equal(r.notes,'Synthetic note');
    });
    await run('unlinked participant status workflow retains its pre-existing behavior',async()=>{
      const id=uid(509);
      await as('authenticated',patient,()=>q('INSERT INTO public.service_requests(id,requester_id) VALUES($1,$2)',[id,patient]));
      await as('authenticated',patient,()=>q("UPDATE public.service_requests SET status='completed',assigned_provider_id=$1 WHERE id=$2",[doctor,id]));
      const r=await row('service_requests',id);assert.equal(r.status,'completed');assert.equal(r.assigned_provider_id,doctor);
    });
    await run('complete migration can be reapplied without duplicate policy or trigger',async()=>{
      await db.exec(migration);
      assert.equal((await q("SELECT count(*)::integer AS n FROM pg_trigger WHERE tgname='guard_provider_verification_trigger' AND NOT tgisinternal"))[0].n,5);
      assert.equal((await q("SELECT count(*)::integer AS n FROM pg_policies WHERE policyname='profiles admin read'"))[0].n,1);
    });
    await run('a schema-contract failure rolls back every migration change and marker',async()=>{
      const prior=db;const isolated=new PGlite();db=isolated;
      try {
        await seed();await db.exec('DROP POLICY "course enrollment own insert" ON public.course_enrollments');
        await denies(()=>db.exec(migration),/does not exist/);
        await db.exec('ROLLBACK');
        assert.equal((await q("SELECT count(*)::integer AS n FROM pg_policies WHERE policyname='profiles admin read'"))[0].n,0);
        assert.equal((await q("SELECT count(*)::integer AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='nurse_app_contract_version'"))[0].n,0);
        assert.equal((await q("SELECT count(*)::integer AS n FROM pg_trigger WHERE tgname='guard_course_publication_trigger'"))[0].n,0);
      } finally { await isolated.close();db=prior; }
    });
    process.stdout.write(`Database runtime: ${checks} scenarios passed. Synthetic, isolated; no live writes.\n`);
  } finally { await db.close(); }
}
module.exports = { createDatabase, uid, catalogFixture, PGlite };
if(require.main===module) main().catch(error=>{ process.stderr.write(`${error.stack || error}\n`);process.exitCode=1; });
