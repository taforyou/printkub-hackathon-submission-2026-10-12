-- Add fixed, non-personal diagnostics to the existing delivery gate.
-- Identity, snapshot equality, phone validation and consent rules are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_my_x402_policy(p_agent_id uuid,p_options jsonb,p_delivery jsonb,
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
    IF p_delivery IS DISTINCT FROM public.x402_saved_delivery(auth.uid()) THEN
      RAISE EXCEPTION 'delivery_not_approved' USING DETAIL = 'delivery_snapshot_mismatch';
    END IF;
    FOREACH k IN ARRAY ARRAY['recipient_name','line1','subdistrict','district','province','postal_code'] LOOP
      IF NULLIF(trim(p_delivery->'address'->>k),'') IS NULL THEN
        RAISE EXCEPTION 'delivery_not_approved' USING DETAIL = 'delivery_missing_' || k;
      END IF;
    END LOOP;
  ELSIF p_delivery->>'method' = 'pickup' THEN
    IF NULLIF(trim(p_delivery->>'details'),'') IS NULL OR p_delivery - ARRAY['method','phone','details'] <> '{}'::jsonb
      THEN RAISE EXCEPTION 'delivery_not_approved' USING DETAIL = 'delivery_pickup_details_invalid'; END IF;
  ELSE RAISE EXCEPTION 'delivery_not_approved' USING DETAIL = 'delivery_method_invalid'; END IF;
  IF p_delivery->>'phone' IS NULL OR p_delivery->>'phone' !~ '^0[0-9]{8,9}$' THEN
    RAISE EXCEPTION 'delivery_not_approved' USING DETAIL = 'delivery_phone_format_invalid';
  END IF;
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

COMMIT;
