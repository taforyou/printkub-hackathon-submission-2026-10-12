-- Local protocol adapter support. No flags are enabled and no funds are sent.
BEGIN;

-- Lock in the same order as 042 (order before budget/grant/attempt). Exactly one
-- caller gets dispatch=true. A crash after this boundary remains uncertain;
-- neither a retry nor a lease expiry can authorize a second /settle request.
CREATE FUNCTION public.claim_x402_settlement(p_attempt_id uuid,p_signed_transaction text,p_message_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.x402_payment_attempts; result jsonb; dispatch boolean;
BEGIN
  PERFORM j.id FROM public.print_jobs j JOIN public.x402_payment_attempts a ON a.job_id = j.id
    WHERE a.id = p_attempt_id FOR UPDATE OF j;
  SELECT * INTO STRICT t FROM public.x402_payment_attempts WHERE id = p_attempt_id;
  dispatch := t.status = 'reserved';
  result := public.update_x402_payment_attempt(p_attempt_id,'begin_settlement',
    jsonb_build_object('signed_transaction',p_signed_transaction,'message_hash',p_message_hash));
  RETURN jsonb_build_object('dispatch',dispatch,'attempt',result);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_x402_settlement(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_x402_settlement(uuid,text,text) TO service_role;

-- Retain a facilitator tx-id hint immediately, without making an uncorrelated
-- provider response the immutable on-chain identity. Finalized matching proof
-- must be checked before update_x402_payment_attempt registers the signature.
CREATE FUNCTION public.record_x402_provider_response(p_attempt_id uuid,p_response jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_response) IS DISTINCT FROM 'object'
    OR (p_response->>'network') IS DISTINCT FROM 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    OR p_response->>'transaction' IS NULL OR p_response->>'transaction' !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
    OR jsonb_typeof(p_response->'success') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'x402_settlement_invalid'; END IF;
  UPDATE public.x402_payment_attempts SET provider_response = jsonb_build_object(
    'success',p_response->'success','network',p_response->>'network','transaction',p_response->>'transaction')
    WHERE id = p_attempt_id AND status = 'settling' AND provider_response IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.record_x402_provider_response(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_x402_provider_response(uuid,jsonb) TO service_role;

-- Reuse a still-current unused quote under the order lock; concurrent preview
-- requests must not proliferate quotes or replace a customer's approval.
CREATE FUNCTION public.prepare_x402_payment_quote(p_job_id uuid,p_agent_id uuid,
  p_source_token_account text,p_recipient text,p_recipient_token_account text,
  p_rate_snapshot jsonb,p_resource_url text,p_fee_payer text,p_ttl integer DEFAULT 900)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; q public.x402_payment_quotes;
BEGIN
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id = p_job_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.x402_grants WHERE job_id = j.id AND status = 'approved' AND expires_at > now()) THEN
    RAISE EXCEPTION 'x402_grant_not_approvable';
  END IF;
  SELECT * INTO q FROM public.x402_payment_quotes q0 WHERE q0.job_id = j.id AND q0.agent_id = p_agent_id
    AND q0.expires_at > now() AND q0.purchase_snapshot = public.x402_purchase_snapshot(j)
    AND q0.resource_url = p_resource_url AND q0.recipient = p_recipient
    AND q0.source_token_account = p_source_token_account AND q0.recipient_token_account = p_recipient_token_account
    AND q0.payment_requirements->'extra'->>'feePayer' = p_fee_payer
    AND NOT EXISTS(SELECT 1 FROM public.x402_grants g WHERE g.quote_id = q0.id)
    ORDER BY q0.created_at DESC LIMIT 1;
  IF FOUND THEN RETURN to_jsonb(q) || jsonb_build_object('amount_atomic',q.amount_atomic::text,'total_thb',q.total_thb::text,'rate',q.rate::text); END IF;
  RETURN public.create_x402_payment_quote(p_job_id,p_agent_id,p_source_token_account,p_recipient,
    p_recipient_token_account,p_rate_snapshot,p_resource_url,p_fee_payer,p_ttl);
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_x402_payment_quote(uuid,uuid,text,text,text,jsonb,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_x402_payment_quote(uuid,uuid,text,text,text,jsonb,text,text,integer) TO service_role;
COMMIT;
