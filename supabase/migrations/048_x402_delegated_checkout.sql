-- Share checkout totals, delivery and creator accounting without impersonating
-- a customer's JWT. The customer identity comes only from their linked policy.
BEGIN;
CREATE FUNCTION public.checkout_cart_for_customer(
  p_customer_id uuid,
  p_delivery_method TEXT DEFAULT 'shipping',
  p_contact_phone TEXT DEFAULT NULL,
  p_shipping_address JSONB DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_coupon_codes TEXT[] DEFAULT '{}',
  p_wants_tax_receipt BOOLEAN DEFAULT FALSE,
  p_tax_receipt JSONB DEFAULT NULL,
  p_tax_receipt_delivery TEXT DEFAULT 'with_shipment',
  p_use_sameday BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := p_customer_id;
  v_cart RECORD;
  v_subtotal DECIMAL := 0;
  v_item_count INTEGER := 0;
  v_shipping_cost DECIMAL := 0;
  v_shipping_cost_for_coupon DECIMAL := 0;
  v_has_free_shipping BOOLEAN := false;
  v_has_maxme100_coupon BOOLEAN := false;
  v_coupon_result JSONB;
  v_discount_amount DECIMAL := 0;
  v_final_total DECIMAL;
  v_item RECORD;
  v_item_total DECIMAL;
  v_technologies TEXT[];
  v_first_product TEXT;
  v_tax_id TEXT;
  v_tax_name TEXT;
  v_tax_delivery TEXT;
  v_effective_delivery TEXT;
  v_sameday_tier SMALLINT := NULL;
  v_sameday_fee DECIMAL := NULL;
  v_sameday_postal TEXT;
  v_creator_ids UUID[];
  v_single_creator_id UUID := NULL;
  v_single_creator_product_id UUID := NULL;
  v_total_platform_fee DECIMAL := 0;
  v_total_creator_amount DECIMAL := 0;
  v_order_source TEXT := 'direct';
  v_cp_item RECORD;
  v_cp_order_total DECIMAL;
  v_cp_platform_fee DECIMAL;
  v_cp_creator_amount DECIMAL;
  v_tag_need RECORD;
  v_tag_stock INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- Sameday: derive tier + fee from the shipping postal code.
  IF p_use_sameday THEN
    IF p_shipping_address IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'sameday_no_address',
        'message_th', 'จัดส่งด่วนต้องมีที่อยู่',
        'message_en', 'Same-day delivery requires a shipping address');
    END IF;

    v_sameday_postal := NULLIF(TRIM(COALESCE(p_shipping_address->>'postal_code', '')), '');
    IF v_sameday_postal IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'sameday_no_postal',
        'message_th', 'ที่อยู่ไม่มีรหัสไปรษณีย์',
        'message_en', 'Shipping address is missing postal code');
    END IF;

    v_sameday_tier := sameday_tier_for_postal(v_sameday_postal);
    IF v_sameday_tier IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'sameday_outside_zone',
        'message_th', 'ที่อยู่ปลายทางอยู่นอกพื้นที่ให้บริการจัดส่งด่วน',
        'message_en', 'Destination is outside the same-day delivery zone');
    END IF;

    v_sameday_fee := sameday_fee_for_tier(v_sameday_tier);
    v_effective_delivery := 'sameday';
  ELSE
    v_effective_delivery := p_delivery_method;
  END IF;

  -- Tax receipt validation
  IF p_wants_tax_receipt THEN
    IF p_tax_receipt IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'tax_receipt_missing',
        'message_th', 'กรุณากรอกข้อมูลใบกำกับภาษี',
        'message_en', 'Tax receipt info is required');
    END IF;

    v_tax_name := NULLIF(TRIM(p_tax_receipt->>'tax_name'), '');
    v_tax_id := regexp_replace(COALESCE(p_tax_receipt->>'tax_id', ''), '\D', '', 'g');

    IF v_tax_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'tax_name_missing',
        'message_th', 'กรุณากรอกชื่อในใบกำกับภาษี',
        'message_en', 'Tax receipt name is required');
    END IF;

    IF length(v_tax_id) <> 13 THEN
      RETURN jsonb_build_object('success', false, 'error', 'tax_id_invalid',
        'message_th', 'เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก',
        'message_en', 'Tax ID must be 13 digits');
    END IF;

    IF NULLIF(TRIM(p_tax_receipt->>'address_line1'), '') IS NULL
       OR NULLIF(TRIM(p_tax_receipt->>'subdistrict'), '') IS NULL
       OR NULLIF(TRIM(p_tax_receipt->>'district'), '') IS NULL
       OR NULLIF(TRIM(p_tax_receipt->>'province'), '') IS NULL
       OR NULLIF(TRIM(p_tax_receipt->>'postal_code'), '') IS NULL
    THEN
      RETURN jsonb_build_object('success', false, 'error', 'tax_address_incomplete',
        'message_th', 'กรุณากรอกที่อยู่ใบกำกับภาษีให้ครบถ้วน',
        'message_en', 'Tax receipt address is incomplete');
    END IF;

    v_tax_delivery := COALESCE(NULLIF(p_tax_receipt_delivery, ''), 'with_shipment');
    IF v_tax_delivery NOT IN ('with_shipment', 'separate') THEN
      v_tax_delivery := 'with_shipment';
    END IF;
  ELSE
    v_tax_delivery := NULL;
  END IF;

  SELECT * INTO v_cart
    FROM print_jobs
    WHERE user_id = v_user_id AND status = 'draft'
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_cart',
      'message_th', 'ไม่พบตะกร้าสินค้า', 'message_en', 'No cart found');
  END IF;

  -- Lock every requested color in deterministic order before coupons or
  -- totals change. The locks stay held until this checkout transaction ends,
  -- preventing two buyers from consuming the same final piece.
  FOR v_tag_need IN
    SELECT special_tag_color AS color, SUM(quantity)::INTEGER AS quantity
      FROM print_job_items
     WHERE job_id = v_cart.id
       AND tag_type = 'special'
     GROUP BY special_tag_color
     ORDER BY special_tag_color
  LOOP
    SELECT stock_quantity INTO v_tag_stock
      FROM special_tag_inventory
     WHERE color = v_tag_need.color
     FOR UPDATE;

    IF NOT FOUND OR v_tag_stock < v_tag_need.quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'special_tag_out_of_stock',
        'color', v_tag_need.color,
        'available', COALESCE(v_tag_stock, 0),
        'requested', v_tag_need.quantity,
        'message_th', 'สายคล้องพิเศษสีที่เลือกมีสต๊อกไม่เพียงพอ กรุณาเลือกสีอื่นหรือลดจำนวน',
        'message_en', 'The selected special tag color does not have enough stock. Choose another color or reduce the quantity.'
      );
    END IF;
  END LOOP;

  -- Snapshot per-item prices + accumulate subtotal
  FOR v_item IN
    SELECT * FROM print_job_items WHERE job_id = v_cart.id
  LOOP
    v_item_count := v_item_count + 1;

    IF v_item.product_type = 'custom-upload' OR v_item.creator_product_id IS NOT NULL THEN
      v_item_total := (
        COALESCE(v_item.unit_price, 0) + COALESCE(v_item.tag_unit_price, 0)
      ) * v_item.quantity;
      UPDATE print_job_items
        SET total_price = ROUND(v_item_total, 2)
        WHERE id = v_item.id;
    ELSE
      v_item_total := (
        COALESCE(v_item.price_per_char, 0) * COALESCE(v_item.chars, 0)
        + COALESCE(v_item.tag_unit_price, 0)
      ) * v_item.quantity;
      UPDATE print_job_items
        SET unit_price = ROUND(
              COALESCE(price_per_char, 0) * COALESCE(chars, 0)
              + COALESCE(tag_unit_price, 0),
              2
            ),
            total_price = ROUND(v_item_total, 2)
        WHERE id = v_item.id;
    END IF;

    v_subtotal := v_subtotal + v_item_total;

    -- Campaign-gated. Pausing KEYBOARD_FIDGET_FREE_SHIPPING_ACTIVE in JS
    -- used to leave this SQL path live, so keyboard-fidget 3+ char orders
    -- still stored shipping_cost = 0 and charged ฿50 less than the UI.
    IF keyboard_fidget_free_shipping_active()
       AND v_item.product_type = 'keyboard-fidget'
       AND COALESCE(v_item.chars, 0) >= 3 THEN
      v_has_free_shipping := true;
    END IF;
  END LOOP;

  IF v_item_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'empty_cart',
      'message_th', 'ตะกร้าว่างเปล่า', 'message_en', 'Cart is empty');
  END IF;

  -- Shipping cost
  IF v_effective_delivery = 'sameday' THEN
    v_shipping_cost := v_sameday_fee;
    v_shipping_cost_for_coupon := 0;  -- sameday remains excluded from free-shipping discounts
  ELSIF v_effective_delivery = 'shipping' THEN
    v_shipping_cost := CASE WHEN v_has_free_shipping THEN 0 ELSE 50 END;
    v_shipping_cost_for_coupon := v_shipping_cost;
  END IF;

  -- Coupons (stacked, with strict tech gate)
  IF p_coupon_codes IS NOT NULL AND array_length(p_coupon_codes, 1) > 0 THEN
    SELECT array_agg(DISTINCT COALESCE(technology, 'FDM'))
      INTO v_technologies
      FROM print_job_items
      WHERE job_id = v_cart.id;

    SELECT product_type INTO v_first_product
      FROM print_job_items WHERE job_id = v_cart.id LIMIT 1;

    -- Resolve the parent campaign instead of trusting a client-visible prefix.
    -- Account ownership and one-time state are still enforced in claim_coupons.
    SELECT EXISTS (
      SELECT 1
        FROM unnest(p_coupon_codes) AS requested(code)
        CROSS JOIN LATERAL _resolve_coupon_code(requested.code) AS resolved
        JOIN coupons c ON c.id = resolved.coupon_id
       WHERE UPPER(c.code) = 'MAXME100-CAMPAIGN'
    ) INTO v_has_maxme100_coupon;

    SELECT claim_coupons(
      p_coupon_codes,
      v_user_id,
      v_cart.id,
      v_subtotal,
      CASE WHEN v_has_maxme100_coupon THEN v_shipping_cost ELSE v_shipping_cost_for_coupon END,
      v_technologies,
      NULL,
      v_first_product
    ) INTO v_coupon_result;

    -- A rejected minimum/stacking rule aborts the RPC before the cart becomes
    -- an order. The customer never gets silently checked out at full price.
    IF NOT COALESCE((v_coupon_result->>'success')::BOOLEAN, false) THEN
      RETURN v_coupon_result;
    END IF;

    v_discount_amount := COALESCE((v_coupon_result->>'total_discount')::DECIMAL, 0);
  END IF;

  -- Coupon validation has succeeded. Consume the already-locked stock now;
  -- any later database exception rolls this function back atomically.
  UPDATE special_tag_inventory AS inventory
     SET stock_quantity = inventory.stock_quantity - required.quantity,
         updated_at = NOW()
    FROM (
      SELECT special_tag_color AS color, SUM(quantity)::INTEGER AS quantity
        FROM print_job_items
       WHERE job_id = v_cart.id
         AND tag_type = 'special'
       GROUP BY special_tag_color
    ) AS required
   WHERE inventory.color = required.color;

  v_final_total := ROUND(GREATEST(0, v_subtotal + v_shipping_cost - v_discount_amount), 2);

  -- Normalize tax receipt snapshot
  IF p_wants_tax_receipt THEN
    p_tax_receipt := jsonb_build_object(
      'tax_name',     TRIM(p_tax_receipt->>'tax_name'),
      'tax_id',       v_tax_id,
      'branch',       NULLIF(TRIM(COALESCE(p_tax_receipt->>'branch', '')), ''),
      'address_line1', TRIM(p_tax_receipt->>'address_line1'),
      'address_line2', NULLIF(TRIM(COALESCE(p_tax_receipt->>'address_line2', '')), ''),
      'subdistrict',  TRIM(p_tax_receipt->>'subdistrict'),
      'district',     TRIM(p_tax_receipt->>'district'),
      'province',     TRIM(p_tax_receipt->>'province'),
      'postal_code',  TRIM(p_tax_receipt->>'postal_code'),
      'phone',        NULLIF(TRIM(COALESCE(p_tax_receipt->>'phone', '')), '')
    );
  ELSE
    p_tax_receipt := NULL;
  END IF;

  -- Creator split: one ledger row per creator-product line.
  FOR v_cp_item IN
    SELECT pji.id AS item_id,
           pji.creator_product_id,
           pji.unit_price,
           pji.quantity,
           cp.creator_id,
           cpr.commission_rate
      FROM print_job_items pji
      JOIN creator_products  cp  ON cp.id  = pji.creator_product_id
      JOIN creator_profiles  cpr ON cpr.id = cp.creator_id
     WHERE pji.job_id = v_cart.id
       AND pji.creator_product_id IS NOT NULL
  LOOP
    v_cp_order_total := ROUND(COALESCE(v_cp_item.unit_price, 0) * v_cp_item.quantity, 2);
    v_cp_platform_fee := ROUND(v_cp_order_total * (v_cp_item.commission_rate / 100.0), 2);
    v_cp_creator_amount := ROUND(v_cp_order_total - v_cp_platform_fee, 2);

    INSERT INTO creator_earnings_ledger (
      creator_id, job_id, product_id,
      order_total, platform_fee_rate, platform_fee_amount, creator_amount,
      status
    ) VALUES (
      v_cp_item.creator_id, v_cart.id, v_cp_item.creator_product_id,
      v_cp_order_total, v_cp_item.commission_rate, v_cp_platform_fee, v_cp_creator_amount,
      'pending'
    );

    v_total_platform_fee := v_total_platform_fee + v_cp_platform_fee;
    v_total_creator_amount := v_total_creator_amount + v_cp_creator_amount;
  END LOOP;

  -- Single-creator attribution for job-level columns
  SELECT array_agg(DISTINCT cp.creator_id)
    INTO v_creator_ids
    FROM print_job_items pji
    JOIN creator_products cp ON cp.id = pji.creator_product_id
   WHERE pji.job_id = v_cart.id
     AND pji.creator_product_id IS NOT NULL;

  IF v_creator_ids IS NOT NULL AND array_length(v_creator_ids, 1) > 0 THEN
    v_order_source := 'creator_marketplace';
    IF array_length(v_creator_ids, 1) = 1 THEN
      v_single_creator_id := v_creator_ids[1];
      SELECT creator_product_id INTO v_single_creator_product_id
        FROM print_job_items
        WHERE job_id = v_cart.id AND creator_product_id IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;
  END IF;

  UPDATE print_jobs
    SET status = 'submitted',
        total_price = ROUND(v_subtotal, 2),
        shipping_cost = v_shipping_cost,
        discount_amount = ROUND(v_discount_amount, 2),
        delivery_method = v_effective_delivery,
        sameday_tier = v_sameday_tier,
        sameday_fee = v_sameday_fee,
        contact_phone = p_contact_phone,
        recipient_name = p_shipping_address->>'recipient_name',
        shipping_address_line1 = p_shipping_address->>'line1',
        shipping_address_line2 = p_shipping_address->>'line2',
        shipping_district = p_shipping_address->>'district',
        shipping_subdistrict = p_shipping_address->>'subdistrict',
        shipping_province = p_shipping_address->>'province',
        shipping_postal_code = p_shipping_address->>'postal_code',
        wants_tax_receipt = p_wants_tax_receipt,
        tax_receipt = p_tax_receipt,
        tax_receipt_delivery = v_tax_delivery,
        notes = p_notes,
        order_source = v_order_source,
        creator_id = v_single_creator_id,
        creator_product_id = v_single_creator_product_id,
        platform_fee = CASE WHEN v_total_platform_fee > 0 THEN ROUND(v_total_platform_fee, 2) ELSE NULL END,
        creator_earnings = CASE WHEN v_total_creator_amount > 0 THEN ROUND(v_total_creator_amount, 2) ELSE NULL END,
        submitted_at = NOW(),
        updated_at = NOW()
    WHERE id = v_cart.id;

  RETURN jsonb_build_object(
    'success', true,
    'job_id', v_cart.id,
    'job_number', v_cart.job_number,
    'total_price', ROUND(v_subtotal, 2),
    'shipping_cost', v_shipping_cost,
    'discount_amount', ROUND(v_discount_amount, 2),
    'final_total', ROUND(v_final_total, 2),
    'item_count', v_item_count,
    'sameday_tier', v_sameday_tier,
    'sameday_fee', v_sameday_fee,
    'order_source', v_order_source,
    'platform_fee', ROUND(v_total_platform_fee, 2),
    'creator_earnings', ROUND(v_total_creator_amount, 2)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.checkout_cart_for_customer(uuid,text,text,jsonb,text,text[],boolean,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.checkout_cart_internal(
  p_delivery_method text DEFAULT 'shipping',p_contact_phone text DEFAULT NULL,p_shipping_address jsonb DEFAULT NULL,
  p_notes text DEFAULT NULL,p_coupon_codes text[] DEFAULT '{}',p_wants_tax_receipt boolean DEFAULT false,
  p_tax_receipt jsonb DEFAULT NULL,p_tax_receipt_delivery text DEFAULT 'with_shipment',p_use_sameday boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.checkout_cart_for_customer(auth.uid(),p_delivery_method,p_contact_phone,p_shipping_address,p_notes,
    p_coupon_codes,p_wants_tax_receipt,p_tax_receipt,p_tax_receipt_delivery,p_use_sameday);
$$;
REVOKE ALL ON FUNCTION public.checkout_cart_internal(text,text,jsonb,text,text[],boolean,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.x402_agent_catalog(p_product_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.x402_agents a JOIN public.x402_customer_agents l ON l.auth_user_id=a.auth_user_id
    JOIN public.x402_agent_enrollments e ON e.auth_user_id=a.auth_user_id
    WHERE a.auth_user_id=auth.uid() AND a.revoked_at IS NULL AND l.revoked_at IS NULL AND e.revoked_at IS NULL)
    THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'shop_id',p.creator_id,'title',p.title,
    'description',p.description,'base_price_thb',p.base_price::text,'customization_kind',p.customization->>'kind',
    'default_options',public.x402_default_product_options(p),'file_type',f.file_type,'quantity',1,
    'manufacturing_supported',p.customization IS NULL AND lower(f.file_type) IN ('stl','3mf'))),'[]') INTO result
  FROM public.creator_products p JOIN public.creator_profiles c ON c.id=p.creator_id JOIN public.files f ON f.id=p.file_id
  WHERE p.id='458c809e-c99e-473a-8952-8b850fa7fe65' AND p.creator_id='645ce058-830f-4f0d-a2a1-8cf69e153fc1'
    AND p.is_published AND p.is_approved AND c.is_active AND c.accepts_crypto_payments
    AND (p_product_id IS NULL OR p.id=p_product_id);
  RETURN result;
END;
$$;
CREATE FUNCTION public.prepare_x402_delegated_purchase(p_principal uuid,p_request_id uuid,p_product_id uuid,
  p_quantity integer,p_options jsonb,p_available_colors jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.x402_agents; pol public.x402_purchase_policies; d public.x402_delegated_purchases;
  prod public.creator_products; j uuid; result jsonb; payload jsonb;
BEGIN
  SELECT a0.* INTO STRICT a FROM public.x402_agents a0 JOIN public.x402_customer_agents l ON l.auth_user_id=a0.auth_user_id
    JOIN public.x402_agent_enrollments e ON e.auth_user_id=a0.auth_user_id
    WHERE a0.auth_user_id=p_principal AND a0.revoked_at IS NULL AND l.revoked_at IS NULL AND e.revoked_at IS NULL;
  payload := jsonb_build_object('product_id',p_product_id,'quantity',p_quantity,'options',p_options);
  -- Principal lock serializes retries, including requests before their policy is resolved.
  PERFORM id FROM auth.users WHERE id=a.auth_user_id FOR UPDATE;
  SELECT * INTO d FROM public.x402_delegated_purchases WHERE agent_id=a.id AND request_id=p_request_id;
  IF FOUND THEN
    IF d.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'purchase_request_conflict'; END IF;
    RETURN jsonb_build_object('purchase_id',d.id,'job_id',d.job_id,'agent_id',a.id,'grant_id',d.grant_id);
  END IF;
  SELECT p.* INTO STRICT pol FROM public.x402_purchase_policies p JOIN public.x402_customer_agents l ON l.customer_id=p.customer_id
    AND l.auth_user_id=a.auth_user_id AND l.revoked_at IS NULL
    WHERE p.agent_id=a.id AND p.revoked_at IS NULL AND p.expires_at>now() FOR UPDATE OF p;
  PERFORM id FROM auth.users WHERE id=pol.customer_id FOR UPDATE;
  IF p_request_id IS NULL OR p_product_id IS DISTINCT FROM pol.product_id OR p_quantity IS DISTINCT FROM 1
    OR p_options IS DISTINCT FROM pol.options THEN RAISE EXCEPTION 'purchase_outside_policy'; END IF;
  IF (SELECT count(*) FROM public.x402_delegated_purchases WHERE policy_id=pol.id) >= pol.max_orders
    THEN RAISE EXCEPTION 'purchase_count_limit'; END IF;
  PERFORM id FROM public.user_profiles WHERE id=pol.customer_id FOR SHARE;
  IF pol.delivery->>'method'='shipping' AND pol.delivery IS DISTINCT FROM public.x402_saved_delivery(pol.customer_id)
    THEN RAISE EXCEPTION 'delivery_changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.print_jobs WHERE user_id=pol.customer_id AND status='draft')
    THEN RAISE EXCEPTION 'conflicting_cart'; END IF;
  SELECT * INTO STRICT prod FROM public.creator_products WHERE id=pol.product_id AND creator_id=pol.shop_id
    AND is_published AND is_approved FOR SHARE;
  PERFORM id FROM public.creator_profiles WHERE id=prod.creator_id AND is_active AND accepts_crypto_payments FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crypto_creator_consent_required'; END IF;
  -- Never manufacture customized products by charging for their unbaked source.
  IF prod.customization IS NOT NULL OR public.x402_default_product_options(prod) IS DISTINCT FROM pol.options
    OR NOT EXISTS (SELECT 1 FROM public.files WHERE id=prod.file_id AND lower(file_type) IN ('stl','3mf'))
    THEN RAISE EXCEPTION 'manufacturing_unsupported'; END IF;
  IF pol.options ? 'mappings' THEN
    IF jsonb_typeof(pol.options->'mappings') IS DISTINCT FROM 'array' OR jsonb_array_length(pol.options->'mappings')=0
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(pol.options->'mappings') m
        WHERE NOT COALESCE(p_available_colors ? (m->>'mappedColorId'),false))
      THEN RAISE EXCEPTION 'physical_color_unavailable'; END IF;
  ELSIF NOT COALESCE(p_available_colors ? (pol.options->>'colorId'),false) THEN
    RAISE EXCEPTION 'physical_color_unavailable';
  END IF;
  INSERT INTO public.print_jobs(user_id,status,order_source,delivery_method)
    VALUES(pol.customer_id,'draft','creator_marketplace',pol.delivery->>'method') RETURNING id INTO j;
  INSERT INTO public.print_job_items(job_id,file_id,product_type,product_name,product_theme,is_custom_theme,chars,price_per_char,
    quantity,technology,material,color,unit_price,creator_product_id,product_customization,pricing_status)
    VALUES(j,prod.file_id,'creator-product',prod.title,'',false,0,0,1,'FDM','PLA',prod.default_color,
      prod.base_price,prod.id,pol.options,'not_required');
  PERFORM public.assert_creator_crypto_eligible(j);
  result := public.checkout_cart_for_customer(pol.customer_id,pol.delivery->>'method',pol.delivery->>'phone',pol.delivery->'address',
    pol.delivery->>'details','{}',false,NULL,'with_shipment',false);
  IF NOT COALESCE((result->>'success')::boolean,false) THEN RAISE EXCEPTION 'delegated_checkout_failed'; END IF;
  PERFORM set_config('printkub.checkout_gateway','on',true);
  UPDATE public.print_jobs SET checkout_payment_provider='crypto' WHERE id=j;
  PERFORM set_config('printkub.checkout_gateway','off',true);
  INSERT INTO public.x402_delegated_purchases(policy_id,agent_id,request_id,request_payload,job_id)
    VALUES(pol.id,a.id,p_request_id,payload,j) RETURNING * INTO d;
  RETURN jsonb_build_object('purchase_id',d.id,'job_id',j,'agent_id',a.id,'grant_id',NULL);
END;
$$;
CREATE FUNCTION public.authorize_x402_delegated_purchase(p_principal uuid,p_purchase_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.x402_delegated_purchases; pol public.x402_purchase_policies;
  q public.x402_payment_quotes; j public.print_jobs; b public.x402_budgets; g uuid; allocated numeric;
BEGIN
  SELECT d0.* INTO STRICT d FROM public.x402_delegated_purchases d0 JOIN public.x402_agents a ON a.id=d0.agent_id
    WHERE d0.id=p_purchase_id AND a.auth_user_id=p_principal;
  SELECT * INTO STRICT j FROM public.print_jobs WHERE id=d.job_id FOR UPDATE;
  SELECT * INTO STRICT pol FROM public.x402_purchase_policies WHERE id=d.policy_id;
  SELECT * INTO STRICT b FROM public.x402_budgets WHERE id=pol.budget_id FOR UPDATE;
  SELECT * INTO STRICT pol FROM public.x402_purchase_policies WHERE id=d.policy_id FOR UPDATE;
  SELECT * INTO STRICT d FROM public.x402_delegated_purchases WHERE id=d.id FOR UPDATE;
  IF d.grant_id IS NOT NULL THEN RETURN d.grant_id; END IF;
  IF pol.revoked_at IS NOT NULL OR pol.expires_at<=now()
    OR NOT EXISTS (SELECT 1 FROM public.x402_agents a JOIN public.x402_customer_agents l ON l.auth_user_id=a.auth_user_id
      JOIN public.x402_agent_enrollments e ON e.auth_user_id=a.auth_user_id
      WHERE a.id=d.agent_id AND a.revoked_at IS NULL AND l.revoked_at IS NULL AND e.revoked_at IS NULL AND l.customer_id=pol.customer_id)
    THEN RAISE EXCEPTION 'purchase_policy_unavailable'; END IF;
  PERFORM id FROM public.user_profiles WHERE id=pol.customer_id FOR SHARE;
  IF pol.delivery->>'method'='shipping' AND pol.delivery IS DISTINCT FROM public.x402_saved_delivery(pol.customer_id)
    THEN RAISE EXCEPTION 'delivery_changed'; END IF;
  SELECT * INTO STRICT q FROM public.x402_payment_quotes WHERE job_id=j.id AND agent_id=d.agent_id AND expires_at>now()
    AND recipient=pol.recipient AND purchase_snapshot=public.x402_purchase_snapshot(j) ORDER BY created_at DESC LIMIT 1;
  SELECT COALESCE(sum(allocated_atomic),0) INTO allocated FROM public.x402_delegated_purchases WHERE policy_id=pol.id;
  IF q.amount_atomic>pol.max_order_atomic OR q.amount_atomic>b.limit_atomic-allocated
    OR q.amount_atomic>b.limit_atomic-b.spent_atomic-b.reserved_atomic OR b.expires_at<=now()
    OR j.user_id IS DISTINCT FROM pol.customer_id OR j.checkout_payment_provider IS DISTINCT FROM 'crypto'
    OR j.status IS DISTINCT FROM 'submitted' OR j.payment_status='paid' OR j.deleted_at IS NOT NULL OR j.coupon_returned_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.solana_payment_quotes WHERE job_id=j.id)
    OR EXISTS (SELECT 1 FROM public.crypto_order_payment_reservations WHERE job_id=j.id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE order_no=j.job_number)
    OR (SELECT count(*) FROM public.print_job_items WHERE job_id=j.id)<>1
    OR NOT EXISTS (SELECT 1 FROM public.print_job_items WHERE job_id=j.id AND creator_product_id=pol.product_id
      AND quantity=1 AND product_customization=pol.options)
    THEN RAISE EXCEPTION 'purchase_amount_or_scope_limit'; END IF;
  PERFORM public.assert_creator_crypto_eligible(j.id);
  INSERT INTO public.x402_grants(job_id,quote_id,customer_id,agent_id,budget_id,cap_atomic,expires_at)
    VALUES(j.id,q.id,pol.customer_id,d.agent_id,b.id,pol.max_order_atomic,LEAST(q.expires_at,pol.expires_at)) RETURNING id INTO g;
  -- Conservative authority: prepared orders consume count; issued grants consume
  -- cumulative allocation even if abandoned. Uncertain transfers never release it.
  UPDATE public.x402_delegated_purchases SET grant_id=g,allocated_atomic=q.amount_atomic WHERE id=d.id;
  RETURN g;
END;
$$;
-- Freeze the prepared purchase as well as granted orders: a customer cart edit
-- between preparation and quote must never change delegated authority.
CREATE OR REPLACE FUNCTION public.x402_purchase_locked(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.x402_delegated_purchases WHERE job_id=p_job_id)
    OR EXISTS (SELECT 1 FROM public.x402_grants WHERE job_id=p_job_id AND status='approved' AND expires_at>now())
    OR EXISTS (SELECT 1 FROM public.x402_payment_attempts WHERE job_id=p_job_id AND status IN ('reserved','settling','pending','confirmed'));
$$;
CREATE FUNCTION public.x402_delegated_status(p_request_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('request_id',d.request_id,'grant_id',d.grant_id,'order_no',j.job_number,
    'amount_atomic',d.allocated_atomic::text,'payment_status',j.payment_status,
    'status',COALESCE(t.status,'prepared'),'signature',t.signature)
  FROM public.x402_delegated_purchases d JOIN public.x402_agents a ON a.id=d.agent_id
    JOIN public.print_jobs j ON j.id=d.job_id LEFT JOIN public.x402_payment_attempts t ON t.grant_id=d.grant_id
  WHERE d.request_id=p_request_id AND (a.auth_user_id=auth.uid() OR j.user_id=auth.uid());
$$;
-- Revocation/expiry stops new reservations and payload acceptance, but does not
-- obstruct already dispatched settlement or recovery. The existing grant guards
-- also continue to apply to manually approved purchases.
CREATE FUNCTION public.guard_x402_standing_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.payload_fingerprint IS NOT NULL OR NEW.payload_fingerprint IS NULL THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF EXISTS (SELECT 1 FROM public.x402_delegated_purchases d JOIN public.x402_purchase_policies p ON p.id=d.policy_id
      WHERE d.grant_id=NEW.grant_id AND (p.revoked_at IS NOT NULL OR p.expires_at<=now()))
      THEN RAISE EXCEPTION 'purchase_policy_unavailable'; END IF;
    -- Lock consent through commit so revocation cannot race new authority.
    PERFORM p.id FROM public.x402_purchase_policies p JOIN public.x402_delegated_purchases d ON d.policy_id=p.id
      WHERE d.grant_id=NEW.grant_id FOR SHARE OF p;
    IF EXISTS (SELECT 1 FROM public.x402_delegated_purchases d JOIN public.x402_purchase_policies p ON p.id=d.policy_id
      WHERE d.grant_id=NEW.grant_id AND (p.revoked_at IS NOT NULL OR p.expires_at<=now()))
      THEN RAISE EXCEPTION 'purchase_policy_unavailable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER x402_standing_authority BEFORE INSERT OR UPDATE ON public.x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_x402_standing_authority();
REVOKE ALL ON FUNCTION public.x402_agent_catalog(uuid),public.x402_delegated_status(uuid),
  public.prepare_x402_delegated_purchase(uuid,uuid,uuid,integer,jsonb,jsonb),public.authorize_x402_delegated_purchase(uuid,uuid),
  public.guard_x402_standing_authority() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.x402_agent_catalog(uuid),public.x402_delegated_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_x402_delegated_purchase(uuid,uuid,uuid,integer,jsonb,jsonb),
  public.authorize_x402_delegated_purchase(uuid,uuid) TO service_role;
COMMIT;
