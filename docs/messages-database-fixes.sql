-- Proposed private messaging contract. Unapplied until its offline allow/deny
-- checks pass and the base proposed-database-fixes.sql contract is installed.
-- Existing rows remain intact. No auth accounts, contacts or messages are seeded.
BEGIN;

DO $prerequisite$
BEGIN
  IF to_regprocedure('public.nurse_app_contract_version()') IS NULL THEN
    RAISE EXCEPTION 'Install the base Nurse Libya contract first';
  END IF;
  IF public.nurse_app_contract_version() IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Unsupported base Nurse Libya contract';
  END IF;
END;
$prerequisite$;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
-- Legacy receiver UPDATE could forge the sender and timestamp. Such rows stay
-- readable but cannot establish new provider-to-patient send authority.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS
  sent_via_private_contract boolean NOT NULL DEFAULT false;
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.messages TO authenticated;
DROP POLICY IF EXISTS "messages sender insert" ON public.messages;
DROP POLICY IF EXISTS "messages receiver mark read" ON public.messages;
DROP POLICY IF EXISTS "messages participants read" ON public.messages;
CREATE POLICY "messages participants read" ON public.messages
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid())=sender_id OR (SELECT auth.uid())=receiver_id);

CREATE INDEX IF NOT EXISTS messages_sender_recent_idx
  ON public.messages(sender_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS messages_receiver_recent_idx
  ON public.messages(receiver_id,created_at DESC,id DESC);

-- Internal bounded lookup: it exposes no profile/contact data and is callable
-- only by the owner of the guarded functions below.
CREATE OR REPLACE FUNCTION private.is_public_message_provider(p_profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $body$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=p_profile_id AND (
      (p.role='doctor' AND EXISTS (SELECT 1 FROM public.doctors d WHERE d.profile_id=p.id AND d.verified)) OR
      (p.role='nurse' AND EXISTS (SELECT 1 FROM public.nurses n WHERE n.profile_id=p.id AND n.verified)) OR
      (p.role='hospital' AND EXISTS (SELECT 1 FROM public.hospitals h WHERE h.owner_profile_id=p.id AND h.verified))
    )
  );
$body$;
REVOKE ALL ON FUNCTION private.is_public_message_provider(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.send_private_message(
  p_message_id uuid,p_receiver_id uuid,p_body text
) RETURNS SETOF public.messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
  v_uid uuid:=auth.uid();
  v_saved public.messages;
BEGIN
  IF v_uid IS NULL OR p_message_id IS NULL OR p_receiver_id IS NULL OR p_receiver_id=v_uid
    OR p_body IS NULL OR length(p_body)>5000 OR btrim(p_body,E' \t\n\r')=''
    OR p_body ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F\202A-\202E\2066-\2069]'
  THEN RAISE EXCEPTION 'Invalid private message' USING ERRCODE='22023'; END IF;

  -- An exact previous write is recoverable even if its provider is no longer
  -- public. Another participant's UUID or changed content never confirms it.
  SELECT m.* INTO v_saved FROM public.messages m WHERE m.id=p_message_id;
  IF FOUND THEN
    IF v_saved.sender_id IS DISTINCT FROM v_uid OR v_saved.receiver_id IS DISTINCT FROM p_receiver_id
       OR v_saved.body IS DISTINCT FROM p_body THEN
      RAISE EXCEPTION 'Message reference is unavailable' USING ERRCODE='22023';
    END IF;
    RETURN NEXT v_saved; RETURN;
  END IF;

  IF NOT (
    private.is_public_message_provider(p_receiver_id)
    OR EXISTS (
      SELECT 1 FROM public.bookings b WHERE
        (b.user_id=v_uid AND b.provider_profile_id=p_receiver_id)
        OR (b.provider_profile_id=v_uid AND b.user_id=p_receiver_id)
    )
    OR (private.is_public_message_provider(v_uid) AND EXISTS (
      SELECT 1 FROM public.messages m WHERE m.sender_id=p_receiver_id AND m.receiver_id=v_uid
        AND m.sent_via_private_contract
    ))
  ) THEN RAISE EXCEPTION 'Private conversation is not authorized' USING ERRCODE='42501'; END IF;

  INSERT INTO public.messages(id,sender_id,receiver_id,body,is_read,sent_via_private_contract)
  VALUES(p_message_id,v_uid,p_receiver_id,p_body,false,true)
  ON CONFLICT(id) DO NOTHING;
  SELECT m.* INTO v_saved FROM public.messages m WHERE m.id=p_message_id;
  IF NOT FOUND OR v_saved.sender_id IS DISTINCT FROM v_uid OR v_saved.receiver_id IS DISTINCT FROM p_receiver_id
     OR v_saved.body IS DISTINCT FROM p_body THEN
    RAISE EXCEPTION 'Message reference is unavailable' USING ERRCODE='22023';
  END IF;
  RETURN NEXT v_saved;
END;
$body$;
REVOKE ALL ON FUNCTION private.send_private_message(uuid,uuid,text) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.send_private_message(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_private_message(
  p_message_id uuid,p_receiver_id uuid,p_body text
) RETURNS SETOF public.messages LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=''
AS $body$ SELECT * FROM private.send_private_message(p_message_id,p_receiver_id,p_body); $body$;
REVOKE ALL ON FUNCTION public.send_private_message(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_private_message(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION private.mark_private_message_read(p_message_id uuid)
RETURNS SETOF public.messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_uid uuid:=auth.uid(); v_saved public.messages;
BEGIN
  IF v_uid IS NULL OR p_message_id IS NULL THEN
    RAISE EXCEPTION 'Private message is not authorized' USING ERRCODE='42501';
  END IF;
  UPDATE public.messages m SET is_read=true
    WHERE m.id=p_message_id AND m.receiver_id=v_uid RETURNING m.* INTO v_saved;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private message is not authorized' USING ERRCODE='42501'; END IF;
  RETURN NEXT v_saved;
END;
$body$;
REVOKE ALL ON FUNCTION private.mark_private_message_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.mark_private_message_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_private_message_read(p_message_id uuid)
RETURNS SETOF public.messages LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=''
AS $body$ SELECT * FROM private.mark_private_message_read(p_message_id); $body$;
REVOKE ALL ON FUNCTION public.mark_private_message_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_private_message_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.nurse_messages_contract_version()
RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$ SELECT 1; $body$;
REVOKE ALL ON FUNCTION public.nurse_messages_contract_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nurse_messages_contract_version() TO authenticated;
COMMIT;
