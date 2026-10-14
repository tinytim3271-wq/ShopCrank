-- No-op migration.
-- founding_invites.plan_id is now created in 0004_launch_plans.sql.
-- Keeping this file preserves migration ordering for environments that
-- already recorded 0007_founding_invite_plan.sql as applied.
SELECT 1;

