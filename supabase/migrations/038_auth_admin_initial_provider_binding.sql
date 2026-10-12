-- Supabase Auth admin.createUser inserts auth.users with its email-provider
-- metadata, then applies caller-supplied app_metadata in the same transaction.
-- Allow that first trusted binding; established identities remain immutable.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_auth_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_provider text; v_environment text := ''; v_subject text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.raw_app_meta_data->>'printkub_provider' IS NOT DISTINCT FROM OLD.raw_app_meta_data->>'printkub_provider'
      AND NEW.raw_app_meta_data->>'dynamic_environment_id' IS NOT DISTINCT FROM OLD.raw_app_meta_data->>'dynamic_environment_id'
      AND NEW.raw_app_meta_data->>'dynamic_subject' IS NOT DISTINCT FROM OLD.raw_app_meta_data->>'dynamic_subject'
      AND NEW.raw_app_meta_data->>'line_subject' IS NOT DISTINCT FROM OLD.raw_app_meta_data->>'line_subject' THEN
      RETURN NEW;
    END IF;

    IF OLD.raw_app_meta_data->>'printkub_provider' IS NOT NULL
      OR OLD.raw_app_meta_data->>'dynamic_environment_id' IS NOT NULL
      OR OLD.raw_app_meta_data->>'dynamic_subject' IS NOT NULL
      OR OLD.raw_app_meta_data->>'line_subject' IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.auth_provider_bindings WHERE user_id = NEW.id) THEN
      RAISE EXCEPTION 'provider_binding_immutable';
    END IF;

    -- app_metadata is controlled by Auth's admin API, not user_metadata.
    -- Only a previously unbound email identity with its unchanged internal
    -- email may receive its first LINE/Dynamic binding. Never convert OAuth.
    IF COALESCE(NEW.raw_app_meta_data->>'printkub_provider', '') NOT IN ('line', 'dynamic')
      OR NEW.email IS DISTINCT FROM OLD.email
      OR COALESCE(OLD.raw_app_meta_data->>'provider', '') <> 'email'
      OR COALESCE(NEW.raw_app_meta_data->>'provider', '') <> 'email'
      OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = NEW.id AND provider <> 'email') THEN
      RAISE EXCEPTION 'cross_provider_linking_forbidden';
    END IF;
  END IF;

  v_provider := NEW.raw_app_meta_data->>'printkub_provider';
  IF v_provider = 'dynamic' THEN
    v_environment := NEW.raw_app_meta_data->>'dynamic_environment_id';
    v_subject := NEW.raw_app_meta_data->>'dynamic_subject';
    IF COALESCE(v_environment, '') = '' OR COALESCE(v_subject, '') = ''
      OR COALESCE(NEW.email, '') NOT LIKE 'dynamic_%@auth.printkub.invalid' THEN
      RAISE EXCEPTION 'invalid_dynamic_binding';
    END IF;
  ELSIF v_provider = 'line' THEN
    v_subject := NEW.raw_app_meta_data->>'line_subject';
    IF COALESCE(v_subject, '') = ''
      OR NEW.email IS DISTINCT FROM 'line_' || v_subject || '@line.local' THEN
      RAISE EXCEPTION 'invalid_line_binding';
    END IF;
  ELSIF NEW.raw_app_meta_data->>'provider' = 'google' THEN
    v_provider := 'google'; v_subject := NEW.id::text;
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO public.auth_provider_bindings (user_id, provider, environment_id, external_subject)
    VALUES (NEW.id, v_provider, v_environment, v_subject);
  RETURN NEW;
END $$;

-- CREATE OR REPLACE preserves the existing trigger and restricted privileges.
COMMIT;
