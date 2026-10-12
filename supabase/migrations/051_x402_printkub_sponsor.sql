-- Backend-only PrintKub sponsor. Limits are lifetime allocations, never reset
-- by a new policy, an expired blockhash, a failed payment or redeployment.
BEGIN;
ALTER TABLE public.x402_purchase_policies ADD COLUMN printkub_funded boolean NOT NULL DEFAULT false;
CREATE TABLE public.x402_sponsor_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  wallet_address text NOT NULL CHECK (wallet_address = 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'),
  enabled boolean NOT NULL DEFAULT false,
  usdc_limit_atomic bigint NOT NULL DEFAULT 100000000 CHECK (usdc_limit_atomic BETWEEN 0 AND 100000000),
  allocated_atomic bigint NOT NULL DEFAULT 0 CHECK (allocated_atomic BETWEEN 0 AND usdc_limit_atomic),
  fee_limit_lamports bigint NOT NULL DEFAULT 10000000 CHECK (fee_limit_lamports BETWEEN 0 AND 10000000),
  allocated_fee_lamports bigint NOT NULL DEFAULT 0 CHECK (allocated_fee_lamports BETWEEN 0 AND fee_limit_lamports)
);
INSERT INTO public.x402_sponsor_budget(wallet_address) VALUES ('GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR');
CREATE TABLE public.x402_sponsor_payments (
  attempt_id uuid PRIMARY KEY REFERENCES public.x402_payment_attempts(id),
  signed_transaction_base64 text NOT NULL CHECK (length(signed_transaction_base64) BETWEEN 1 AND 1644),
  signature text NOT NULL UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  funded_atomic bigint NOT NULL CHECK (funded_atomic >= 0),
  fee_lamports bigint NOT NULL DEFAULT 12000 CHECK (fee_lamports = 12000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.x402_sponsor_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_sponsor_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_sponsor_budget, public.x402_sponsor_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.x402_sponsor_budget, public.x402_sponsor_payments TO service_role;

CREATE FUNCTION public.guard_x402_sponsor_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_TABLE_NAME = 'x402_sponsor_payments' THEN
    RAISE EXCEPTION 'x402_sponsor_ledger_immutable';
  END IF;
  IF NEW.wallet_address IS DISTINCT FROM OLD.wallet_address OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.allocated_atomic < OLD.allocated_atomic OR NEW.allocated_fee_lamports < OLD.allocated_fee_lamports
    THEN RAISE EXCEPTION 'x402_sponsor_ledger_immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER x402_sponsor_budget_guard BEFORE UPDATE OR DELETE ON public.x402_sponsor_budget
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_sponsor_ledger();
CREATE TRIGGER x402_sponsor_payments_guard BEFORE UPDATE OR DELETE ON public.x402_sponsor_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_sponsor_ledger();
REVOKE ALL ON FUNCTION public.guard_x402_sponsor_ledger() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text)
  RENAME TO create_my_x402_policy_before_sponsor;
REVOKE ALL ON FUNCTION public.create_my_x402_policy_before_sponsor(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_my_x402_policy(p_agent_id uuid,p_options jsonb,p_delivery jsonb,
  p_recipient text,p_max_order_atomic text,p_budget_atomic text,p_max_orders integer,
  p_expires_at timestamptz,p_consent_version text,p_printkub_funded boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_printkub_funded IS NULL THEN RAISE EXCEPTION 'invalid_purchase_policy'; END IF;
  IF p_printkub_funded THEN
    PERFORM id FROM public.x402_sponsor_budget WHERE enabled FOR SHARE;
    IF NOT FOUND OR p_recipient = 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'
      THEN RAISE EXCEPTION 'x402_sponsor_unavailable'; END IF;
  END IF;
  v_id := public.create_my_x402_policy_before_sponsor(p_agent_id,p_options,p_delivery,p_recipient,
    p_max_order_atomic,p_budget_atomic,p_max_orders,p_expires_at,p_consent_version);
  UPDATE public.x402_purchase_policies SET printkub_funded=p_printkub_funded WHERE id=v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text,boolean) TO authenticated;

-- Add funding requirements before the quote becomes immutable. Funding is
-- derived from the saved owner policy, never from agent-controlled requests.
CREATE FUNCTION public.set_x402_sponsor_requirements() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE funded boolean;
BEGIN
  IF NEW.rate_snapshot->'facilitator'->>'mode' = 'printkub' THEN
    IF NEW.payment_requirements->'extra'->>'feePayer' IS DISTINCT FROM 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'
      THEN RAISE EXCEPTION 'invalid_x402_quote'; END IF;
    SELECT p.printkub_funded INTO funded FROM public.x402_delegated_purchases d
      JOIN public.x402_purchase_policies p ON p.id=d.policy_id
      WHERE d.job_id=NEW.job_id AND p.agent_id=NEW.agent_id AND p.customer_id=NEW.customer_id;
    funded := COALESCE(funded,false);
    IF funded AND (NEW.recipient = NEW.payment_requirements->'extra'->>'feePayer'
      OR NEW.rate_snapshot->'facilitator'->>'fundingSource' IS NULL)
      THEN RAISE EXCEPTION 'invalid_x402_quote'; END IF;
    NEW.payment_requirements := jsonb_set(NEW.payment_requirements,'{extra}',
      (NEW.payment_requirements->'extra') || jsonb_build_object('sponsorMode','printkub',
        'fundingMode',CASE WHEN funded THEN 'printkub' ELSE 'agent' END) ||
      CASE WHEN funded THEN jsonb_build_object('fundingSource',NEW.rate_snapshot->'facilitator'->>'fundingSource') ELSE '{}'::jsonb END);
  ELSE
    IF EXISTS (SELECT 1 FROM public.x402_delegated_purchases d JOIN public.x402_purchase_policies p ON p.id=d.policy_id
      WHERE d.job_id=NEW.job_id AND p.printkub_funded) THEN RAISE EXCEPTION 'x402_sponsor_unavailable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER x402_quote_sponsor_requirements BEFORE INSERT ON public.x402_payment_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_x402_sponsor_requirements();
REVOKE ALL ON FUNCTION public.set_x402_sponsor_requirements() FROM PUBLIC, anon, authenticated, service_role;

-- One atomic boundary: existing order/consent reservation, shared allowance,
-- immutable fully signed bytes and transaction identity, before any broadcast.
CREATE FUNCTION public.claim_x402_printkub_settlement(p_attempt_id uuid,p_partial text,p_message_hash text,
  p_signed text,p_signature text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.x402_payment_attempts; q public.x402_payment_quotes;
  b public.x402_sponsor_budget; saved public.x402_sponsor_payments; debit bigint; claimed jsonb;
BEGIN
  PERFORM j.id FROM public.print_jobs j JOIN public.x402_payment_attempts a ON a.job_id=j.id
    WHERE a.id=p_attempt_id FOR UPDATE OF j;
  SELECT * INTO STRICT t FROM public.x402_payment_attempts WHERE id=p_attempt_id;
  SELECT * INTO STRICT q FROM public.x402_payment_quotes WHERE id=t.quote_id;
  IF q.payment_requirements->'extra'->>'sponsorMode' IS DISTINCT FROM 'printkub'
    OR q.payment_requirements->'extra'->>'feePayer' IS DISTINCT FROM 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'
    THEN RAISE EXCEPTION 'x402_sponsor_unavailable'; END IF;
  SELECT * INTO saved FROM public.x402_sponsor_payments WHERE attempt_id=t.id;
  IF FOUND THEN
    IF t.signed_transaction_base64 IS DISTINCT FROM p_partial OR t.message_hash IS DISTINCT FROM p_message_hash
      THEN RAISE EXCEPTION 'x402_payload_mismatch'; END IF;
    RETURN jsonb_build_object('dispatch',false,'transaction',saved.signed_transaction_base64,'signature',saved.signature);
  END IF;
  SELECT * INTO STRICT b FROM public.x402_sponsor_budget WHERE id FOR UPDATE;
  IF NOT b.enabled THEN RAISE EXCEPTION 'x402_sponsor_unavailable'; END IF;
  debit := CASE WHEN q.payment_requirements->'extra'->>'fundingMode'='printkub' THEN q.amount_atomic ELSE 0 END;
  IF debit > b.usdc_limit_atomic-b.allocated_atomic OR 12000 > b.fee_limit_lamports-b.allocated_fee_lamports
    THEN RAISE EXCEPTION 'x402_sponsor_budget_exhausted'; END IF;
  IF p_signed IS NULL OR length(p_signed) NOT BETWEEN 1 AND 1644
    OR p_signature IS NULL OR p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
    THEN RAISE EXCEPTION 'x402_transaction_invalid'; END IF;
  claimed := public.claim_x402_settlement(t.id,p_partial,p_message_hash);
  IF (claimed->>'dispatch')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'x402_attempt_locked'; END IF;
  INSERT INTO public.x402_sponsor_payments(attempt_id,signed_transaction_base64,signature,funded_atomic)
    VALUES(t.id,p_signed,p_signature,debit);
  UPDATE public.x402_sponsor_budget SET allocated_atomic=allocated_atomic+debit,
    allocated_fee_lamports=allocated_fee_lamports+12000 WHERE id;
  RETURN jsonb_build_object('dispatch',true,'transaction',p_signed,'signature',p_signature);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_x402_printkub_settlement(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_x402_printkub_settlement(uuid,text,text,text,text) TO service_role;
COMMIT;
