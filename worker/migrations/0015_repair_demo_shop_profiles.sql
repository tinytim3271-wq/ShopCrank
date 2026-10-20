-- Repair shop profiles that were saved with the client's demo defaults
-- ("Your Car Guy", 100 Demo Street, 555-0100, Reliable logo) before ADR-002.
-- Only rows still holding BOTH the exact demo address and demo phone are touched.
-- The shop name is replaced only if it is still the demo name; the logo only if
-- it is still the demo logo. Every other profile is left as-is.
UPDATE entities
SET
  data_json = json_set(
    data_json,
    '$.shopName', CASE
      WHEN json_extract(data_json, '$.shopName') = 'Your Car Guy'
        THEN COALESCE((SELECT name FROM shops WHERE shops.id = entities.shop_id), '')
      ELSE json_extract(data_json, '$.shopName')
    END,
    '$.phone', '',
    '$.address', '',
    '$.logoUrl', CASE
      WHEN COALESCE(json_extract(data_json, '$.logoUrl'), '') LIKE '%/assets/reliable-logo.jpg'
        THEN ''
      ELSE json_extract(data_json, '$.logoUrl')
    END,
    '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE entity_type = 'shopsettings'
  AND entity_id = 'profile'
  AND json_extract(data_json, '$.address') = '100 Demo Street, Example City, TX 00000'
  AND json_extract(data_json, '$.phone') = '555-0100';

-- The demo street address is never a real shop address: blank it wherever it
-- remains (e.g. an owner who changed only the phone and name).
UPDATE entities
SET
  data_json = json_set(data_json, '$.address', '', '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE entity_type = 'shopsettings'
  AND entity_id = 'profile'
  AND json_extract(data_json, '$.address') = '100 Demo Street, Example City, TX 00000';
