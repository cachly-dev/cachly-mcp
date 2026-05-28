-- Add telegram_chat_id column to users table.
-- This column was referenced in the application but missing from the initial schema.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
