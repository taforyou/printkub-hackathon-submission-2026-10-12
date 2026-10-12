-- Creator-only USDC checkout. Owner confirms the earlier migration 040
-- was never applied; this replaces that local proposal, not database history.
BEGIN;
ALTER TABLE public.creator_profiles ADD COLUMN accepts_crypto_payments boolean NOT NULL DEFAULT false;
CREATE OR REPLACE VIEW public.creator_catalog_profiles WITH (security_barrier = true) AS
SELECT id,shop_name,description,portfolio_url,cover_image_path,is_verified,total_products,total_sales,
  created_at,updated_at,accepts_crypto_payments FROM public.creator_profiles WHERE is_active = true;
GRANT SELECT ON public.creator_catalog_profiles TO anon, authenticated;
ALTER TABLE public.print_jobs ADD COLUMN checkout_payment_provider text
  CHECK (checkout_payment_provider IN ('beam','maxme','crypto'));
COMMENT ON COLUMN public.print_jobs.checkout_payment_provider IS
  'Immutable gateway selected at checkout. Crypto orders use normal fulfillment and creator accounting.';

CREATE FUNCTION public.assert_creator_crypto_eligible(p_job_id uuid, p_snapshot boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.print_job_items WHERE job_id = p_job_id)
     OR EXISTS (SELECT 1 FROM public.print_job_items WHERE job_id = p_job_id
       AND (product_type <> 'creator-product' OR creator_product_id IS NULL
         OR tag_type = 'special' OR special_tag_parent_item_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'crypto_creator_items_only';
  END IF;
  IF NOT p_snapshot AND EXISTS (
    SELECT 1 FROM public.print_job_items i
    LEFT JOIN public.creator_products p ON p.id = i.creator_product_id
    LEFT JOIN public.creator_profiles c ON c.id = p.creator_id
    WHERE i.job_id = p_job_id AND (c.id IS NULL OR NOT c.is_active OR NOT c.accepts_crypto_payments)
  ) THEN RAISE EXCEPTION 'crypto_creator_consent_required'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_creator_crypto_eligible(uuid,boolean) FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.checkout_cart(text,text,jsonb,text,text[],boolean,jsonb,text,boolean)
RENAME TO checkout_cart_internal;
REVOKE ALL ON FUNCTION public.checkout_cart_internal(text,text,jsonb,text,text[],boolean,jsonb,text,boolean)
FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.checkout_cart(
  p_delivery_method text DEFAULT 'shipping', p_contact_phone text DEFAULT NULL,
  p_shipping_address jsonb DEFAULT NULL, p_notes text DEFAULT NULL,
  p_coupon_codes text[] DEFAULT '{}', p_wants_tax_receipt boolean DEFAULT false,
  p_tax_receipt jsonb DEFAULT NULL, p_tax_receipt_delivery text DEFAULT 'with_shipment',
  p_use_sameday boolean DEFAULT false, p_payment_provider text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cart public.print_jobs; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
  IF p_payment_provider IS NOT NULL AND p_payment_provider NOT IN ('beam','maxme','crypto') THEN
    RAISE EXCEPTION 'invalid_payment_provider';
  END IF;
  SELECT * INTO v_cart FROM public.print_jobs WHERE user_id = auth.uid() AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_cart'); END IF;
  IF p_payment_provider = 'crypto' THEN
    -- Lock the current creators' consent until this transaction completes.
    PERFORM c.id FROM public.creator_profiles c WHERE c.id IN (
      SELECT p.creator_id FROM public.print_job_items i JOIN public.creator_products p ON p.id = i.creator_product_id
      WHERE i.job_id = v_cart.id) ORDER BY c.id FOR SHARE;
    PERFORM public.assert_creator_crypto_eligible(v_cart.id);
  END IF;
  v_result := public.checkout_cart_internal(p_delivery_method,p_contact_phone,p_shipping_address,p_notes,
    p_coupon_codes,p_wants_tax_receipt,p_tax_receipt,p_tax_receipt_delivery,p_use_sameday);
  IF COALESCE((v_result->>'success')::boolean, false) THEN
    IF p_payment_provider = 'crypto' THEN PERFORM public.assert_creator_crypto_eligible(v_cart.id); END IF;
    -- Coupon-specific gateway constraints remain authoritative.
    IF p_payment_provider IS NOT NULL AND EXISTS (SELECT 1 FROM public.print_jobs WHERE id = v_cart.id
      AND required_payment_provider IS NOT NULL AND required_payment_provider <> p_payment_provider) THEN
      RAISE EXCEPTION 'coupon_payment_provider_required';
    END IF;
    PERFORM set_config('printkub.checkout_gateway', 'on', true);
    UPDATE public.print_jobs SET checkout_payment_provider = p_payment_provider WHERE id = v_cart.id;
    PERFORM set_config('printkub.checkout_gateway', 'off', true);
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.checkout_cart(text,text,jsonb,text,text[],boolean,jsonb,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkout_cart(text,text,jsonb,text,text[],boolean,jsonb,text,boolean,text) TO authenticated;

CREATE TABLE public.solana_payment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES public.print_jobs(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  payer text NOT NULL,
  recipient text NOT NULL,
  recipient_token_account text NOT NULL,
  network text NOT NULL DEFAULT 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    CHECK (network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
  mint text NOT NULL DEFAULT '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    CHECK (mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  total_thb numeric(12,2) NOT NULL CHECK (total_thb > 0),
  rate numeric NOT NULL CHECK (rate > 0),
  rate_snapshot jsonb NOT NULL,
  surcharge_bps integer NOT NULL DEFAULT 100 CHECK (surcharge_bps = 100),
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  status text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'prepared', 'submitted', 'confirmed', 'failed')),
  message_base64 text,
  transaction_base64 text,
  last_valid_block_height bigint,
  signature text UNIQUE,
  signed_transaction_base64 text,
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.solana_payment_quotes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solana_payment_quotes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solana_payment_quotes TO service_role;

CREATE FUNCTION public.guard_solana_payment_quote() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.job_id,NEW.user_id,NEW.payer,NEW.recipient,NEW.recipient_token_account,NEW.network,
    NEW.mint,NEW.total_thb,NEW.rate,NEW.rate_snapshot,NEW.surcharge_bps,NEW.amount_atomic,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.job_id,OLD.user_id,OLD.payer,OLD.recipient,OLD.recipient_token_account,OLD.network,
    OLD.mint,OLD.total_thb,OLD.rate,OLD.rate_snapshot,OLD.surcharge_bps,OLD.amount_atomic,OLD.expires_at) THEN
    RAISE EXCEPTION 'crypto_quote_immutable';
  END IF;
  IF OLD.signature IS NOT NULL AND ROW(NEW.signature,NEW.signed_transaction_base64,NEW.message_base64,
    NEW.transaction_base64,NEW.last_valid_block_height) IS DISTINCT FROM
    ROW(OLD.signature,OLD.signed_transaction_base64,OLD.message_base64,OLD.transaction_base64,OLD.last_valid_block_height) THEN
    RAISE EXCEPTION 'crypto_signature_immutable';
  END IF;
  IF OLD.status IN ('confirmed','failed') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'crypto_attempt_terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER solana_payment_quotes_immutable BEFORE UPDATE ON public.solana_payment_quotes
FOR EACH ROW EXECUTE FUNCTION public.guard_solana_payment_quote();
REVOKE ALL ON FUNCTION public.guard_solana_payment_quote() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.guard_crypto_order() RETURNS trigger
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
    IF NEW.payment_status = 'paid' AND OLD.payment_status <> 'paid' AND NOT EXISTS (
      SELECT 1 FROM public.solana_payment_quotes WHERE job_id = NEW.id AND status = 'confirmed'
    ) THEN RAISE EXCEPTION 'crypto_settlement_required'; END IF;
    IF NEW.payment_status = 'paid' THEN NEW.payment_method := 'usdc'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER print_jobs_guard_crypto BEFORE INSERT OR UPDATE ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_crypto_order();

CREATE FUNCTION public.guard_payment_checkout_provider() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_provider text;
BEGIN
  SELECT checkout_payment_provider INTO v_provider FROM public.print_jobs WHERE job_number = NEW.order_no FOR UPDATE;
  IF v_provider IS NOT NULL AND v_provider <> NEW.provider THEN RAISE EXCEPTION 'provider_mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_guard_checkout_provider BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.guard_payment_checkout_provider();

CREATE FUNCTION public.create_solana_payment_quote(p_job_id uuid, p_payer text, p_recipient text,
  p_recipient_token_account text, p_rate_snapshot jsonb, p_ttl integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.print_jobs; q public.solana_payment_quotes; t numeric; r numeric;
BEGIN
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id = p_job_id FOR UPDATE;
  IF j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status <> 'submitted' OR j.deleted_at IS NOT NULL OR j.payment_status = 'paid'
     OR EXISTS (SELECT 1 FROM public.payments WHERE order_no = j.job_number) THEN
    RAISE EXCEPTION 'crypto_order_not_payable';
  END IF;
  PERFORM public.assert_creator_crypto_eligible(j.id, true);
  SELECT * INTO q FROM public.solana_payment_quotes WHERE job_id = j.id;
  IF FOUND THEN
    IF q.payer <> p_payer THEN RAISE EXCEPTION 'crypto_payer_locked'; END IF;
    RETURN to_jsonb(q);
  END IF;
  t := GREATEST(COALESCE(j.total_price,0) + COALESCE(j.shipping_cost,0) - COALESCE(j.discount_amount,0), 0);
  r := (p_rate_snapshot->>'rate')::numeric;
  IF t <= 0 OR r IS NULL OR r <= 0 OR p_ttl NOT BETWEEN 60 AND 1800 THEN RAISE EXCEPTION 'invalid_crypto_quote'; END IF;
  INSERT INTO public.solana_payment_quotes(job_id,user_id,payer,recipient,recipient_token_account,total_thb,
    rate,rate_snapshot,amount_atomic,expires_at)
  VALUES(j.id,j.user_id,p_payer,p_recipient,p_recipient_token_account,t,r,p_rate_snapshot,
    ceil(t / r * 1.01 * 1000000)::bigint, now() + make_interval(secs => p_ttl)) RETURNING * INTO q;
  RETURN to_jsonb(q);
END;
$$;

-- Compare-and-set preparation/broadcast prevents competing signatures.
CREATE FUNCTION public.update_solana_payment_attempt(p_quote_id uuid, p_action text, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE q public.solana_payment_quotes; j public.print_jobs;
BEGIN
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id =
    (SELECT job_id FROM public.solana_payment_quotes WHERE id = p_quote_id) FOR UPDATE;
  SELECT * INTO STRICT q FROM public.solana_payment_quotes WHERE id = p_quote_id FOR UPDATE;
  IF j.checkout_payment_provider IS DISTINCT FROM 'crypto' OR j.status IN ('draft','cancelled','refund') OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL THEN RAISE EXCEPTION 'crypto_order_not_payable'; END IF;
  IF p_action = 'prepare' THEN
    IF q.signature IS NOT NULL OR q.expires_at <= now() OR q.status = 'failed' THEN RAISE EXCEPTION 'crypto_attempt_locked'; END IF;
    -- A retry cannot replace a blockhash that remains valid.
    IF q.message_base64 IS NULL OR q.last_valid_block_height < (p_data->>'block_height')::bigint THEN
      UPDATE public.solana_payment_quotes SET status = 'prepared',
        message_base64 = p_data->>'message', transaction_base64 = p_data->>'transaction',
        last_valid_block_height = (p_data->>'last_valid_block_height')::bigint
      WHERE id = q.id RETURNING * INTO q;
    END IF;
  ELSIF p_action = 'submit' THEN
    IF q.signature IS NOT NULL THEN
      IF q.signature <> p_data->>'signature' THEN RAISE EXCEPTION 'crypto_attempt_locked'; END IF;
      RETURN to_jsonb(q);
    END IF;
    IF q.status <> 'prepared' OR q.expires_at <= now() OR q.message_base64 <> p_data->>'message' THEN
      RAISE EXCEPTION 'crypto_attempt_locked';
    END IF;
    UPDATE public.solana_payment_quotes SET status = 'submitted', signature = p_data->>'signature',
      signed_transaction_base64 = p_data->>'signed_transaction', submitted_at = now()
    WHERE id = q.id RETURNING * INTO q;
  ELSIF p_action = 'confirm' THEN
    IF q.signature IS NULL OR q.signature <> p_data->>'signature' OR q.status NOT IN ('submitted','confirmed') THEN
      RAISE EXCEPTION 'crypto_settlement_invalid';
    END IF;
    UPDATE public.solana_payment_quotes SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now())
      WHERE id = q.id RETURNING * INTO q;
    UPDATE public.print_jobs SET payment_status = 'paid', payment_method = 'usdc',
      status = CASE WHEN status = 'submitted' THEN 'processing' ELSE status END WHERE id = j.id;
  ELSIF p_action = 'fail' THEN
    IF q.status = 'submitted' THEN
      UPDATE public.solana_payment_quotes SET status = 'failed' WHERE id = q.id RETURNING * INTO q;
      UPDATE public.print_jobs SET payment_status = 'failed' WHERE id = j.id;
    END IF;
  ELSE RAISE EXCEPTION 'invalid_crypto_action';
  END IF;
  RETURN to_jsonb(q);
END;
$$;
REVOKE ALL ON FUNCTION public.create_solana_payment_quote(uuid,text,text,text,jsonb,integer),
  public.update_solana_payment_attempt(uuid,text,jsonb), public.guard_crypto_order(),
  public.guard_payment_checkout_provider() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_solana_payment_quote(uuid,text,text,text,jsonb,integer),
  public.update_solana_payment_attempt(uuid,text,jsonb) TO service_role;
COMMIT;
