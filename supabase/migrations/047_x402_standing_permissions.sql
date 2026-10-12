-- Standing consent is distinct from wallet proof and per-order approval.
BEGIN;
CREATE TABLE public.x402_purchase_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES auth.users(id),
  agent_id uuid NOT NULL REFERENCES public.x402_agents(id),
  budget_id uuid NOT NULL UNIQUE REFERENCES public.x402_budgets(id),
  product_id uuid NOT NULL CHECK (product_id = '458c809e-c99e-473a-8952-8b850fa7fe65'),
  shop_id uuid NOT NULL CHECK (shop_id = '645ce058-830f-4f0d-a2a1-8cf69e153fc1'),
  recipient text NOT NULL CHECK (recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
  delivery jsonb NOT NULL CHECK (jsonb_typeof(delivery) = 'object'),
  max_order_atomic bigint NOT NULL CHECK (max_order_atomic > 0),
  max_orders integer NOT NULL CHECK (max_orders BETWEEN 1 AND 20),
  consent_version text NOT NULL CHECK (consent_version = 'standing-purchase-v1'),
  consent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > consent_at)
);
CREATE TABLE public.x402_delegated_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES public.x402_purchase_policies(id),
  agent_id uuid NOT NULL REFERENCES public.x402_agents(id),
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES public.print_jobs(id),
  grant_id uuid UNIQUE REFERENCES public.x402_grants(id),
  allocated_atomic bigint CHECK (allocated_atomic > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,request_id)
);
ALTER TABLE public.x402_purchase_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_delegated_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_purchase_policies,public.x402_delegated_purchases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.x402_purchase_policies,public.x402_delegated_purchases TO service_role;

-- Snapshot the primary saved address. A changed profile invalidates new buying.
CREATE FUNCTION public.x402_saved_delivery(p_customer uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('method','shipping','phone',COALESCE(shipping_phone,phone),
    'address',jsonb_build_object('recipient_name',COALESCE(recipient_name,display_name),
      'line1',address_line1,'line2',address_line2,'subdistrict',subdistrict,
      'district',district,'province',province,'postal_code',postal_code))
  FROM public.user_profiles WHERE id = p_customer AND has_shipping_address;
$$;
-- Plain files use the same default customization snapshot as the storefront.
CREATE FUNCTION public.x402_default_product_options(p public.creator_products) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p.customization IS NOT NULL THEN NULL
    WHEN p.default_color_mappings IS NOT NULL THEN jsonb_build_object('materialId','PLA','priceMode','default',
      'mappings',p.default_color_mappings->'mappings')
    ELSE jsonb_build_object('materialId','PLA','priceMode','default','colorId',p.default_color) END;
$$;
REVOKE ALL ON FUNCTION public.x402_default_product_options(public.creator_products) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.create_my_x402_policy(p_agent_id uuid,p_options jsonb,p_delivery jsonb,
  p_recipient text,p_max_order_atomic text,p_budget_atomic text,p_max_orders integer,
  p_expires_at timestamptz,p_consent_version text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.x402_agents; b uuid; v_id uuid; k text; prod public.creator_products; expected jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND
    (raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb OR raw_app_meta_data->'printkub_x402_recovery' = 'true'::jsonb))
    THEN RAISE EXCEPTION 'forbidden'; END IF;
  PERFORM id FROM auth.users WHERE id = auth.uid() FOR UPDATE;
  SELECT a0.* INTO STRICT a FROM public.x402_agents a0
    JOIN public.x402_customer_agents l ON l.auth_user_id = a0.auth_user_id
    JOIN public.x402_agent_enrollments e ON e.auth_user_id = a0.auth_user_id
    WHERE a0.id = p_agent_id AND l.customer_id = auth.uid() AND l.revoked_at IS NULL
      AND e.revoked_at IS NULL AND a0.revoked_at IS NULL FOR SHARE OF a0,l,e;
  SELECT * INTO STRICT prod FROM public.creator_products WHERE id='458c809e-c99e-473a-8952-8b850fa7fe65'
    AND creator_id='645ce058-830f-4f0d-a2a1-8cf69e153fc1' AND is_published AND is_approved FOR SHARE;
  expected := public.x402_default_product_options(prod);
  IF expected IS NULL OR p_options IS DISTINCT FROM expected
    OR p_delivery IS NULL OR jsonb_typeof(p_delivery) <> 'object'
    OR p_max_order_atomic IS NULL OR p_max_order_atomic !~ '^[1-9][0-9]{0,18}$'
    OR p_budget_atomic IS NULL OR p_budget_atomic !~ '^[1-9][0-9]{0,18}$'
    OR p_max_order_atomic::numeric > 9223372036854775807 OR p_budget_atomic::numeric > 9223372036854775807
    OR p_max_order_atomic::numeric > p_budget_atomic::numeric
    OR p_max_orders IS NULL OR p_max_orders NOT BETWEEN 1 AND 20
    OR p_expires_at IS NULL OR p_expires_at <= now() + interval '1 minute' OR p_expires_at > now() + interval '30 days'
    OR p_consent_version IS DISTINCT FROM 'standing-purchase-v1'
    OR p_recipient IS NULL OR p_recipient !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' OR p_recipient = a.wallet_address
    THEN RAISE EXCEPTION 'invalid_purchase_policy'; END IF;
  PERFORM id FROM public.user_profiles WHERE id=auth.uid() FOR SHARE;
  IF p_delivery->>'method' = 'shipping' THEN
    IF p_delivery IS DISTINCT FROM public.x402_saved_delivery(auth.uid()) THEN RAISE EXCEPTION 'delivery_not_approved'; END IF;
    FOREACH k IN ARRAY ARRAY['recipient_name','line1','subdistrict','district','province','postal_code'] LOOP
      IF NULLIF(trim(p_delivery->'address'->>k),'') IS NULL THEN RAISE EXCEPTION 'delivery_not_approved'; END IF;
    END LOOP;
  ELSIF p_delivery->>'method' = 'pickup' THEN
    IF NULLIF(trim(p_delivery->>'details'),'') IS NULL OR p_delivery - ARRAY['method','phone','details'] <> '{}'::jsonb
      THEN RAISE EXCEPTION 'delivery_not_approved'; END IF;
  ELSE RAISE EXCEPTION 'delivery_not_approved'; END IF;
  IF p_delivery->>'phone' IS NULL OR p_delivery->>'phone' !~ '^0[0-9]{8,9}$' THEN RAISE EXCEPTION 'delivery_not_approved'; END IF;
  IF EXISTS (SELECT 1 FROM public.x402_purchase_policies WHERE agent_id = a.id AND revoked_at IS NULL AND expires_at > now())
    THEN RAISE EXCEPTION 'active_policy_exists'; END IF;
  INSERT INTO public.x402_budgets(customer_id,agent_id,limit_atomic,expires_at)
    VALUES(auth.uid(),a.id,p_budget_atomic::bigint,p_expires_at) RETURNING id INTO b;
  INSERT INTO public.x402_purchase_policies(customer_id,agent_id,budget_id,product_id,shop_id,recipient,options,delivery,
    max_order_atomic,max_orders,expires_at,consent_version)
    VALUES(auth.uid(),a.id,b,'458c809e-c99e-473a-8952-8b850fa7fe65','645ce058-830f-4f0d-a2a1-8cf69e153fc1',
      p_recipient,p_options,p_delivery,p_max_order_atomic::bigint,p_max_orders,p_expires_at,p_consent_version) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.my_x402_policies() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p) || jsonb_build_object('max_order_atomic',p.max_order_atomic::text,
    'budget_atomic',b.limit_atomic::text,'prepared_orders',(SELECT count(*) FROM public.x402_delegated_purchases d WHERE d.policy_id=p.id),
    'allocated_atomic',(SELECT COALESCE(sum(d.allocated_atomic),0)::text FROM public.x402_delegated_purchases d WHERE d.policy_id=p.id)) ORDER BY p.consent_at DESC),'[]')
  FROM public.x402_purchase_policies p JOIN public.x402_budgets b ON b.id=p.budget_id WHERE p.customer_id=auth.uid();
$$;
CREATE FUNCTION public.revoke_my_x402_policy(p_policy_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.x402_purchase_policies SET revoked_at=COALESCE(revoked_at,now()) WHERE id=p_policy_id AND customer_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.x402_saved_delivery(uuid),public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text),
  public.my_x402_policies(),public.revoke_my_x402_policy(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text),
  public.my_x402_policies(),public.revoke_my_x402_policy(uuid) TO authenticated;
COMMIT;
