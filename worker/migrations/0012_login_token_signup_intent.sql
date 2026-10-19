-- Carry public signup plan/shop details through the magic-link email step.
ALTER TABLE login_tokens ADD COLUMN plan_id TEXT;
ALTER TABLE login_tokens ADD COLUMN shop_name TEXT;
ALTER TABLE login_tokens ADD COLUMN owner_name TEXT;
