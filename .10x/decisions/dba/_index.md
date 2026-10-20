# DBA — [DISCOVERED]
- D1 `shopcrank`, 19 migrations in worker/migrations. All apply cleanly to a fresh DB (verified 2026-10-20). Duplicate numeric prefixes (0005×2, 0007×3, 0008×2, 0012×2) work because they apply in filename order, but they're confusing. Use unique prefixes going forward.
- Generic `entities` table (shop_id, entity_type, entity_id, data_json, updated_at) with optimistic concurrency via updated_at.
