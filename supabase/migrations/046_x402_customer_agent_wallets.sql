-- Customers link agent wallets without sharing their storefront session.
-- Auth principals are generated server-side; wallet proof bootstraps only that
-- separate principal. Existing administrator enrollments remain supported.
BEGIN;
CREATE TABLE public.x402_customer_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES auth.users(id),
  auth_user_id uuid NOT NULL UNIQUE REFERENCES public.x402_agent_enrollments(auth_user_id),
  wallet_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX x402_customer_agent_active_wallet ON public.x402_customer_agents(wallet_address) WHERE revoked_at IS NULL;
ALTER TABLE public.x402_customer_agents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_customer_agents FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.x402_customer_agents TO service_role;

CREATE FUNCTION public.link_my_x402_agent(p_auth_user_id uuid,p_wallet_address text,p_auth_domain text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  -- Serialize limits across concurrent provisioning requests from one owner.
  PERFORM id FROM auth.users WHERE id = auth.uid() FOR UPDATE;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND
    (raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb OR raw_app_meta_data->'printkub_x402_recovery' = 'true'::jsonb))
    THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF (SELECT count(*) FROM public.x402_customer_agents WHERE customer_id = auth.uid()) >= 20
    OR (SELECT count(*) FROM public.x402_customer_agents WHERE customer_id = auth.uid() AND revoked_at IS NULL) >= 5
    THEN RAISE EXCEPTION 'agent_link_limit'; END IF;
  IF p_auth_user_id = auth.uid() OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user_id
    AND raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb
    AND raw_app_meta_data->>'printkub_x402_owner' = auth.uid()::text
    AND raw_app_meta_data->>'provider' = 'email' AND raw_app_meta_data->>'printkub_provider' IS NULL)
    OR EXISTS (SELECT 1 FROM public.auth_provider_bindings WHERE user_id = p_auth_user_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_auth_user_id AND provider <> 'email')
    OR EXISTS (SELECT 1 FROM public.print_jobs WHERE user_id = p_auth_user_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_auth_user_id AND roles && ARRAY['admin','creator','printer']::text[])
    THEN RAISE EXCEPTION 'dedicated_agent_required'; END IF;
  INSERT INTO public.x402_agent_enrollments(auth_user_id,wallet_address,auth_domain,approved_by)
    VALUES(p_auth_user_id,p_wallet_address,p_auth_domain,auth.uid());
  INSERT INTO public.x402_customer_agents(customer_id,auth_user_id,wallet_address)
    VALUES(auth.uid(),p_auth_user_id,p_wallet_address) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.my_linked_x402_agents() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'auth_user_id',l.auth_user_id,
    'wallet_address',l.wallet_address,'agent_id',a.id,'wallet_verified_at',a.wallet_verified_at,
    'revoked_at',COALESCE(l.revoked_at,e.revoked_at,a.revoked_at),'created_at',l.created_at) ORDER BY l.created_at DESC),'[]'::jsonb)
  FROM public.x402_customer_agents l JOIN public.x402_agent_enrollments e ON e.auth_user_id = l.auth_user_id
  LEFT JOIN public.x402_agents a ON a.auth_user_id = l.auth_user_id WHERE l.customer_id = auth.uid();
$$;
CREATE FUNCTION public.revoke_my_x402_agent(p_link_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.x402_customer_agents;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO l FROM public.x402_customer_agents WHERE id = p_link_id AND customer_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden'; END IF;
  -- Same enrollment-first lock order as verification and admin revocation.
  PERFORM auth_user_id FROM public.x402_agent_enrollments WHERE auth_user_id = l.auth_user_id FOR UPDATE;
  UPDATE public.x402_customer_agents SET revoked_at = COALESCE(revoked_at,now()) WHERE id = l.id;
  UPDATE public.x402_agent_enrollments SET revoked_at = COALESCE(revoked_at,now()) WHERE auth_user_id = l.auth_user_id;
  UPDATE public.x402_agents SET revoked_at = COALESCE(revoked_at,now()) WHERE auth_user_id = l.auth_user_id;
  -- Unstarted grants are unusable once the agent is revoked. Already submitted
  -- attempts retain their atomic reservation and reconciliation path.
  RETURN true;
END;
$$;

CREATE TABLE public.x402_agent_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES public.x402_agent_enrollments(auth_user_id),
  message text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX x402_agent_login_principal_time ON public.x402_agent_login_challenges(auth_user_id,issued_at);
ALTER TABLE public.x402_agent_login_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_agent_login_challenges FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.issue_x402_agent_login(p_link_id uuid,p_allow_enrollment boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_agent_login_challenges;
  v_id uuid := gen_random_uuid(); v_now timestamptz := clock_timestamp(); v_expires timestamptz;
BEGIN
  SELECT e0.* INTO STRICT e FROM public.x402_agent_enrollments e0 JOIN public.x402_customer_agents l
    ON l.auth_user_id = e0.auth_user_id WHERE l.id = p_link_id AND l.revoked_at IS NULL FOR UPDATE OF e0;
  IF e.revoked_at IS NOT NULL OR (p_allow_enrollment IS DISTINCT FROM true AND NOT EXISTS
    (SELECT 1 FROM public.x402_agents WHERE auth_user_id = e.auth_user_id AND revoked_at IS NULL))
    THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  IF (SELECT count(*) FROM public.x402_agent_login_challenges WHERE auth_user_id = e.auth_user_id
    AND issued_at > v_now - interval '10 minutes') >= 5 THEN RAISE EXCEPTION 'wallet_challenge_limit'; END IF;
  v_expires := v_now + interval '5 minutes';
  INSERT INTO public.x402_agent_login_challenges(id,auth_user_id,issued_at,expires_at,message)
    VALUES(v_id,e.auth_user_id,v_now,v_expires,
      'PrintKub x402 agent wallet verification' || E'\nDomain: ' || e.auth_domain
      || E'\nEnvironment: solana-devnet\nPrincipal: ' || e.auth_user_id::text
      || E'\nWallet: ' || e.wallet_address || E'\nChallenge: ' || v_id::text || E'\nNonce: ' || gen_random_uuid()::text
      || E'\nIssued: ' || v_now::text || E'\nExpires: ' || v_expires::text
      || E'\nPurpose: Sign in to the linked PrintKub agent only. This message does not authorize a payment.') RETURNING * INTO c;
  RETURN jsonb_build_object('id',c.id,'auth_user_id',e.auth_user_id,'wallet_address',e.wallet_address,
    'auth_domain',e.auth_domain,'message',c.message,'expires_at',c.expires_at);
END;
$$;
-- Consume BEFORE signature verification. Each nonce permits exactly one try.
CREATE FUNCTION public.consume_x402_agent_login(p_challenge_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_agent_login_challenges;
BEGIN
  SELECT e0.* INTO STRICT e FROM public.x402_agent_enrollments e0 JOIN public.x402_agent_login_challenges c0
    ON c0.auth_user_id = e0.auth_user_id WHERE c0.id = p_challenge_id FOR UPDATE OF e0;
  SELECT * INTO STRICT c FROM public.x402_agent_login_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF e.revoked_at IS NOT NULL OR c.consumed_at IS NOT NULL OR c.expires_at <= clock_timestamp()
    THEN RAISE EXCEPTION 'wallet_challenge_unavailable'; END IF;
  UPDATE public.x402_agent_login_challenges SET consumed_at = clock_timestamp() WHERE id = c.id;
  RETURN jsonb_build_object('id',c.id,'auth_user_id',e.auth_user_id,'wallet_address',e.wallet_address,
    'auth_domain',e.auth_domain,'message',c.message,'expires_at',c.expires_at);
END;
$$;
CREATE FUNCTION public.complete_x402_agent_login(p_challenge_id uuid,p_allow_enrollment boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_agent_login_challenges; a public.x402_agents;
BEGIN
  SELECT e0.* INTO STRICT e FROM public.x402_agent_enrollments e0 JOIN public.x402_agent_login_challenges c0
    ON c0.auth_user_id = e0.auth_user_id WHERE c0.id = p_challenge_id FOR UPDATE OF e0;
  SELECT * INTO STRICT c FROM public.x402_agent_login_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF e.revoked_at IS NOT NULL OR c.consumed_at IS NULL OR c.expires_at <= clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM public.x402_customer_agents WHERE auth_user_id = e.auth_user_id AND revoked_at IS NULL)
    OR (p_allow_enrollment IS DISTINCT FROM true AND NOT EXISTS
      (SELECT 1 FROM public.x402_agents WHERE auth_user_id = e.auth_user_id AND revoked_at IS NULL))
    OR NOT EXISTS (SELECT 1 FROM auth.users u JOIN public.x402_customer_agents l ON l.auth_user_id = u.id
      WHERE u.id = e.auth_user_id AND u.raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb
      AND u.raw_app_meta_data->>'printkub_x402_owner' = l.customer_id::text
      AND u.raw_app_meta_data->>'provider' = 'email' AND u.raw_app_meta_data->>'printkub_provider' IS NULL)
    OR EXISTS (SELECT 1 FROM public.auth_provider_bindings WHERE user_id = e.auth_user_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = e.auth_user_id AND provider <> 'email')
    OR EXISTS (SELECT 1 FROM public.print_jobs WHERE user_id = e.auth_user_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE id = e.auth_user_id AND roles && ARRAY['admin','creator','printer']::text[])
    THEN RAISE EXCEPTION 'wallet_challenge_unavailable'; END IF;
  INSERT INTO public.x402_agents(auth_user_id,wallet_address,wallet_verified_at,verification_reference)
    VALUES(e.auth_user_id,e.wallet_address,clock_timestamp(),'wallet-login:' || c.id::text)
    ON CONFLICT (auth_user_id) DO NOTHING;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE auth_user_id = e.auth_user_id;
  IF a.revoked_at IS NOT NULL OR a.wallet_address <> e.wallet_address THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  RETURN jsonb_build_object('id',a.id,'auth_user_id',a.auth_user_id,'wallet_address',a.wallet_address);
END;
$$;
REVOKE ALL ON FUNCTION public.link_my_x402_agent(uuid,text,text),public.my_linked_x402_agents(),public.revoke_my_x402_agent(uuid),
  public.issue_x402_agent_login(uuid,boolean),public.consume_x402_agent_login(uuid),public.complete_x402_agent_login(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.link_my_x402_agent(uuid,text,text),public.my_linked_x402_agents(),public.revoke_my_x402_agent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_x402_agent_login(uuid,boolean),public.consume_x402_agent_login(uuid),public.complete_x402_agent_login(uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.create_x402_payment_quote(p_job_id uuid,p_agent_id uuid,
  p_source_token_account text,p_recipient text,p_recipient_token_account text,
  p_rate_snapshot jsonb,p_resource_url text,p_fee_payer text,p_ttl integer DEFAULT 900)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; a public.x402_agents; q public.x402_payment_quotes;
  v_id uuid := gen_random_uuid(); v_snapshot jsonb; v_rate numeric; v_total numeric; v_amount bigint;
BEGIN
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id = p_job_id FOR UPDATE;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = p_agent_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.x402_customer_agents WHERE auth_user_id = a.auth_user_id
    AND (customer_id <> j.user_id OR revoked_at IS NOT NULL)) THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  IF j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status IS DISTINCT FROM 'submitted'
    OR j.payment_status = 'paid' OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
    OR a.revoked_at IS NOT NULL OR a.auth_user_id = j.user_id
    OR EXISTS (SELECT 1 FROM public.solana_payment_quotes WHERE job_id = j.id)
    OR EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = j.id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE order_no = j.job_number) THEN
    RAISE EXCEPTION 'crypto_order_not_payable';
  END IF;
  PERFORM public.assert_creator_crypto_eligible(j.id,true);
  v_rate := (p_rate_snapshot->>'rate')::numeric;
  v_total := GREATEST(COALESCE(j.total_price,0) + COALESCE(j.shipping_cost,0) - COALESCE(j.discount_amount,0),0);
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate::text IN ('NaN','Infinity','-Infinity')
    OR v_total <= 0 OR p_ttl IS NULL OR p_ttl NOT BETWEEN 60 AND 1800
    OR p_fee_payer IS NULL OR p_fee_payer !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    OR p_fee_payer = a.wallet_address THEN RAISE EXCEPTION 'invalid_x402_quote'; END IF;
  v_amount := ceil(v_total / v_rate * 1.01 * 1000000)::bigint;
  v_snapshot := public.x402_purchase_snapshot(j);
  INSERT INTO public.x402_payment_quotes(id,job_id,customer_id,agent_id,payer,source_token_account,
    recipient,recipient_token_account,total_thb,rate,rate_snapshot,amount_atomic,purchase_snapshot,snapshot_hash,
    resource_url,payment_requirements,expires_at)
  VALUES(v_id,j.id,j.user_id,a.id,a.wallet_address,p_source_token_account,p_recipient,p_recipient_token_account,
    v_total,v_rate,p_rate_snapshot,v_amount,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),
    p_resource_url,jsonb_build_object('scheme','exact','network','solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'asset','4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU','amount',v_amount::text,'payTo',p_recipient,
      'maxTimeoutSeconds',60,'extra',jsonb_build_object('feePayer',p_fee_payer,'memo','printkub-x402:' || v_id::text)),
    now() + make_interval(secs => p_ttl)) RETURNING * INTO q;
  RETURN to_jsonb(q) || jsonb_build_object('amount_atomic',q.amount_atomic::text,'total_thb',q.total_thb::text,'rate',q.rate::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_x402_budget(p_agent_id uuid,p_limit_atomic text,p_ttl integer DEFAULT 3600)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.x402_agents; b public.x402_budgets;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_limit_atomic IS NULL OR p_limit_atomic !~ '^[1-9][0-9]{0,18}$'
    OR p_ttl IS NULL OR p_ttl NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'invalid_x402_budget'; END IF;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = p_agent_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.x402_customer_agents WHERE auth_user_id = a.auth_user_id
    AND (customer_id <> auth.uid() OR revoked_at IS NOT NULL)) THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  IF a.revoked_at IS NOT NULL OR a.auth_user_id = auth.uid() THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  INSERT INTO public.x402_budgets(customer_id,agent_id,limit_atomic,expires_at)
  VALUES(auth.uid(),a.id,p_limit_atomic::bigint,now() + make_interval(secs => p_ttl)) RETURNING * INTO b;
  RETURN to_jsonb(b) || jsonb_build_object('limit_atomic',b.limit_atomic::text,
    'reserved_atomic',b.reserved_atomic::text,'spent_atomic',b.spent_atomic::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_x402_grant(p_quote_id uuid,p_budget_id uuid,
  p_cap_atomic text DEFAULT '2000000',p_ttl integer DEFAULT 600)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; q public.x402_payment_quotes; b public.x402_budgets; a public.x402_agents; g public.x402_grants;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  -- Filter owner before locking/disclosing any purchase.
  SELECT j0.* INTO STRICT j FROM public.print_jobs j0 JOIN public.x402_payment_quotes q0 ON q0.job_id = j0.id
    WHERE q0.id = p_quote_id AND q0.customer_id = auth.uid() AND j0.user_id = auth.uid() FOR UPDATE OF j0;
  SELECT * INTO STRICT b FROM public.x402_budgets WHERE id = p_budget_id AND customer_id = auth.uid() FOR UPDATE;
  SELECT * INTO STRICT q FROM public.x402_payment_quotes WHERE id = p_quote_id;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = q.agent_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.x402_customer_agents WHERE auth_user_id = a.auth_user_id
    AND (customer_id <> auth.uid() OR revoked_at IS NOT NULL)) THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  IF p_cap_atomic IS NULL OR p_cap_atomic !~ '^[1-9][0-9]{0,18}$'
    OR p_ttl IS NULL OR p_ttl NOT BETWEEN 60 AND 1800 THEN RAISE EXCEPTION 'invalid_x402_grant'; END IF;
  IF a.revoked_at IS NOT NULL OR a.wallet_address <> q.payer OR b.agent_id <> a.id
    OR b.expires_at <= now() OR q.expires_at <= now()
    OR q.amount_atomic > p_cap_atomic::bigint OR q.amount_atomic > b.limit_atomic - b.spent_atomic - b.reserved_atomic
    OR j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status IS DISTINCT FROM 'submitted'
    OR j.payment_status = 'paid' OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
    OR public.x402_purchase_snapshot(j) IS DISTINCT FROM q.purchase_snapshot
    OR EXISTS (SELECT 1 FROM public.solana_payment_quotes WHERE job_id = j.id)
    OR EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = j.id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE order_no = j.job_number) THEN RAISE EXCEPTION 'x402_grant_not_approvable'; END IF;
  PERFORM public.assert_creator_crypto_eligible(j.id,true);
  UPDATE public.x402_grants SET status = 'revoked',revoked_at = now()
    WHERE job_id = j.id AND status = 'approved' AND expires_at <= now();
  INSERT INTO public.x402_grants(job_id,quote_id,customer_id,agent_id,budget_id,cap_atomic,expires_at)
  VALUES(j.id,q.id,auth.uid(),a.id,b.id,p_cap_atomic::bigint,
    LEAST(q.expires_at,b.expires_at,now() + make_interval(secs => p_ttl))) RETURNING * INTO g;
  RETURN to_jsonb(g) || jsonb_build_object('cap_atomic',g.cap_atomic::text);
END;
$$;
COMMIT;
