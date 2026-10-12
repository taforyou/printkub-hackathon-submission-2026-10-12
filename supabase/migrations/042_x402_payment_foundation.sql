-- Local x402 foundation only. Does not enable payments or provision wallets.
-- Apply after 040 and 041 through the owner's normal migration process.
BEGIN;

CREATE TABLE public.x402_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  environment text NOT NULL DEFAULT 'solana-devnet' CHECK (environment = 'solana-devnet'),
  wallet_verified_at timestamptz NOT NULL,
  verification_reference text NOT NULL CHECK (length(verification_reference) BETWEEN 1 AND 200),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.x402_agents IS
  'Service-provisioned agent principals; insert only after single-use wallet-control verification. No customer session sharing.';

CREATE TABLE public.x402_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES auth.users(id),
  agent_id uuid NOT NULL REFERENCES public.x402_agents(id),
  network text NOT NULL DEFAULT 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    CHECK (network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
  mint text NOT NULL DEFAULT '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    CHECK (mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  limit_atomic bigint NOT NULL CHECK (limit_atomic > 0),
  reserved_atomic bigint NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  spent_atomic bigint NOT NULL DEFAULT 0 CHECK (spent_atomic >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Subtraction avoids bigint overflow when checking the cumulative cap.
  CHECK (spent_atomic <= limit_atomic AND reserved_atomic <= limit_atomic - spent_atomic),
  CHECK (expires_at > created_at)
);

CREATE TABLE public.x402_payment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.print_jobs(id),
  customer_id uuid NOT NULL REFERENCES auth.users(id),
  agent_id uuid NOT NULL REFERENCES public.x402_agents(id),
  payer text NOT NULL CHECK (payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  source_token_account text NOT NULL CHECK (source_token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  recipient text NOT NULL CHECK (recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  recipient_token_account text NOT NULL CHECK (recipient_token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  network text NOT NULL DEFAULT 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    CHECK (network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
  mint text NOT NULL DEFAULT '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    CHECK (mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  total_thb numeric(12,2) NOT NULL CHECK (total_thb > 0),
  rate numeric NOT NULL CHECK (rate > 0),
  rate_snapshot jsonb NOT NULL CHECK (jsonb_typeof(rate_snapshot) = 'object'),
  surcharge_bps integer NOT NULL DEFAULT 100 CHECK (surcharge_bps = 100),
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  purchase_snapshot jsonb NOT NULL CHECK (jsonb_typeof(purchase_snapshot) = 'object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  resource_url text NOT NULL CHECK (resource_url ~ '^https://[^[:space:]]+$'),
  payment_requirements jsonb NOT NULL CHECK (jsonb_typeof(payment_requirements) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer <> recipient),
  CHECK (expires_at > created_at)
);
CREATE INDEX x402_quotes_job ON public.x402_payment_quotes(job_id);

CREATE TABLE public.x402_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.print_jobs(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES public.x402_payment_quotes(id),
  customer_id uuid NOT NULL REFERENCES auth.users(id),
  agent_id uuid NOT NULL REFERENCES public.x402_agents(id),
  budget_id uuid NOT NULL REFERENCES public.x402_budgets(id),
  cap_atomic bigint NOT NULL CHECK (cap_atomic > 0),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','revoked','consumed')),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > approved_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX x402_one_approved_grant ON public.x402_grants(job_id) WHERE status = 'approved';
CREATE INDEX x402_grants_budget ON public.x402_grants(budget_id);

CREATE TABLE public.x402_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.print_jobs(id),
  grant_id uuid NOT NULL UNIQUE REFERENCES public.x402_grants(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES public.x402_payment_quotes(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','settling','pending','confirmed','failed_proven')),
  payload_fingerprint text CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  signed_transaction_base64 text CHECK (length(signed_transaction_base64) BETWEEN 1 AND 12000),
  message_hash text CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  provider_response jsonb,
  receipt jsonb,
  failure_evidence jsonb,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settlement_started_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  recovery_claim_id uuid,
  recovery_claimed_at timestamptz,
  recovery_lease_expires_at timestamptz,
  recovery_checked_at timestamptz,
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  UNIQUE (job_id, idempotency_key),
  CHECK ((recovery_claim_id IS NULL) = (recovery_claimed_at IS NULL)),
  CHECK ((recovery_claim_id IS NULL) = (recovery_lease_expires_at IS NULL)),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((status = 'failed_proven') = (failed_at IS NOT NULL)),
  CHECK (status NOT IN ('settling','pending','confirmed') OR
    (payload_fingerprint IS NOT NULL AND signed_transaction_base64 IS NOT NULL
      AND message_hash IS NOT NULL AND settlement_started_at IS NOT NULL)),
  CHECK (status <> 'confirmed' OR (signature IS NOT NULL AND receipt IS NOT NULL)),
  CHECK (status <> 'failed_proven' OR failure_evidence IS NOT NULL)
);
CREATE INDEX x402_pending_recovery ON public.x402_payment_attempts(reserved_at)
  WHERE status IN ('reserved','settling','pending');

CREATE TABLE public.crypto_order_payment_reservations (
  job_id uuid PRIMARY KEY REFERENCES public.print_jobs(id),
  path text NOT NULL CHECK (path IN ('human','x402')),
  human_quote_id uuid UNIQUE REFERENCES public.solana_payment_quotes(id),
  x402_attempt_id uuid UNIQUE REFERENCES public.x402_payment_attempts(id),
  status text NOT NULL CHECK (status IN ('pending','confirmed','failed_proven')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((path = 'human' AND human_quote_id IS NOT NULL AND x402_attempt_id IS NULL)
    OR (path = 'x402' AND human_quote_id IS NULL AND x402_attempt_id IS NOT NULL))
);
-- One registry enforces replay uniqueness across both payment implementations.
CREATE TABLE public.crypto_payment_transactions (
  network text NOT NULL CHECK (network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
  signature text NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  job_id uuid NOT NULL REFERENCES public.print_jobs(id),
  human_quote_id uuid UNIQUE REFERENCES public.solana_payment_quotes(id),
  x402_attempt_id uuid UNIQUE REFERENCES public.x402_payment_attempts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, signature),
  CHECK ((human_quote_id IS NOT NULL) <> (x402_attempt_id IS NOT NULL))
);

-- No client table access, including to snapshots containing shipping data.
-- Customer/agent views are purpose-built RPC projections below.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['x402_agents','x402_budgets','x402_payment_quotes','x402_grants',
    'x402_payment_attempts','crypto_order_payment_reservations','crypto_payment_transactions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', name);
  END LOOP;
END;
$$;

-- Preserve already signed attempts when adding the arbitration/transaction registry.
INSERT INTO public.crypto_order_payment_reservations(job_id,path,human_quote_id,status)
SELECT job_id,'human',id,CASE status WHEN 'confirmed' THEN 'confirmed'
  WHEN 'failed' THEN 'failed_proven' ELSE 'pending' END
FROM public.solana_payment_quotes WHERE signature IS NOT NULL;
INSERT INTO public.crypto_payment_transactions(network,signature,job_id,human_quote_id)
SELECT network,signature,job_id,id FROM public.solana_payment_quotes WHERE signature IS NOT NULL;

CREATE FUNCTION public.x402_purchase_snapshot(j public.print_jobs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('version',1,'order',to_jsonb(j) - ARRAY[
    'status','payment_status','payment_method','printer_id','tracking_number','admin_comment',
    'admin_internal_note','admin_attachments','updated_at','deleted_at','coupon_returned_at',
    'special_tag_stock_returned_at'],
    'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) - ARRAY['created_at','updated_at'] ORDER BY i.id)
      FROM public.print_job_items i WHERE i.job_id = j.id),'[]'::jsonb));
$$;

CREATE FUNCTION public.guard_x402_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'x402_payment_quotes' THEN
    RAISE EXCEPTION 'x402_quote_immutable';
  ELSIF TG_TABLE_NAME = 'x402_agents' THEN
    IF to_jsonb(NEW) - 'revoked_at' IS DISTINCT FROM to_jsonb(OLD) - 'revoked_at'
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION 'x402_agent_immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'x402_budgets' THEN
    IF to_jsonb(NEW) - ARRAY['reserved_atomic','spent_atomic'] IS DISTINCT FROM
      to_jsonb(OLD) - ARRAY['reserved_atomic','spent_atomic'] THEN RAISE EXCEPTION 'x402_budget_immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'x402_grants' THEN
    IF to_jsonb(NEW) - ARRAY['status','revoked_at','consumed_at'] IS DISTINCT FROM
      to_jsonb(OLD) - ARRAY['status','revoked_at','consumed_at']
      OR (OLD.status <> 'approved' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'x402_grant_immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'x402_payment_attempts' THEN
    IF ROW(NEW.id,NEW.job_id,NEW.grant_id,NEW.quote_id,NEW.idempotency_key,NEW.amount_atomic,NEW.reserved_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.grant_id,OLD.quote_id,OLD.idempotency_key,OLD.amount_atomic,OLD.reserved_at)
      OR (OLD.payload_fingerprint IS NOT NULL AND
        ROW(NEW.payload_fingerprint,NEW.signed_transaction_base64,NEW.message_hash) IS DISTINCT FROM
        ROW(OLD.payload_fingerprint,OLD.signed_transaction_base64,OLD.message_hash))
      OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature)
      OR (OLD.status IN ('confirmed','failed_proven') AND
        ROW(NEW.status,NEW.receipt,NEW.failure_evidence,NEW.confirmed_at,NEW.failed_at,NEW.provider_response)
          IS DISTINCT FROM ROW(OLD.status,OLD.receipt,OLD.failure_evidence,OLD.confirmed_at,OLD.failed_at,OLD.provider_response)) THEN
      RAISE EXCEPTION 'x402_attempt_immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'crypto_payment_transactions' THEN
    RAISE EXCEPTION 'crypto_transaction_immutable';
  ELSIF TG_TABLE_NAME = 'crypto_order_payment_reservations' THEN
    IF to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status'
      OR (OLD.status <> 'pending' AND NEW.status <> OLD.status) THEN RAISE EXCEPTION 'crypto_reservation_immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['x402_agents','x402_budgets','x402_payment_quotes','x402_grants',
    'x402_payment_attempts','crypto_order_payment_reservations','crypto_payment_transactions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_x402_immutable()',
      name || '_immutable',name);
  END LOOP;
END;
$$;

-- Server-only quote preparation. Addresses, rate provenance, endpoint, sponsor,
-- ATA derivation and wallet proof MUST be verified by the future Edge Function.
CREATE FUNCTION public.create_x402_payment_quote(p_job_id uuid,p_agent_id uuid,
  p_source_token_account text,p_recipient text,p_recipient_token_account text,
  p_rate_snapshot jsonb,p_resource_url text,p_fee_payer text,p_ttl integer DEFAULT 900)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; a public.x402_agents; q public.x402_payment_quotes;
  v_id uuid := gen_random_uuid(); v_snapshot jsonb; v_rate numeric; v_total numeric; v_amount bigint;
BEGIN
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id = p_job_id FOR UPDATE;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = p_agent_id FOR SHARE;
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

CREATE FUNCTION public.create_x402_budget(p_agent_id uuid,p_limit_atomic text,p_ttl integer DEFAULT 3600)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.x402_agents; b public.x402_budgets;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_limit_atomic IS NULL OR p_limit_atomic !~ '^[1-9][0-9]{0,18}$'
    OR p_ttl IS NULL OR p_ttl NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'invalid_x402_budget'; END IF;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = p_agent_id FOR SHARE;
  IF a.revoked_at IS NOT NULL OR a.auth_user_id = auth.uid() THEN RAISE EXCEPTION 'x402_agent_unavailable'; END IF;
  INSERT INTO public.x402_budgets(customer_id,agent_id,limit_atomic,expires_at)
  VALUES(auth.uid(),a.id,p_limit_atomic::bigint,now() + make_interval(secs => p_ttl)) RETURNING * INTO b;
  RETURN to_jsonb(b) || jsonb_build_object('limit_atomic',b.limit_atomic::text,
    'reserved_atomic',b.reserved_atomic::text,'spent_atomic',b.spent_atomic::text);
END;
$$;

CREATE FUNCTION public.approve_x402_grant(p_quote_id uuid,p_budget_id uuid,
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

CREATE FUNCTION public.revoke_x402_grant(p_grant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; g public.x402_grants;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT j0.* INTO STRICT j FROM public.print_jobs j0 JOIN public.x402_grants g0 ON g0.job_id = j0.id
    WHERE g0.id = p_grant_id AND g0.customer_id = auth.uid() FOR UPDATE OF j0;
  SELECT * INTO STRICT g FROM public.x402_grants WHERE id = p_grant_id FOR UPDATE;
  IF g.status = 'approved' THEN
    UPDATE public.x402_grants SET status = 'revoked',revoked_at = now() WHERE id = g.id RETURNING * INTO g;
  END IF;
  RETURN jsonb_build_object('id',g.id,'status',g.status,'revoked_at',g.revoked_at,
    'attempt_exists',EXISTS(SELECT 1 FROM public.x402_payment_attempts WHERE grant_id = g.id),
    'settlement_pending',EXISTS(SELECT 1 FROM public.x402_payment_attempts WHERE grant_id = g.id
      AND status IN ('reserved','settling','pending')));
END;
$$;

-- Safe projection shared by owner/agent reads and reserve replies.
CREATE FUNCTION public.x402_purchase_view(p_grant_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('grant_id',g.id,'order_no',j.job_number,'quote_id',q.id,'agent_id',g.agent_id,
    'payer',q.payer,'source_token_account',q.source_token_account,'recipient',q.recipient,
    'recipient_token_account',q.recipient_token_account,'network',q.network,'mint',q.mint,
    'amount_atomic',q.amount_atomic::text,'cap_atomic',g.cap_atomic::text,'total_thb',q.total_thb::text,
    'rate',q.rate::text,'surcharge_bps',q.surcharge_bps,'snapshot_hash',q.snapshot_hash,
    'resource_url',q.resource_url,'payment_requirements',q.payment_requirements,
    'grant_status',g.status,'expires_at',g.expires_at,'revoked_at',g.revoked_at,
    'attempt',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'status',t.status,
      'idempotency_key',t.idempotency_key,'signature',t.signature,'confirmed_at',t.confirmed_at,'failed_at',t.failed_at) END)
  FROM public.x402_grants g JOIN public.x402_payment_quotes q ON q.id = g.quote_id
    JOIN public.print_jobs j ON j.id = g.job_id JOIN public.x402_agents a ON a.id = g.agent_id
    LEFT JOIN public.x402_payment_attempts t ON t.grant_id = g.id
  WHERE g.id = p_grant_id AND auth.uid() IS NOT NULL
    AND (g.customer_id = auth.uid() OR a.auth_user_id = auth.uid());
$$;

CREATE FUNCTION public.reserve_x402_payment(p_grant_id uuid,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; b public.x402_budgets; g public.x402_grants; a public.x402_agents;
  q public.x402_payment_quotes; t public.x402_payment_attempts;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_idempotency_key'; END IF;
  SELECT j0.* INTO STRICT j FROM public.print_jobs j0 JOIN public.x402_grants g0 ON g0.job_id = j0.id
    JOIN public.x402_agents a0 ON a0.id = g0.agent_id WHERE g0.id = p_grant_id
    AND a0.auth_user_id = auth.uid() FOR UPDATE OF j0;
  SELECT b0.* INTO STRICT b FROM public.x402_budgets b0 JOIN public.x402_grants g0 ON g0.budget_id = b0.id
    WHERE g0.id = p_grant_id FOR UPDATE OF b0;
  SELECT * INTO STRICT g FROM public.x402_grants WHERE id = p_grant_id FOR UPDATE;
  SELECT * INTO STRICT a FROM public.x402_agents WHERE id = g.agent_id FOR SHARE;
  SELECT * INTO STRICT q FROM public.x402_payment_quotes WHERE id = g.quote_id;
  SELECT * INTO t FROM public.x402_payment_attempts WHERE grant_id = g.id FOR UPDATE;
  IF FOUND THEN
    IF t.idempotency_key <> p_idempotency_key THEN RAISE EXCEPTION 'x402_attempt_locked'; END IF;
    -- Existing receipt/status is recoverable after expiry/revocation; no new authorization.
    RETURN public.x402_purchase_view(g.id);
  END IF;
  IF g.status <> 'approved' OR g.expires_at <= now() OR q.expires_at <= now() OR b.expires_at <= now()
    OR a.revoked_at IS NOT NULL OR a.wallet_address <> q.payer OR a.auth_user_id = g.customer_id
    OR b.customer_id <> g.customer_id OR b.agent_id <> g.agent_id OR q.customer_id <> g.customer_id
    OR q.agent_id <> g.agent_id OR q.job_id <> g.job_id OR j.user_id <> g.customer_id
    OR q.amount_atomic > g.cap_atomic OR q.amount_atomic > b.limit_atomic - b.spent_atomic - b.reserved_atomic
    OR j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status IS DISTINCT FROM 'submitted'
    OR j.payment_status = 'paid' OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
    OR public.x402_purchase_snapshot(j) IS DISTINCT FROM q.purchase_snapshot
    OR EXISTS (SELECT 1 FROM public.solana_payment_quotes WHERE job_id = j.id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE order_no = j.job_number) THEN RAISE EXCEPTION 'x402_grant_not_payable'; END IF;
  PERFORM public.assert_creator_crypto_eligible(j.id,true);
  INSERT INTO public.x402_payment_attempts(job_id,grant_id,quote_id,idempotency_key,amount_atomic)
    VALUES(j.id,g.id,q.id,p_idempotency_key,q.amount_atomic) RETURNING * INTO t;
  INSERT INTO public.crypto_order_payment_reservations(job_id,path,x402_attempt_id,status)
    VALUES(j.id,'x402',t.id,'pending');
  UPDATE public.x402_budgets SET reserved_atomic = reserved_atomic + q.amount_atomic WHERE id = b.id;
  RETURN public.x402_purchase_view(g.id);
END;
$$;

-- Only the future verified server adapter may advance settlement. JSON receipt
-- evidence is a server assertion, not an on-chain proof checked by PostgreSQL.
CREATE FUNCTION public.update_x402_payment_attempt(p_attempt_id uuid,p_action text,p_data jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; b public.x402_budgets; g public.x402_grants; q public.x402_payment_quotes;
  a public.x402_agents; t public.x402_payment_attempts; v_hash text; v_signature text;
BEGIN
  SELECT j0.* INTO STRICT j FROM public.print_jobs j0 JOIN public.x402_payment_attempts t0 ON t0.job_id = j0.id
    WHERE t0.id = p_attempt_id FOR UPDATE OF j0;
  SELECT b0.* INTO STRICT b FROM public.x402_budgets b0 JOIN public.x402_grants g0 ON g0.budget_id = b0.id
    JOIN public.x402_payment_attempts t0 ON t0.grant_id = g0.id WHERE t0.id = p_attempt_id FOR UPDATE OF b0;
  SELECT g0.* INTO STRICT g FROM public.x402_grants g0 JOIN public.x402_payment_attempts t0 ON t0.grant_id = g0.id
    WHERE t0.id = p_attempt_id FOR UPDATE OF g0;
  SELECT * INTO STRICT t FROM public.x402_payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  SELECT * INTO STRICT q FROM public.x402_payment_quotes WHERE id = t.quote_id;
  IF p_action IS NULL OR p_action NOT IN ('begin_settlement','pending','confirm','fail_not_broadcast','fail_finalized')
    OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'invalid_x402_action'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations
    WHERE job_id = j.id AND x402_attempt_id = t.id AND path = 'x402') THEN RAISE EXCEPTION 'x402_attempt_locked'; END IF;
  IF p_action = 'begin_settlement' THEN
    IF p_data->>'signed_transaction' IS NULL OR length(p_data->>'signed_transaction') NOT BETWEEN 1 AND 12000
      OR p_data->>'message_hash' IS NULL OR p_data->>'message_hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_x402_payload'; END IF;
    IF octet_length(decode(p_data->>'signed_transaction','base64')) = 0 THEN RAISE EXCEPTION 'invalid_x402_payload'; END IF;
    v_hash := encode(sha256(decode(p_data->>'signed_transaction','base64')),'hex');
    IF t.payload_fingerprint IS NOT NULL THEN
      IF t.payload_fingerprint <> v_hash OR t.message_hash <> p_data->>'message_hash' THEN RAISE EXCEPTION 'x402_payload_mismatch'; END IF;
      RETURN to_jsonb(t) || jsonb_build_object('amount_atomic',t.amount_atomic::text);
    END IF;
    SELECT * INTO STRICT a FROM public.x402_agents WHERE id = g.agent_id FOR SHARE;
    IF t.status <> 'reserved' OR g.status <> 'approved' OR g.expires_at <= now() OR q.expires_at <= now()
      OR b.expires_at <= now() OR a.revoked_at IS NOT NULL
      OR j.status IS DISTINCT FROM 'submitted' OR j.payment_status = 'paid' OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
      OR public.x402_purchase_snapshot(j) IS DISTINCT FROM q.purchase_snapshot THEN RAISE EXCEPTION 'x402_grant_not_payable'; END IF;
    UPDATE public.x402_payment_attempts SET status = 'settling',payload_fingerprint = v_hash,
      signed_transaction_base64 = p_data->>'signed_transaction',message_hash = p_data->>'message_hash',
      settlement_started_at = now() WHERE id = t.id RETURNING * INTO t;
  ELSIF p_action IN ('pending','confirm') THEN
    v_signature := p_data->>'signature';
    IF v_signature IS NULL OR v_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
      OR t.status NOT IN ('settling','pending','confirmed')
      OR (t.signature IS NOT NULL AND t.signature <> v_signature) THEN RAISE EXCEPTION 'x402_settlement_invalid'; END IF;
    IF t.status = 'confirmed' THEN
      RETURN to_jsonb(t) || jsonb_build_object('amount_atomic',t.amount_atomic::text);
    END IF;
    IF t.signature IS NULL THEN
      INSERT INTO public.crypto_payment_transactions(network,signature,job_id,x402_attempt_id)
        VALUES(q.network,v_signature,j.id,t.id);
    END IF;
    IF p_action = 'pending' THEN
      UPDATE public.x402_payment_attempts SET status = 'pending',signature = v_signature,
        provider_response = p_data->'provider_response' WHERE id = t.id RETURNING * INTO t;
    ELSE
      -- Identity from immutable quote, not facilitator payer/fee-payer attribution.
      IF (p_data->'receipt'->>'commitment') IS DISTINCT FROM 'finalized'
        OR (p_data->'receipt'->>'network') IS DISTINCT FROM q.network
        OR (p_data->'receipt'->>'signature') IS DISTINCT FROM v_signature
        OR (p_data->'receipt'->>'payer') IS DISTINCT FROM q.payer
        OR (p_data->'receipt'->>'source') IS DISTINCT FROM q.source_token_account
        OR (p_data->'receipt'->>'destination') IS DISTINCT FROM q.recipient_token_account
        OR (p_data->'receipt'->>'recipient') IS DISTINCT FROM q.recipient
        OR (p_data->'receipt'->>'mint') IS DISTINCT FROM q.mint
        OR (p_data->'receipt'->>'amount_atomic') IS DISTINCT FROM q.amount_atomic::text
        OR (p_data->'receipt'->>'memo') IS DISTINCT FROM ('printkub-x402:' || q.id::text)
        OR NOT (p_data->'receipt' ? 'error') OR (p_data->'receipt'->'error') IS DISTINCT FROM 'null'::jsonb
        OR j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status IS NULL OR j.status IN ('draft','cancelled','refund')
        OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
        OR public.x402_purchase_snapshot(j) IS DISTINCT FROM q.purchase_snapshot THEN RAISE EXCEPTION 'x402_receipt_invalid'; END IF;
      UPDATE public.x402_payment_attempts SET status = 'confirmed',signature = v_signature,receipt = p_data->'receipt',
        provider_response = p_data->'provider_response',confirmed_at = now() WHERE id = t.id RETURNING * INTO t;
      UPDATE public.x402_budgets SET reserved_atomic = reserved_atomic - t.amount_atomic,
        spent_atomic = spent_atomic + t.amount_atomic WHERE id = b.id;
      IF g.status = 'approved' THEN
        UPDATE public.x402_grants SET status = 'consumed',consumed_at = now() WHERE id = g.id;
      END IF;
      UPDATE public.crypto_order_payment_reservations SET status = 'confirmed' WHERE job_id = j.id;
      UPDATE public.print_jobs SET payment_status = 'paid',payment_method = 'usdc',
        status = CASE WHEN status = 'submitted' THEN 'processing' ELSE status END WHERE id = j.id;
    END IF;
  ELSE
    IF t.status = 'failed_proven' THEN RETURN to_jsonb(t) || jsonb_build_object('amount_atomic',t.amount_atomic::text); END IF;
    IF p_action = 'fail_not_broadcast' THEN
      -- Only reserved attempts have never crossed the durable before-network boundary.
      IF t.status <> 'reserved' OR t.payload_fingerprint IS NOT NULL OR t.signature IS NOT NULL
        OR (p_data->'evidence'->>'reason') IS DISTINCT FROM 'not_broadcast' THEN RAISE EXCEPTION 'x402_failure_unproven'; END IF;
    ELSE
      IF t.status NOT IN ('settling','pending') OR t.signature IS NULL
        OR (p_data->'evidence'->>'commitment') IS DISTINCT FROM 'finalized'
        OR (p_data->'evidence'->>'signature') IS DISTINCT FROM t.signature
        OR (p_data->'evidence'->>'network') IS DISTINCT FROM q.network
        OR p_data->'evidence'->'error' IS NULL OR p_data->'evidence'->'error' = 'null'::jsonb THEN
        RAISE EXCEPTION 'x402_failure_unproven';
      END IF;
    END IF;
    UPDATE public.x402_payment_attempts SET status = 'failed_proven',failure_evidence = p_data->'evidence',
      failed_at = now() WHERE id = t.id RETURNING * INTO t;
    UPDATE public.x402_budgets SET reserved_atomic = reserved_atomic - t.amount_atomic WHERE id = b.id;
    IF g.status = 'approved' THEN UPDATE public.x402_grants SET status = 'revoked',revoked_at = now() WHERE id = g.id; END IF;
    UPDATE public.crypto_order_payment_reservations SET status = 'failed_proven' WHERE job_id = j.id;
    UPDATE public.print_jobs SET payment_status = 'failed' WHERE id = j.id AND payment_status <> 'paid';
  END IF;
  RETURN to_jsonb(t) || jsonb_build_object('amount_atomic',t.amount_atomic::text);
END;
$$;

-- Recovery leasing cannot clear reservations or initiate new payment authority.
CREATE FUNCTION public.claim_x402_recovery(p_attempt_id uuid,p_lease_seconds integer DEFAULT 300)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.x402_payment_attempts;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'invalid_recovery_lease'; END IF;
  UPDATE public.x402_payment_attempts SET recovery_claim_id = gen_random_uuid(),recovery_claimed_at = now(),
    recovery_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    WHERE id = p_attempt_id AND status IN ('reserved','settling','pending')
    AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= now())
    RETURNING * INTO t;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(t) || jsonb_build_object('amount_atomic',t.amount_atomic::text);
END;
$$;
CREATE FUNCTION public.release_x402_recovery(p_attempt_id uuid,p_claim_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.x402_payment_attempts SET recovery_claim_id = NULL,recovery_claimed_at = NULL,recovery_lease_expires_at = NULL,recovery_checked_at = now()
    WHERE id = p_attempt_id AND recovery_claim_id = p_claim_id;
  RETURN FOUND;
END;
$$;

-- Preserve the original human quote/transaction implementation behind wrappers.
ALTER FUNCTION public.create_solana_payment_quote(uuid,text,text,text,jsonb,integer)
  RENAME TO create_solana_payment_quote_before_x402;
REVOKE ALL ON FUNCTION public.create_solana_payment_quote_before_x402(uuid,text,text,text,jsonb,integer)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_solana_payment_quote(p_job_id uuid,p_payer text,p_recipient text,
  p_recipient_token_account text,p_rate_snapshot jsonb,p_ttl integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.print_jobs WHERE id = p_job_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.x402_grants WHERE job_id = p_job_id AND status = 'approved' AND expires_at > now())
    OR EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = p_job_id AND path = 'x402') THEN
    RAISE EXCEPTION 'crypto_attempt_locked';
  END IF;
  RETURN public.create_solana_payment_quote_before_x402(p_job_id,p_payer,p_recipient,p_recipient_token_account,p_rate_snapshot,p_ttl);
END;
$$;

ALTER FUNCTION public.update_solana_payment_attempt(uuid,text,jsonb) RENAME TO update_solana_payment_attempt_before_x402;
REVOKE ALL ON FUNCTION public.update_solana_payment_attempt_before_x402(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.update_solana_payment_attempt(p_quote_id uuid,p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE q public.solana_payment_quotes; r public.crypto_order_payment_reservations; v_result jsonb;
BEGIN
  PERFORM j.id FROM public.print_jobs j JOIN public.solana_payment_quotes q0 ON q0.job_id = j.id
    WHERE q0.id = p_quote_id FOR UPDATE OF j;
  SELECT * INTO STRICT q FROM public.solana_payment_quotes WHERE id = p_quote_id FOR UPDATE;
  SELECT * INTO r FROM public.crypto_order_payment_reservations WHERE job_id = q.job_id;
  IF FOUND AND r.human_quote_id IS DISTINCT FROM q.id THEN RAISE EXCEPTION 'crypto_attempt_locked'; END IF;
  IF p_action = 'submit' THEN
    IF NOT EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = q.job_id) THEN
      INSERT INTO public.crypto_order_payment_reservations(job_id,path,human_quote_id,status)
        VALUES(q.job_id,'human',q.id,'pending');
    END IF;
    IF q.signature IS NULL THEN
      INSERT INTO public.crypto_payment_transactions(network,signature,job_id,human_quote_id)
        VALUES(q.network,p_data->>'signature',q.job_id,q.id);
    END IF;
  END IF;
  -- The original RPC validates messages, expiry, state and signature equality.
  -- Its rejection rolls back registry and reservation writes in this transaction.
  v_result := public.update_solana_payment_attempt_before_x402(p_quote_id,p_action,p_data);
  IF v_result->>'status' IN ('confirmed','failed') THEN
    UPDATE public.crypto_order_payment_reservations SET status = CASE v_result->>'status'
      WHEN 'confirmed' THEN 'confirmed' ELSE 'failed_proven' END WHERE job_id = q.job_id;
  END IF;
  RETURN v_result;
END;
$$;

-- Freeze the approval's business snapshot while active or once an attempt has
-- acquired authority. Admin progress/tracking/notes remain outside the snapshot.
CREATE FUNCTION public.x402_purchase_locked(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.x402_grants WHERE job_id = p_job_id
    AND status = 'approved' AND expires_at > now())
    OR EXISTS (SELECT 1 FROM public.x402_payment_attempts WHERE job_id = p_job_id
      AND status IN ('reserved','settling','pending','confirmed'));
$$;
CREATE FUNCTION public.guard_x402_order_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.x402_purchase_locked(OLD.id) AND
    public.x402_purchase_snapshot(NEW) IS DISTINCT FROM public.x402_purchase_snapshot(OLD) THEN
    RAISE EXCEPTION 'x402_purchase_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER print_jobs_guard_x402_snapshot BEFORE UPDATE ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_x402_order_snapshot();
CREATE FUNCTION public.guard_x402_item_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old uuid; v_new uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := OLD.job_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := NEW.job_id; END IF;
  -- Moving an item protects both orders; parent locks serialize with approval.
  PERFORM id FROM public.print_jobs WHERE id IN (v_old,v_new) ORDER BY id FOR UPDATE;
  IF public.x402_purchase_locked(v_old) OR public.x402_purchase_locked(v_new) THEN RAISE EXCEPTION 'x402_purchase_immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER print_job_items_guard_x402_snapshot BEFORE INSERT OR UPDATE OR DELETE ON public.print_job_items
FOR EACH ROW EXECUTE FUNCTION public.guard_x402_item_snapshot();

-- Extend finality and cancellation guards to both payment paths.
CREATE OR REPLACE FUNCTION public.guard_crypto_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.checkout_payment_provider IS NOT NULL THEN RAISE EXCEPTION 'checkout_provider_required'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.checkout_payment_provider IS NOT NULL AND NEW.checkout_payment_provider IS DISTINCT FROM OLD.checkout_payment_provider THEN
    RAISE EXCEPTION 'payment_provider_immutable';
  END IF;
  IF OLD.checkout_payment_provider IS NULL AND NEW.checkout_payment_provider IS NOT NULL
    AND auth.role() IS DISTINCT FROM 'service_role'
    AND current_setting('printkub.checkout_gateway', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'checkout_provider_required';
  END IF;
  IF NEW.checkout_payment_provider = 'crypto' THEN
    PERFORM public.assert_creator_crypto_eligible(NEW.id, true);
    IF ROW(NEW.user_id,NEW.total_price,NEW.shipping_cost,NEW.discount_amount) IS DISTINCT FROM
      ROW(OLD.user_id,OLD.total_price,OLD.shipping_cost,OLD.discount_amount) THEN
      RAISE EXCEPTION 'crypto_order_immutable';
    END IF;
    IF OLD.status IN ('cancelled','refund') AND NEW.status NOT IN ('cancelled','refund') THEN
      RAISE EXCEPTION 'crypto_order_terminal';
    END IF;
    IF (NEW.status IN ('cancelled','refund') OR NEW.deleted_at IS NOT NULL) AND EXISTS (
      SELECT 1 FROM public.solana_payment_quotes WHERE job_id = NEW.id AND status = 'submitted'
    ) THEN RAISE EXCEPTION 'crypto_payment_unresolved'; END IF;
    IF (NEW.status IN ('cancelled','refund') OR NEW.deleted_at IS NOT NULL) AND EXISTS (
      SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id = NEW.id AND status = 'pending'
    ) THEN RAISE EXCEPTION 'crypto_payment_unresolved'; END IF;
    IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' AND NOT EXISTS (
      SELECT 1 FROM public.solana_payment_quotes WHERE job_id = NEW.id AND status = 'confirmed'
    ) AND NOT EXISTS (
      SELECT 1 FROM public.x402_payment_attempts t
      JOIN public.crypto_order_payment_reservations r ON r.x402_attempt_id = t.id AND r.job_id = NEW.id
      WHERE t.job_id = NEW.id AND t.status = 'confirmed' AND r.status = 'confirmed'
    ) THEN RAISE EXCEPTION 'crypto_settlement_required'; END IF;
    IF NEW.payment_status = 'paid' THEN NEW.payment_method := 'usdc'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Explicit function ACLs: no anonymous/default-PUBLIC execution. Helper and
-- legacy functions are callable only by the SECURITY DEFINER function owner.
REVOKE ALL ON FUNCTION public.x402_purchase_snapshot(public.print_jobs),
  public.guard_x402_immutable(),public.x402_purchase_locked(uuid),
  public.guard_x402_order_snapshot(),public.guard_x402_item_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_x402_budget(uuid,text,integer),
  public.approve_x402_grant(uuid,uuid,text,integer),public.revoke_x402_grant(uuid),
  public.x402_purchase_view(uuid),public.reserve_x402_payment(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_x402_budget(uuid,text,integer),
  public.approve_x402_grant(uuid,uuid,text,integer),public.revoke_x402_grant(uuid),
  public.x402_purchase_view(uuid),public.reserve_x402_payment(uuid,text) TO authenticated;

REVOKE ALL ON FUNCTION public.create_x402_payment_quote(uuid,uuid,text,text,text,jsonb,text,text,integer),
  public.update_x402_payment_attempt(uuid,text,jsonb),public.claim_x402_recovery(uuid,integer),
  public.release_x402_recovery(uuid,uuid),public.create_solana_payment_quote(uuid,text,text,text,jsonb,integer),
  public.update_solana_payment_attempt(uuid,text,jsonb),public.guard_crypto_order()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_x402_payment_quote(uuid,uuid,text,text,text,jsonb,text,text,integer),
  public.update_x402_payment_attempt(uuid,text,jsonb),public.claim_x402_recovery(uuid,integer),
  public.release_x402_recovery(uuid,uuid),public.create_solana_payment_quote(uuid,text,text,text,jsonb,integer),
  public.update_solana_payment_attempt(uuid,text,jsonb) TO service_role;
COMMIT;
