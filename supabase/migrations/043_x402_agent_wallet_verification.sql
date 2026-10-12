-- Chunk 3. Single-use wallet proof for an explicitly approved dedicated Auth
-- principal. No account creation, credential issuance or x402 enablement.
BEGIN;
CREATE TABLE public.x402_agent_enrollments (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  auth_domain text NOT NULL CHECK (auth_domain ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (auth_user_id <> approved_by)
);
CREATE TABLE public.x402_wallet_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES public.x402_agent_enrollments(auth_user_id),
  wallet_address text NOT NULL,
  auth_domain text NOT NULL,
  nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  message text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  verification_token uuid,
  verification_claimed_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK ((verification_token IS NULL) = (verification_claimed_at IS NULL))
);
CREATE INDEX x402_challenges_principal_time ON public.x402_wallet_challenges(auth_user_id,issued_at);
ALTER TABLE public.x402_agent_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_wallet_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_agent_enrollments,public.x402_wallet_challenges FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.x402_agent_enrollments,public.x402_wallet_challenges TO service_role;

CREATE FUNCTION public.require_x402_admin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND 'admin' = ANY(roles)) THEN RAISE EXCEPTION 'forbidden'; END IF;
END;
$$;
CREATE FUNCTION public.enroll_x402_agent(p_auth_user_id uuid,p_wallet_address text,p_auth_domain text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments;
BEGIN
  PERFORM public.require_x402_admin();
  -- app_metadata is owner-controlled. A shopper's existing account must never
  -- become the unattended agent principal, even if an admin supplies its UUID.
  IF p_auth_user_id = auth.uid() OR NOT EXISTS (SELECT 1 FROM auth.users
    WHERE id = p_auth_user_id AND raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb
      AND raw_app_meta_data->>'provider' = 'email' AND raw_app_meta_data->>'printkub_provider' IS NULL)
    OR EXISTS (SELECT 1 FROM public.auth_provider_bindings WHERE user_id = p_auth_user_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_auth_user_id AND provider <> 'email')
    OR EXISTS (SELECT 1 FROM public.print_jobs WHERE user_id = p_auth_user_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_auth_user_id
      AND roles && ARRAY['admin','creator','printer']::text[])
    OR EXISTS (SELECT 1 FROM public.x402_agents WHERE auth_user_id = p_auth_user_id) THEN
    RAISE EXCEPTION 'dedicated_agent_required';
  END IF;
  INSERT INTO public.x402_agent_enrollments(auth_user_id,wallet_address,auth_domain,approved_by)
    VALUES(p_auth_user_id,p_wallet_address,p_auth_domain,auth.uid()) RETURNING * INTO e;
  RETURN jsonb_build_object('auth_user_id',e.auth_user_id,'wallet_address',e.wallet_address,
    'auth_domain',e.auth_domain,'approved_at',e.approved_at);
END;
$$;
CREATE FUNCTION public.revoke_x402_agent(p_auth_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.require_x402_admin();
  PERFORM auth_user_id FROM public.x402_agent_enrollments WHERE auth_user_id = p_auth_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.x402_agent_enrollments SET revoked_at = COALESCE(revoked_at,now()) WHERE auth_user_id = p_auth_user_id;
  UPDATE public.x402_agents SET revoked_at = COALESCE(revoked_at,now()) WHERE auth_user_id = p_auth_user_id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.issue_x402_wallet_challenge() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_wallet_challenges;
  v_id uuid := gen_random_uuid(); v_nonce uuid := gen_random_uuid();
  v_issued timestamptz := clock_timestamp(); v_expires timestamptz; v_message text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO STRICT e FROM public.x402_agent_enrollments WHERE auth_user_id = auth.uid() FOR UPDATE;
  IF e.revoked_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.x402_agents WHERE auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'x402_agent_unavailable';
  END IF;
  IF (SELECT count(*) FROM public.x402_wallet_challenges WHERE auth_user_id = auth.uid()
    AND issued_at > v_issued - interval '10 minutes') >= 5 THEN RAISE EXCEPTION 'wallet_challenge_limit'; END IF;
  v_expires := v_issued + interval '5 minutes';
  v_message := 'PrintKub x402 agent wallet verification' || E'\nDomain: ' || e.auth_domain
    || E'\nEnvironment: solana-devnet\nPrincipal: ' || auth.uid()::text
    || E'\nWallet: ' || e.wallet_address || E'\nChallenge: ' || v_id::text || E'\nNonce: ' || v_nonce::text
    || E'\nIssued: ' || v_issued::text || E'\nExpires: ' || v_expires::text
    || E'\nPurpose: Verify wallet ownership only. This message does not authorize a payment.';
  INSERT INTO public.x402_wallet_challenges(id,auth_user_id,wallet_address,auth_domain,nonce,message,issued_at,expires_at)
    VALUES(v_id,auth.uid(),e.wallet_address,e.auth_domain,v_nonce,v_message,v_issued,v_expires) RETURNING * INTO c;
  RETURN jsonb_build_object('id',c.id,'wallet_address',c.wallet_address,'auth_domain',c.auth_domain,
    'message',c.message,'expires_at',c.expires_at);
END;
$$;
CREATE FUNCTION public.begin_x402_wallet_verification(p_challenge_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_wallet_challenges;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO STRICT e FROM public.x402_agent_enrollments WHERE auth_user_id = auth.uid() FOR UPDATE;
  SELECT * INTO STRICT c FROM public.x402_wallet_challenges
    WHERE id = p_challenge_id AND auth_user_id = auth.uid() FOR UPDATE;
  IF e.revoked_at IS NOT NULL OR c.consumed_at IS NOT NULL OR c.expires_at <= clock_timestamp()
    OR c.attempts >= 5 OR c.wallet_address <> e.wallet_address OR c.auth_domain <> e.auth_domain
    OR (c.verification_claimed_at IS NOT NULL AND c.verification_claimed_at > clock_timestamp() - interval '30 seconds') THEN
    RAISE EXCEPTION 'wallet_challenge_unavailable';
  END IF;
  UPDATE public.x402_wallet_challenges SET attempts = attempts + 1,
    verification_token = gen_random_uuid(),verification_claimed_at = clock_timestamp()
    WHERE id = c.id RETURNING * INTO c;
  RETURN jsonb_build_object('id',c.id,'wallet_address',c.wallet_address,'auth_domain',c.auth_domain,
    'message',c.message,'expires_at',c.expires_at,'verification_token',c.verification_token);
END;
$$;
CREATE FUNCTION public.finish_x402_wallet_verification(p_challenge_id uuid,p_verification_token uuid,p_verified boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.x402_agent_enrollments; c public.x402_wallet_challenges; a public.x402_agents;
BEGIN
  SELECT e0.* INTO STRICT e FROM public.x402_agent_enrollments e0 JOIN public.x402_wallet_challenges c0
    ON c0.auth_user_id = e0.auth_user_id WHERE c0.id = p_challenge_id FOR UPDATE OF e0;
  SELECT * INTO STRICT c FROM public.x402_wallet_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF p_verification_token IS NULL OR c.verification_token IS DISTINCT FROM p_verification_token
    OR c.verification_claimed_at <= clock_timestamp() - interval '30 seconds' OR c.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'wallet_challenge_unavailable';
  END IF;
  IF p_verified IS DISTINCT FROM true THEN
    UPDATE public.x402_wallet_challenges SET verification_token = NULL,verification_claimed_at = NULL WHERE id = c.id;
    RETURN NULL;
  END IF;
  IF e.revoked_at IS NOT NULL OR c.expires_at <= clock_timestamp()
    OR c.wallet_address <> e.wallet_address OR c.auth_domain <> e.auth_domain
    OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = e.auth_user_id
      AND raw_app_meta_data->'printkub_x402_agent' = 'true'::jsonb
      AND raw_app_meta_data->>'provider' = 'email' AND raw_app_meta_data->>'printkub_provider' IS NULL)
    OR EXISTS (SELECT 1 FROM public.auth_provider_bindings WHERE user_id = e.auth_user_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = e.auth_user_id AND provider <> 'email')
    OR EXISTS (SELECT 1 FROM public.print_jobs WHERE user_id = e.auth_user_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE id = e.auth_user_id
      AND roles && ARRAY['admin','creator','printer']::text[]) THEN RAISE EXCEPTION 'wallet_challenge_unavailable'; END IF;
  INSERT INTO public.x402_agents(auth_user_id,wallet_address,wallet_verified_at,verification_reference)
    VALUES(e.auth_user_id,e.wallet_address,clock_timestamp(),'wallet-challenge:' || c.id::text) RETURNING * INTO a;
  UPDATE public.x402_wallet_challenges SET consumed_at = clock_timestamp(),verification_token = NULL,
    verification_claimed_at = NULL WHERE id = c.id;
  RETURN jsonb_build_object('id',a.id,'wallet_address',a.wallet_address,'wallet_verified_at',a.wallet_verified_at);
END;
$$;

CREATE FUNCTION public.my_x402_budgets(p_agent_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(b) || jsonb_build_object('limit_atomic',b.limit_atomic::text,
    'reserved_atomic',b.reserved_atomic::text,'spent_atomic',b.spent_atomic::text) ORDER BY b.created_at DESC),'[]'::jsonb)
  FROM public.x402_budgets b WHERE b.customer_id = auth.uid() AND b.agent_id = p_agent_id;
$$;
-- Full quote snapshots are visible only to their customer, never to the agent.
CREATE FUNCTION public.my_x402_quote(p_quote_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(q) || jsonb_build_object('amount_atomic',q.amount_atomic::text,
    'total_thb',q.total_thb::text,'rate',q.rate::text)
  FROM public.x402_payment_quotes q JOIN public.print_jobs j ON j.id = q.job_id
  WHERE q.id = p_quote_id AND q.customer_id = auth.uid() AND j.user_id = auth.uid();
$$;

-- Only unused quotes that still match this customer's submitted purchase.
CREATE FUNCTION public.my_x402_available_quote(p_order_no text,p_agent_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.my_x402_quote(q.id) FROM public.x402_payment_quotes q
    JOIN public.print_jobs j ON j.id = q.job_id JOIN public.x402_agents a ON a.id = q.agent_id
  WHERE j.job_number = p_order_no AND j.user_id = auth.uid() AND q.customer_id = auth.uid()
    AND q.agent_id = p_agent_id AND q.expires_at > now() AND a.revoked_at IS NULL
    AND j.status = 'submitted' AND j.payment_status IS DISTINCT FROM 'paid'
    AND j.deleted_at IS NULL AND j.coupon_returned_at IS NULL
    AND public.x402_purchase_snapshot(j) = q.purchase_snapshot
    AND NOT EXISTS (SELECT 1 FROM public.x402_grants WHERE quote_id = q.id)
    AND NOT EXISTS (SELECT 1 FROM public.solana_payment_quotes WHERE job_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM public.payments WHERE order_no = j.job_number)
  ORDER BY q.created_at DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.require_x402_admin(),public.finish_x402_wallet_verification(uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finish_x402_wallet_verification(uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.enroll_x402_agent(uuid,text,text),public.revoke_x402_agent(uuid),
  public.issue_x402_wallet_challenge(),public.begin_x402_wallet_verification(uuid),
  public.my_x402_budgets(uuid),public.my_x402_quote(uuid),public.my_x402_available_quote(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enroll_x402_agent(uuid,text,text),public.revoke_x402_agent(uuid),
  public.issue_x402_wallet_challenge(),public.begin_x402_wallet_verification(uuid),
  public.my_x402_budgets(uuid),public.my_x402_quote(uuid),public.my_x402_available_quote(text,uuid) TO authenticated;
COMMIT;
