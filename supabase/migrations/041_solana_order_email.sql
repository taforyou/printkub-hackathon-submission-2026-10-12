-- Service-only delivery state. Payment confirmation remains independent of email.
BEGIN;
ALTER TABLE public.solana_payment_quotes
  ADD COLUMN email_claimed_at timestamptz,
  ADD COLUMN email_sent_at timestamptz;
COMMENT ON COLUMN public.solana_payment_quotes.email_claimed_at IS
  'Five-minute notification lease; stale claims can be retried after worker failure.';
COMMENT ON COLUMN public.solana_payment_quotes.email_sent_at IS
  'Set only after Resend accepts the paid-order notification.';
COMMIT;
