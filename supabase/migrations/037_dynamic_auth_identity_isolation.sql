-- Separate authentication providers by their stable identities. Contact emails
-- may be shared by different users and must never resolve or link accounts.
BEGIN;

CREATE TABLE public.auth_provider_bindings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('line', 'google', 'dynamic')),
  environment_id text NOT NULL DEFAULT '',
  external_subject text NOT NULL,
  UNIQUE (provider, environment_id, external_subject)
);
ALTER TABLE public.auth_provider_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_provider_bindings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.auth_provider_bindings TO service_role;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.user_profiles
    WHERE (line_user_id IS NOT NULL OR providers ? 'line')
      AND (google_email IS NOT NULL OR providers ? 'google')) THEN
    RAISE EXCEPTION 'Resolve existing mixed-provider profiles before migration 037';
  END IF;
END $$;
-- A Google profile label alone is not evidence of a Google Auth identity.
-- LINE uses Supabase's email provider, including historical password accounts.
-- Preserve profile-based LINE bindings; bind Google only with an actual identity.
INSERT INTO public.auth_provider_bindings (user_id, provider, external_subject)
SELECT p.id, CASE WHEN p.line_user_id IS NOT NULL OR p.providers ? 'line' THEN 'line' ELSE 'google' END,
  CASE WHEN p.line_user_id IS NOT NULL OR p.providers ? 'line'
    THEN COALESCE(p.line_user_id, p.providers->'line'->>'userId') ELSE p.id::text END
FROM public.user_profiles p
WHERE (p.line_user_id IS NOT NULL OR p.google_email IS NOT NULL OR p.providers ? 'line' OR p.providers ? 'google')
  AND (p.line_user_id IS NOT NULL OR p.providers ? 'line'
    OR EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = p.id AND i.provider = 'google'));

-- Recover Auth users whose earlier bootstrap stopped before profile creation.
INSERT INTO public.auth_provider_bindings (user_id, provider, external_subject)
SELECT u.id, 'google', u.id::text FROM auth.users u
WHERE EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'google')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.auth_provider_bindings (user_id, provider, external_subject)
SELECT id, 'line', raw_user_meta_data->>'line_user_id' FROM auth.users
WHERE email = 'line_' || (raw_user_meta_data->>'line_user_id') || '@line.local'
  AND COALESCE(raw_user_meta_data->>'line_user_id', '') <> ''
ON CONFLICT (user_id) DO NOTHING;
-- Supabase can attach an email identity to an OAuth user. Remove only a
-- redundant, passwordless email identity belonging to the same Google account.
-- Never choose between external providers or discard a password login.
DO $$
DECLARE v_repair_ids uuid[]; v_conflicts text;
BEGIN
  SELECT array_agg(u.id) INTO v_repair_ids
  FROM auth.users u
  JOIN public.auth_provider_bindings b ON b.user_id = u.id AND b.provider = 'google'
  WHERE u.raw_app_meta_data->>'provider' = 'google'
    AND COALESCE(u.encrypted_password, '') = ''
    AND COALESCE(btrim(u.email), '') <> ''
    AND EXISTS (SELECT 1 FROM auth.identities g WHERE g.user_id = u.id AND g.provider = 'google'
      AND g.identity_data->>'email_verified' = 'true'
      AND lower(btrim(g.identity_data->>'email')) = lower(btrim(u.email)))
    AND EXISTS (SELECT 1 FROM auth.identities e WHERE e.user_id = u.id AND e.provider = 'email')
    AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id
      AND i.provider <> 'google'
      AND (i.provider <> 'email'
        OR (i.identity_data->>'sub') IS DISTINCT FROM u.id::text
        OR lower(btrim(i.identity_data->>'email')) IS DISTINCT FROM lower(btrim(u.email))));

  SELECT string_agg(c.user_id::text || ' (' || c.provider || ' -> ' || c.expected || ')', ', ')
    INTO v_conflicts
  FROM (
    SELECT i.user_id, i.provider, CASE WHEN b.provider = 'google' THEN 'google' ELSE 'email' END AS expected
    FROM auth.identities i JOIN public.auth_provider_bindings b ON b.user_id = i.user_id
    WHERE i.provider <> CASE WHEN b.provider = 'google' THEN 'google' ELSE 'email' END
      AND NOT (i.user_id = ANY(COALESCE(v_repair_ids, ARRAY[]::uuid[])))
    ORDER BY i.user_id, i.provider LIMIT 20
  ) c;
  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Resolve existing cross-provider Auth identities before migration 037'
      USING DETAIL = v_conflicts,
        HINT = 'Inspect supabase/scripts/inspect_auth_identity_conflicts.sql. Password logins, mismatched emails, and external-provider links require owner review.';
  END IF;

  DELETE FROM auth.identities WHERE provider = 'email'
    AND user_id = ANY(COALESCE(v_repair_ids, ARRAY[]::uuid[]));
  UPDATE auth.users
    SET raw_app_meta_data = jsonb_set(raw_app_meta_data, '{providers}', '["google"]'::jsonb)
    WHERE id = ANY(COALESCE(v_repair_ids, ARRAY[]::uuid[]));
END $$;

CREATE FUNCTION public.register_auth_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_provider text; v_environment text := ''; v_subject text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.raw_app_meta_data->>'printkub_provider' IS DISTINCT FROM OLD.raw_app_meta_data->>'printkub_provider'
      OR NEW.raw_app_meta_data->>'dynamic_environment_id' IS DISTINCT FROM OLD.raw_app_meta_data->>'dynamic_environment_id'
      OR NEW.raw_app_meta_data->>'dynamic_subject' IS DISTINCT FROM OLD.raw_app_meta_data->>'dynamic_subject' THEN
      RAISE EXCEPTION 'provider_binding_immutable';
    END IF;
    RETURN NEW;
  END IF;
  v_provider := NEW.raw_app_meta_data->>'printkub_provider';
  IF v_provider = 'dynamic' THEN
    v_environment := NEW.raw_app_meta_data->>'dynamic_environment_id';
    v_subject := NEW.raw_app_meta_data->>'dynamic_subject';
    IF COALESCE(v_environment, '') = '' OR COALESCE(v_subject, '') = ''
      OR NEW.email NOT LIKE 'dynamic_%@auth.printkub.invalid' THEN
      RAISE EXCEPTION 'invalid_dynamic_binding';
    END IF;
  ELSIF v_provider = 'line' THEN
    v_subject := NEW.raw_app_meta_data->>'line_subject';
    IF COALESCE(v_subject, '') = '' THEN RAISE EXCEPTION 'invalid_line_binding'; END IF;
  ELSIF NEW.raw_app_meta_data->>'provider' = 'google' THEN
    v_provider := 'google'; v_subject := NEW.id::text;
  ELSE
    RETURN NEW; -- Existing developer/password accounts are not external users.
  END IF;
  INSERT INTO public.auth_provider_bindings VALUES (NEW.id, v_provider, v_environment, v_subject);
  RETURN NEW;
END $$;
CREATE TRIGGER printkub_auth_provider AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.register_auth_provider();

CREATE FUNCTION public.reject_cross_provider_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_provider text;
BEGIN
  SELECT provider INTO v_provider FROM public.auth_provider_bindings WHERE user_id = NEW.user_id;
  IF v_provider IS NOT NULL AND NEW.provider <> (CASE WHEN v_provider = 'google' THEN 'google' ELSE 'email' END) THEN
    RAISE EXCEPTION 'cross_provider_linking_forbidden';
  END IF;
  IF v_provider IS NULL AND EXISTS (SELECT 1 FROM auth.identities
    WHERE user_id = NEW.user_id AND provider <> NEW.provider) THEN
    RAISE EXCEPTION 'cross_provider_linking_forbidden';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER printkub_single_auth_provider BEFORE INSERT OR UPDATE ON auth.identities
FOR EACH ROW EXECUTE FUNCTION public.reject_cross_provider_identity();

CREATE TABLE public.profile_email_bindings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  -- Legacy contact data is retained without claiming it was OTP-verified.
  verified_at timestamptz,
  PRIMARY KEY (user_id, email)
);
ALTER TABLE public.profile_email_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_email_bindings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.profile_email_bindings TO service_role;

CREATE FUNCTION public.sync_profile_email_bindings(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_emails text[]; v_email text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 37));
  SELECT array_agg(DISTINCT lower(btrim(e)) ORDER BY lower(btrim(e))) INTO v_emails
  FROM (
    SELECT email AS e FROM auth.users WHERE id = p_user_id
      AND email NOT LIKE '%@line.local' AND email NOT LIKE '%@auth.printkub.invalid'
    UNION ALL SELECT email FROM public.user_profiles WHERE id = p_user_id
    UNION ALL SELECT google_email FROM public.user_profiles WHERE id = p_user_id
    UNION ALL SELECT providers->'line'->>'email' FROM public.user_profiles WHERE id = p_user_id
    UNION ALL SELECT providers->'dynamic'->>'email' FROM public.user_profiles WHERE id = p_user_id
  ) candidates WHERE COALESCE(btrim(e), '') <> '';
  FOREACH v_email IN ARRAY COALESCE(v_emails, ARRAY[]::text[]) LOOP
    INSERT INTO public.profile_email_bindings (user_id, email) VALUES (p_user_id, v_email)
      ON CONFLICT (user_id, email) DO NOTHING;
  END LOOP;
  DELETE FROM public.profile_email_bindings
    WHERE user_id = p_user_id AND NOT (email = ANY(COALESCE(v_emails, ARRAY[]::text[])));
END $$;
CREATE FUNCTION public.enforce_profile_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_provider text;
BEGIN
  SELECT provider INTO v_provider FROM public.auth_provider_bindings WHERE user_id = NEW.id;
  IF (v_provider <> 'line' AND (NEW.line_user_id IS NOT NULL OR NEW.providers ? 'line'))
    OR (v_provider <> 'google' AND (NEW.google_email IS NOT NULL OR NEW.providers ? 'google'))
    OR (v_provider <> 'dynamic' AND NEW.providers ? 'dynamic') THEN
    RAISE EXCEPTION 'cross_provider_linking_forbidden';
  END IF;
  IF NEW.email IS NOT NULL THEN NEW.email := NULLIF(lower(btrim(NEW.email)), ''); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_identity_guard BEFORE INSERT OR UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_identity();
CREATE FUNCTION public.sync_user_email_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM public.sync_profile_email_bindings(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER profile_sync_emails AFTER INSERT OR UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_user_email_trigger();
CREATE TRIGGER auth_sync_emails AFTER INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_email_trigger();
DO $$ DECLARE v_id uuid; BEGIN
  FOR v_id IN SELECT id FROM auth.users ORDER BY id LOOP
    PERFORM public.sync_profile_email_bindings(v_id);
  END LOOP;
END $$;
-- Email ownership must be verified by a server challenge, not a profile PATCH.
REVOKE UPDATE (email) ON public.user_profiles FROM authenticated;

CREATE FUNCTION public.find_dynamic_auth_user(p_environment_id text, p_subject text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT user_id FROM public.auth_provider_bindings
  WHERE provider = 'dynamic' AND environment_id = p_environment_id AND external_subject = p_subject;
$$;
CREATE FUNCTION public.provision_dynamic_profile(p_environment_id text, p_subject text, p_verified_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  SELECT user_id INTO v_id FROM public.auth_provider_bindings
  WHERE provider = 'dynamic' AND environment_id = p_environment_id AND external_subject = p_subject FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'dynamic_identity_missing'; END IF;
  INSERT INTO public.user_profiles (id, display_name, roles, active_role, email, providers, last_login)
    VALUES (v_id, 'Dynamic User', ARRAY['user'], 'user', p_verified_email,
      jsonb_build_object('dynamic', jsonb_build_object('environmentId', p_environment_id,
        'subject', p_subject, 'email', p_verified_email, 'linkedAt', now(), 'lastLogin', now())), now())
    ON CONFLICT (id) DO UPDATE SET last_login = now(),
      -- A wallet-only login must not clear an email already verified in PrintKub.
      email = COALESCE(EXCLUDED.email, public.user_profiles.email),
      providers = jsonb_build_object('dynamic', jsonb_build_object('environmentId', p_environment_id,
        'subject', p_subject, 'email', p_verified_email,
        'linkedAt', public.user_profiles.providers->'dynamic'->>'linkedAt', 'lastLogin', now()));
  IF COALESCE(btrim(p_verified_email), '') <> '' THEN
    INSERT INTO public.profile_email_bindings (user_id, email, verified_at)
      VALUES (v_id, lower(btrim(p_verified_email)), now())
      ON CONFLICT (user_id, email) DO UPDATE SET verified_at = EXCLUDED.verified_at;
  END IF;
  RETURN v_id;
END $$;

CREATE TABLE public.dynamic_login_limits (
  environment_id text NOT NULL,
  external_subject text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY (environment_id, external_subject)
);
ALTER TABLE public.dynamic_login_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dynamic_login_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dynamic_login_limits TO service_role;
CREATE FUNCTION public.limit_dynamic_login(p_environment_id text, p_subject text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempts integer;
BEGIN
  INSERT INTO public.dynamic_login_limits AS l (environment_id, external_subject)
    VALUES (p_environment_id, p_subject)
    ON CONFLICT (environment_id, external_subject) DO UPDATE SET
      window_start = CASE WHEN l.window_start < now() - interval '1 minute' THEN now() ELSE l.window_start END,
      attempts = CASE WHEN l.window_start < now() - interval '1 minute' THEN 1 ELSE l.attempts + 1 END
    RETURNING attempts INTO v_attempts;
  IF v_attempts > 10 THEN RAISE EXCEPTION 'login_rate_limited'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.limit_dynamic_login(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.limit_dynamic_login(text,text) TO service_role;

-- Per-account email OTPs, never Auth identity changes or account linking.
CREATE TABLE public.profile_email_challenges (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
ALTER TABLE public.profile_email_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_email_challenges FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.profile_email_challenges TO service_role;
CREATE FUNCTION public.request_profile_email(p_user_id uuid, p_email text, p_code_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 38));
  IF EXISTS (SELECT 1 FROM public.profile_email_challenges WHERE user_id = p_user_id AND sent_at > now() - interval '60 seconds') THEN
    RAISE EXCEPTION 'email_rate_limited';
  END IF;
  INSERT INTO public.profile_email_challenges (user_id, email, code_hash, expires_at)
  VALUES (p_user_id, p_email, p_code_hash, now() + interval '10 minutes')
  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, code_hash = EXCLUDED.code_hash,
    expires_at = EXCLUDED.expires_at, sent_at = now(), attempts = 0;
END $$;
CREATE FUNCTION public.verify_profile_email(p_user_id uuid, p_code_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_challenge public.profile_email_challenges;
BEGIN
  SELECT * INTO v_challenge FROM public.profile_email_challenges WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_challenge.expires_at <= now() OR v_challenge.attempts >= 5 THEN RETURN false; END IF;
  UPDATE public.profile_email_challenges SET attempts = attempts + 1 WHERE user_id = p_user_id;
  IF v_challenge.code_hash <> p_code_hash THEN RETURN false; END IF;
  UPDATE public.user_profiles SET email = v_challenge.email WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.profile_email_bindings (user_id, email, verified_at)
    VALUES (p_user_id, lower(btrim(v_challenge.email)), now())
    ON CONFLICT (user_id, email) DO UPDATE SET verified_at = EXCLUDED.verified_at;
  DELETE FROM public.profile_email_challenges WHERE user_id = p_user_id;
  RETURN true;
END $$;

-- All identity and challenge operations are callable only by verified Edge Functions.
REVOKE ALL ON FUNCTION public.register_auth_provider(), public.reject_cross_provider_identity(),
  public.enforce_profile_identity(), public.sync_user_email_trigger(),
  public.sync_profile_email_bindings(uuid), public.find_dynamic_auth_user(text,text),
  public.provision_dynamic_profile(text,text,text), public.request_profile_email(uuid,text,text),
  public.verify_profile_email(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_dynamic_auth_user(text,text),
  public.provision_dynamic_profile(text,text,text), public.request_profile_email(uuid,text,text),
  public.verify_profile_email(uuid,text) TO service_role;
COMMIT;
