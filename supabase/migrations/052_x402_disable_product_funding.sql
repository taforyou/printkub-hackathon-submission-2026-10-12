-- One customer payment method: agent USDC, separately sponsored SOL fees.
-- Keep 051 and signed historical transactions intact for reconciliation.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_my_x402_policy(p_agent_id uuid,p_options jsonb,p_delivery jsonb,
  p_recipient text,p_max_order_atomic text,p_budget_atomic text,p_max_orders integer,
  p_expires_at timestamptz,p_consent_version text,p_printkub_funded boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_printkub_funded IS NULL THEN RAISE EXCEPTION 'invalid_purchase_policy'; END IF;
  IF p_printkub_funded THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
  -- Archived treasury option is intentionally not called. The existing helper
  -- still enforces auth.uid(), ownership, saved delivery and bounded consent.
  RETURN public.create_my_x402_policy_before_sponsor(p_agent_id,p_options,p_delivery,p_recipient,
    p_max_order_atomic,p_budget_atomic,p_max_orders,p_expires_at,p_consent_version);
END;
$$;
REVOKE ALL ON FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_my_x402_policy(uuid,jsonb,jsonb,text,text,text,integer,timestamptz,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_x402_sponsor_requirements() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.x402_delegated_purchases d JOIN public.x402_purchase_policies p ON p.id=d.policy_id
    WHERE d.job_id=NEW.job_id AND p.printkub_funded) THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
  IF NEW.rate_snapshot->'facilitator'->>'mode' = 'printkub' THEN
    IF NEW.payment_requirements->'extra'->>'feePayer' IS DISTINCT FROM 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'
      THEN RAISE EXCEPTION 'invalid_x402_quote'; END IF;
    NEW.payment_requirements := jsonb_set(NEW.payment_requirements,'{extra}',
      ((NEW.payment_requirements->'extra') - 'fundingSource') ||
      jsonb_build_object('sponsorMode','printkub','fundingMode','agent'));
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_x402_agent_funding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE funded boolean;
BEGIN
  IF TG_TABLE_NAME = 'x402_purchase_policies' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.printkub_funded THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
    ELSIF NEW.printkub_funded IS DISTINCT FROM OLD.printkub_funded THEN
      -- Changing the payer requires fresh customer consent, not an in-place edit.
      RAISE EXCEPTION 'printkub_funding_disabled';
    END IF;
  ELSIF TG_TABLE_NAME = 'x402_delegated_purchases' THEN
    SELECT p.printkub_funded INTO funded FROM public.x402_purchase_policies p WHERE p.id=NEW.policy_id;
    IF funded THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
  ELSIF TG_TABLE_NAME IN ('x402_grants','x402_payment_attempts') THEN
    IF TG_TABLE_NAME = 'x402_payment_attempts' AND TG_OP = 'UPDATE' THEN
      -- Already persisted proofs remain recoverable, including status changes
      -- after expiry/revocation. Only the first signing boundary is blocked.
      IF OLD.payload_fingerprint IS NOT NULL OR NEW.payload_fingerprint IS NULL THEN RETURN NEW; END IF;
    END IF;
    SELECT q.payment_requirements->'extra'->>'fundingMode' = 'printkub' INTO funded
      FROM public.x402_payment_quotes q WHERE q.id=NEW.quote_id;
    IF funded THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
  ELSIF TG_TABLE_NAME = 'x402_sponsor_payments' THEN
    IF NEW.funded_atomic > 0 THEN RAISE EXCEPTION 'printkub_funding_disabled'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER x402_policies_agent_funding BEFORE INSERT OR UPDATE ON public.x402_purchase_policies
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_agent_funding();
CREATE TRIGGER x402_delegated_agent_funding BEFORE INSERT ON public.x402_delegated_purchases
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_agent_funding();
CREATE TRIGGER x402_grants_agent_funding BEFORE INSERT ON public.x402_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_agent_funding();
CREATE TRIGGER x402_attempts_agent_funding BEFORE INSERT OR UPDATE ON public.x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_agent_funding();
CREATE TRIGGER x402_sponsor_agent_funding BEFORE INSERT ON public.x402_sponsor_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_agent_funding();
REVOKE ALL ON FUNCTION public.guard_x402_agent_funding(),public.set_x402_sponsor_requirements()
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
