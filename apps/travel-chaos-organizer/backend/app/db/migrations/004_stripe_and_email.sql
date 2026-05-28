-- Add stripe_customer_id to users table.
-- Used by payments.py to link Stripe customer to user in webhook handlers.
-- Missing column causes crash on every Stripe webhook (checkout, subscription cancel, renewal, payment failed).
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
