-- Profile stores formatted Thai phone numbers. Canonicalize display separators
-- in the authoritative agent snapshot, preserving exact address/identity checks.
-- Do not alter saved profile data or existing consent records.
BEGIN;

CREATE OR REPLACE FUNCTION public.x402_saved_delivery(p_customer uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('method','shipping',
    'phone',regexp_replace(COALESCE(shipping_phone,phone),'[ -]','','g'),
    'address',jsonb_build_object('recipient_name',COALESCE(recipient_name,display_name),
      'line1',address_line1,'line2',address_line2,'subdistrict',subdistrict,
      'district',district,'province',province,'postal_code',postal_code))
  FROM public.user_profiles WHERE id = p_customer AND has_shipping_address;
$$;

-- This helper remains private; customer RPCs derive identity from auth.uid().
REVOKE ALL ON FUNCTION public.x402_saved_delivery(uuid) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
