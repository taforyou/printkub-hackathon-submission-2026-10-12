-- Local recovery support only. Owner configures the authenticated schedule.
BEGIN;
ALTER TABLE public.x402_payment_attempts
  ADD COLUMN recovery_scan_before text CHECK (recovery_scan_before ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  ADD COLUMN recovery_scan_cycles integer NOT NULL DEFAULT 0 CHECK (recovery_scan_cycles >= 0),
  ADD COLUMN recovery_last_reason text CHECK (recovery_last_reason IN ('pending','rpc_unavailable','notification_pending'));
CREATE INDEX x402_notification_recovery ON public.x402_payment_attempts(recovery_checked_at)
  WHERE status = 'confirmed' AND email_sent_at IS NULL;

-- Service projection for recovery: no customer contact/snapshot or credentials.
CREATE FUNCTION public.x402_recovery_purchase(p_attempt_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('grant_id',g.id,'quote_id',q.id,'order_no',j.job_number,
    'payer',q.payer,'source_token_account',q.source_token_account,'recipient',q.recipient,
    'recipient_token_account',q.recipient_token_account,'network',q.network,'mint',q.mint,
    'amount_atomic',q.amount_atomic::text,'resource_url',q.resource_url,'payment_requirements',q.payment_requirements,
    'grant_status',g.status,'expires_at',g.expires_at,'attempt',jsonb_build_object(
      'id',t.id,'status',t.status,'idempotency_key',t.idempotency_key,'signature',t.signature))
  FROM public.x402_payment_attempts t JOIN public.x402_grants g ON g.id = t.grant_id
    JOIN public.x402_payment_quotes q ON q.id = t.quote_id JOIN public.print_jobs j ON j.id = t.job_id
  WHERE t.id = p_attempt_id;
$$;

-- Claim a bounded fair batch without taking an order lock. All order mutations
-- later use the original order -> budget -> grant -> attempt locking order.
CREATE FUNCTION public.claim_x402_recovery_batch() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  WITH picked AS (
    SELECT id FROM public.x402_payment_attempts
    WHERE (status IN ('reserved','settling','pending') OR (status = 'confirmed' AND email_sent_at IS NULL))
      AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= now())
      AND (recovery_checked_at IS NULL OR recovery_checked_at < now() - interval '30 seconds')
    ORDER BY recovery_checked_at NULLS FIRST, reserved_at, id LIMIT 2 FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.x402_payment_attempts t SET recovery_claim_id = gen_random_uuid(),
      recovery_claimed_at = now(), recovery_lease_expires_at = now() + interval '5 minutes'
    FROM picked WHERE t.id = picked.id RETURNING t.*
  ) SELECT coalesce(jsonb_agg(to_jsonb(claimed) || jsonb_build_object('amount_atomic',amount_atomic::text)), '[]')
    INTO result FROM claimed;
  RETURN result;
END;
$$;

CREATE FUNCTION public.save_x402_recovery_progress(p_attempt_id uuid,p_claim_id uuid,
  p_before text,p_cycle_complete boolean,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_cycle_complete IS NULL OR p_reason IS NULL OR p_reason NOT IN ('pending','rpc_unavailable','notification_pending')
    OR (p_before IS NOT NULL AND p_before !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$') THEN RAISE EXCEPTION 'invalid_recovery_progress'; END IF;
  UPDATE public.x402_payment_attempts SET recovery_scan_before = p_before,
    recovery_scan_cycles = recovery_scan_cycles + CASE WHEN p_cycle_complete THEN 1 ELSE 0 END,
    recovery_last_reason = p_reason
    WHERE id = p_attempt_id AND recovery_claim_id = p_claim_id AND recovery_lease_expires_at > now();
  RETURN FOUND;
END;
$$;

-- Only a reservation that NEVER crossed the durable dispatch boundary is safe
-- to abandon. The order lock serializes this with claim_x402_settlement.
CREATE FUNCTION public.abandon_x402_reserved(p_attempt_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.x402_payment_attempts;
BEGIN
  PERFORM j.id FROM public.print_jobs j JOIN public.x402_payment_attempts a ON a.job_id = j.id
    WHERE a.id = p_attempt_id FOR UPDATE OF j;
  SELECT * INTO STRICT t FROM public.x402_payment_attempts WHERE id = p_attempt_id;
  IF t.status <> 'reserved' OR t.reserved_at > now() - interval '5 minutes'
    OR t.payload_fingerprint IS NOT NULL OR t.signed_transaction_base64 IS NOT NULL
    OR t.settlement_started_at IS NOT NULL OR t.signature IS NOT NULL THEN RETURN false; END IF;
  PERFORM public.update_x402_payment_attempt(t.id,'fail_not_broadcast',
    jsonb_build_object('evidence',jsonb_build_object('reason','not_broadcast')));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.x402_recovery_purchase(uuid),public.claim_x402_recovery_batch(),
  public.save_x402_recovery_progress(uuid,uuid,text,boolean,text),public.abandon_x402_reserved(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.x402_recovery_purchase(uuid),public.claim_x402_recovery_batch(),
  public.save_x402_recovery_progress(uuid,uuid,text,boolean,text),public.abandon_x402_reserved(uuid) TO service_role;
-- Explicit admin projection; amounts remain decimal strings, no raw proof.
CREATE FUNCTION public.admin_x402_evidence(p_job_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'job_id',t.job_id,'grant_id',t.grant_id,
    'network',q.network,'amount_atomic',t.amount_atomic::text,'status',t.status,'signature',t.signature,
    'reserved_at',t.reserved_at,'confirmed_at',t.confirmed_at,'recovery_checked_at',t.recovery_checked_at,
    'recovery_scan_cycles',t.recovery_scan_cycles,'email_sent_at',t.email_sent_at,
    'finality',CASE WHEN t.status = 'confirmed' THEN 'finalized' ELSE NULL END,
    'needs_review',t.status IN ('settling','pending') AND t.reserved_at < now() - interval '15 minutes')), '[]')
  FROM public.x402_payment_attempts t JOIN public.x402_payment_quotes q ON q.id = t.quote_id
  WHERE t.job_id = ANY(p_job_ids);
$$;
REVOKE ALL ON FUNCTION public.admin_x402_evidence(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_x402_evidence(uuid[]) TO service_role;
COMMIT;
