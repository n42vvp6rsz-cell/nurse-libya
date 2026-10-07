-- UNAPPLIED REVIEW DRAFT. Target juxiaorwaiazfjlmkcvm, catalog checked 2026-10-07.
-- Additive COD medical-supplies store; no seeds, payments, role grants, or backfills.
-- Apply once after runtime tests/review, as one transaction. Existing table-name
-- collisions abort rather than silently inheriting an unknown contract.
-- LYD has THREE decimal places: price_minor is 1/1000 of one Libyan dinar.

BEGIN;

CREATE TABLE public.store_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (title=btrim(title) AND char_length(title) BETWEEN 2 AND 160),
  description text CHECK (description IS NULL OR char_length(description)<=2000),
  category text CHECK (category IS NULL OR char_length(category)<=80),
  image_url text CHECK (image_url IS NULL OR (
    char_length(image_url)<=2000 AND
    image_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/[^[:space:]<>]*)?$'
  )),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'LYD' CHECK (currency='LYD'),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity BETWEEN 0 AND 100000),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.store_orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 2 AND 100),
  phone text NOT NULL CHECK (phone ~ '^\+218[0-9]{9}$'),
  city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 80),
  address text NOT NULL CHECK (char_length(address) BETWEEN 5 AND 500),
  notes text CHECK (notes IS NULL OR char_length(notes)<=1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 1 AND 198000000000),
  currency text NOT NULL DEFAULT 'LYD' CHECK (currency='LYD'),
  payment_method text NOT NULL DEFAULT 'cash_on_delivery' CHECK (payment_method='cash_on_delivery'),
  -- Internal canonical request: excluded from customer/admin Data API grants.
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  CHECK ((status='cancelled')=(cancelled_at IS NOT NULL))
);

CREATE TABLE public.store_order_items (
  order_id uuid NOT NULL REFERENCES public.store_orders(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.store_products(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'LYD' CHECK (currency='LYD'),
  line_total_minor bigint GENERATED ALWAYS AS (quantity::bigint*unit_price_minor::bigint) STORED,
  PRIMARY KEY (order_id,product_id)
);

CREATE INDEX store_orders_owner_created_idx ON public.store_orders(user_id,created_at DESC);
CREATE INDEX store_orders_status_created_idx ON public.store_orders(status,created_at DESC);
CREATE INDEX store_order_items_product_idx ON public.store_order_items(product_id);

ALTER TABLE public.store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_order_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_products,public.store_orders,public.store_order_items FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.store_products TO anon,authenticated;
GRANT INSERT (id,title,description,category,image_url,price_minor,stock_quantity,is_active)
  ON public.store_products TO authenticated;
GRANT UPDATE (title,description,category,image_url,price_minor,stock_quantity,is_active)
  ON public.store_products TO authenticated;
GRANT SELECT (id,user_id,customer_name,phone,city,address,notes,status,total_minor,currency,
  payment_method,created_at,updated_at,cancelled_at) ON public.store_orders TO authenticated;
GRANT SELECT ON public.store_order_items TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE POLICY "store products active read" ON public.store_products FOR SELECT TO anon,authenticated
  USING (is_active);
CREATE POLICY "store products admin read" ON public.store_products FOR SELECT TO authenticated
  USING ((SELECT private.is_current_user_admin()));
CREATE POLICY "store products admin insert" ON public.store_products FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_current_user_admin()));
CREATE POLICY "store products admin update" ON public.store_products FOR UPDATE TO authenticated
  USING ((SELECT private.is_current_user_admin())) WITH CHECK ((SELECT private.is_current_user_admin()));
CREATE POLICY "store orders owner read" ON public.store_orders FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid()));
CREATE POLICY "store orders admin read" ON public.store_orders FOR SELECT TO authenticated
  USING ((SELECT private.is_current_user_admin()));
CREATE POLICY "store items participant read" ON public.store_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.store_orders o WHERE o.id=store_order_items.order_id
    AND (o.user_id=(SELECT auth.uid()) OR (SELECT private.is_current_user_admin()))));

CREATE FUNCTION private.guard_store_product()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_reserved bigint;
BEGIN
  -- Capacity includes stock already reserved by pending/confirmed orders. This
  -- keeps an admin restock from making a later cancellation overflow the limit.
  -- Product row locks serialize the restock with checkout/cancellation.
  IF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity THEN
    SELECT coalesce(sum(i.quantity),0) INTO v_reserved
      FROM public.store_order_items i JOIN public.store_orders o ON o.id=i.order_id
      WHERE i.product_id=OLD.id AND o.status IN ('pending','confirmed');
    IF NEW.stock_quantity::bigint+v_reserved>100000 THEN
      RAISE EXCEPTION 'available and reserved stock exceeds inventory capacity';
    END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION private.guard_store_product() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_store_product_trigger BEFORE UPDATE ON public.store_products
  FOR EACH ROW EXECUTE FUNCTION private.guard_store_product();

-- Privilege is deliberately confined to private code: consumers cannot directly
-- write order ownership/status/prices/snapshots or subtract inventory. The checked
-- wrapper exposes only this atomic authenticated checkout operation.
CREATE FUNCTION private.checkout_store_order(
  p_order_id uuid,p_items jsonb,p_customer_name text,p_phone text,p_city text,p_address text,p_notes text DEFAULT NULL
) RETURNS TABLE(id uuid,status text,total_minor bigint,currency text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  v_uid uuid:=auth.uid(); v_name text; v_phone text; v_city text; v_address text; v_notes text;
  v_item jsonb; v_product_id uuid; v_quantity integer; v_expected integer; v_items jsonb;
  v_request jsonb; v_existing public.store_orders%ROWTYPE; v_product public.store_products%ROWTYPE;
  v_lines jsonb:='[]'::jsonb; v_total bigint:=0; v_created timestamptz; v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'order reference is required'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'items must be an array'; END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'select 1 to 20 products'; END IF;
  v_name:=btrim(p_customer_name); v_city:=btrim(p_city); v_address:=btrim(p_address);
  v_notes:=nullif(btrim(p_notes),'');
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 2 AND 100 OR v_name ~ '[[:cntrl:]]'
    OR v_city IS NULL OR char_length(v_city) NOT BETWEEN 1 AND 80 OR v_city ~ '[[:cntrl:]]'
    OR v_address IS NULL OR char_length(v_address) NOT BETWEEN 5 AND 500
    OR (v_notes IS NOT NULL AND char_length(v_notes)>1000)
    OR p_phone IS NULL OR char_length(p_phone)>25 THEN
    RAISE EXCEPTION 'invalid customer or delivery details';
  END IF;
  v_phone:=regexp_replace(translate(p_phone,'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[[:space:]().-]','','g');
  IF v_phone ~ '^0[0-9]{9}$' THEN v_phone:='+218'||substr(v_phone,2);
  ELSIF v_phone ~ '^00218[0-9]{9}$' THEN v_phone:='+'||substr(v_phone,3);
  END IF;
  IF v_phone !~ '^\+218[0-9]{9}$' THEN RAISE EXCEPTION 'invalid Libyan contact phone'; END IF;

  v_items:='[]'::jsonb;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item)<>'object'
      OR jsonb_typeof(v_item->'product_id') IS DISTINCT FROM 'string'
      OR (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'
      OR (v_item->>'quantity') !~ '^[1-9][0-9]?$'
      OR jsonb_typeof(v_item->'expected_unit_price_minor') IS DISTINCT FROM 'number'
      OR (v_item->>'expected_unit_price_minor') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'invalid product, quantity, or displayed price';
    END IF;
    v_product_id:=(v_item->>'product_id')::uuid;
    v_quantity:=(v_item->>'quantity')::integer;
    v_expected:=(v_item->>'expected_unit_price_minor')::integer;
    IF v_expected>100000000 THEN RAISE EXCEPTION 'displayed price exceeds limit'; END IF;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_product_id,'quantity',v_quantity,
      'expected_unit_price_minor',v_expected));
  END LOOP;
  IF (SELECT count(DISTINCT x.product_id) FROM jsonb_to_recordset(v_items) AS x(product_id uuid))
    <>jsonb_array_length(v_items) THEN RAISE EXCEPTION 'duplicate product in order'; END IF;
  SELECT jsonb_agg(value ORDER BY value->>'product_id') INTO v_items FROM jsonb_array_elements(v_items);
  v_request:=jsonb_build_object('items',v_items,'customer_name',v_name,'phone',v_phone,'city',v_city,
    'address',v_address,'notes',v_notes);

  -- Serializes retries even before the header exists; collisions only add waiting.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text,0));
  SELECT o.* INTO v_existing FROM public.store_orders o WHERE o.id=p_order_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'order reference is unavailable' USING ERRCODE='42501';
    END IF;
    IF v_existing.request_payload IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'order reference belongs to a different saved request';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.status,v_existing.total_minor,v_existing.currency,v_existing.created_at;
    RETURN;
  END IF;

  -- Acquire all product row locks in UUID order, regardless of cart order. The
  -- expected price is only a comparison: current server prices are authoritative.
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) ORDER BY value->>'product_id' LOOP
    v_product_id:=(v_item->>'product_id')::uuid; v_quantity:=(v_item->>'quantity')::integer;
    v_expected:=(v_item->>'expected_unit_price_minor')::integer;
    SELECT p.* INTO v_product FROM public.store_products p WHERE p.id=v_product_id FOR UPDATE;
    IF NOT FOUND OR NOT v_product.is_active THEN RAISE EXCEPTION 'product is unavailable; refresh the cart'; END IF;
    IF v_product.price_minor<>v_expected THEN RAISE EXCEPTION 'product price changed; refresh and review the cart'; END IF;
    IF v_product.stock_quantity<v_quantity THEN RAISE EXCEPTION 'insufficient stock; refresh the cart'; END IF;
    v_total:=v_total+v_product.price_minor::bigint*v_quantity::bigint;
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',v_product_id,'quantity',v_quantity,
      'title',v_product.title,'unit_price_minor',v_product.price_minor,'currency',v_product.currency));
  END LOOP;

  INSERT INTO public.store_orders(id,user_id,customer_name,phone,city,address,notes,total_minor,request_payload)
    VALUES(p_order_id,v_uid,v_name,v_phone,v_city,v_address,v_notes,v_total,v_request)
    RETURNING public.store_orders.created_at INTO v_created;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_lines) ORDER BY value->>'product_id' LOOP
    v_product_id:=(v_item->>'product_id')::uuid; v_quantity:=(v_item->>'quantity')::integer;
    INSERT INTO public.store_order_items(order_id,product_id,title,quantity,unit_price_minor,currency)
      VALUES(p_order_id,v_product_id,v_item->>'title',v_quantity,(v_item->>'unit_price_minor')::integer,v_item->>'currency');
    UPDATE public.store_products p SET stock_quantity=p.stock_quantity-v_quantity
      WHERE p.id=v_product_id AND p.is_active AND p.stock_quantity>=v_quantity;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION 'inventory reservation failed'; END IF;
  END LOOP;
  RETURN QUERY SELECT p_order_id,'pending'::text,v_total,'LYD'::text,v_created;
END
$fn$;
REVOKE ALL ON FUNCTION private.checkout_store_order(uuid,jsonb,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.checkout_store_order(uuid,jsonb,text,text,text,text,text) TO authenticated;

CREATE FUNCTION public.checkout_store_order(
  p_order_id uuid,p_items jsonb,p_customer_name text,p_phone text,p_city text,p_address text,p_notes text DEFAULT NULL
) RETURNS TABLE(id uuid,status text,total_minor bigint,currency text,created_at timestamptz)
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$
  SELECT * FROM private.checkout_store_order(p_order_id,p_items,p_customer_name,p_phone,p_city,p_address,p_notes);
$fn$;
REVOKE ALL ON FUNCTION public.checkout_store_order(uuid,jsonb,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_store_order(uuid,jsonb,text,text,text,text,text) TO authenticated;

CREATE FUNCTION private.transition_store_order(p_order_id uuid,p_expected_status text,p_new_status text)
RETURNS TABLE(id uuid,status text,total_minor bigint,currency text,updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_order public.store_orders%ROWTYPE; v_line record; v_updated timestamptz; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.is_current_user_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE='42501';
  END IF;
  IF p_order_id IS NULL OR p_expected_status IS NULL OR p_new_status IS NULL THEN
    RAISE EXCEPTION 'order and expected transition are required';
  END IF;
  SELECT o.* INTO v_order FROM public.store_orders o WHERE o.id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_order.status IS DISTINCT FROM p_expected_status THEN RAISE EXCEPTION 'order changed; refresh before reviewing'; END IF;
  IF NOT ((v_order.status='pending' AND p_new_status IN ('confirmed','cancelled'))
      OR (v_order.status='confirmed' AND p_new_status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'order transition is not allowed';
  END IF;
  -- Mark inside this same transaction before returning stock, so the product
  -- capacity guard no longer counts the quantities that are being restored.
  -- Any later failure rolls this status change and every stock change back.
  v_updated:=clock_timestamp();
  UPDATE public.store_orders o SET status=p_new_status,updated_at=v_updated,
    cancelled_at=CASE WHEN p_new_status='cancelled' THEN v_updated ELSE NULL END
    WHERE o.id=p_order_id AND o.status=p_expected_status;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'order transition was not saved'; END IF;
  IF p_new_status='cancelled' THEN
    -- Header lock+terminal state prevent a second stock return; product locking
    -- order matches checkout to avoid cross-cart deadlocks.
    FOR v_line IN SELECT i.product_id,i.quantity FROM public.store_order_items i
      WHERE i.order_id=p_order_id ORDER BY i.product_id LOOP
      PERFORM 1 FROM public.store_products p WHERE p.id=v_line.product_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'order product missing; reconcile inventory'; END IF;
    END LOOP;
    FOR v_line IN SELECT i.product_id,i.quantity FROM public.store_order_items i
      WHERE i.order_id=p_order_id ORDER BY i.product_id LOOP
      UPDATE public.store_products p SET stock_quantity=p.stock_quantity+v_line.quantity WHERE p.id=v_line.product_id;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      IF v_count<>1 THEN RAISE EXCEPTION 'inventory restoration failed'; END IF;
    END LOOP;
  END IF;
  RETURN QUERY SELECT p_order_id,p_new_status,v_order.total_minor,v_order.currency,v_updated;
END
$fn$;
REVOKE ALL ON FUNCTION private.transition_store_order(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.transition_store_order(uuid,text,text) TO authenticated;

CREATE FUNCTION public.transition_store_order(p_order_id uuid,p_expected_status text,p_new_status text)
RETURNS TABLE(id uuid,status text,total_minor bigint,currency text,updated_at timestamptz)
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$
  SELECT * FROM private.transition_store_order(p_order_id,p_expected_status,p_new_status);
$fn$;
REVOKE ALL ON FUNCTION public.transition_store_order(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transition_store_order(uuid,text,text) TO authenticated;

-- No row reads or authority: public store availability can be checked before login.
-- Marker appears atomically with the entire schema and checked RPC contract.
CREATE FUNCTION public.nurse_store_contract_version()
RETURNS integer LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT 1;
$fn$;
REVOKE ALL ON FUNCTION public.nurse_store_contract_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.nurse_store_contract_version() TO anon,authenticated;

COMMIT;

-- Controlled checks: role/RLS & column grants; inactive product visibility;
-- admin CAS product update; authoritative 3-decimal pricing; insufficient stock/
-- price change/invalid items rollback; same UUID recovery; foreign-owner UUID denial;
-- expected-status transitions; one-time cancellation stock return. Never run tests
-- against real customers or stock. No online charge/payment capture is represented.
