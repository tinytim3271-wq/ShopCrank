# ARI → ShopCrank customer field mapping

**Prepared for:** Timothy Alderman
**Scope:** customer records only
**ShopCrank revision reviewed:** `7790dfb630576a692b53a45e76c5eaf554daadae` (`main`)
**Mode:** report/dry run only; no schema change, migration, import code, or data transfer

## Executive summary

ShopCrank can directly receive only a small customer core today: name, one phone number, one email address, one combined billing address, and billing notes. It also carries three customer summary counters (`vehicles`, `visits`, and `spend`) plus record/audit metadata.

ARI publicly documents a richer client record and workflow: contact import, address and shipping-location data, geolocation, notes, labels, lead source, customer Tax ID, tax exemption, client discount, labor-rate override, parts-markup override, and payment-terms override. Those richer values have no customer-level ShopCrank destination. ARI also documents client list exports to Excel/CSV, but no public, customer-record API schema or direct database schema was found.

The safe next step is to obtain Timothy's actual **Clients** CSV/Excel export (headers plus a few redacted rows). Until that exists, this is a capability mapping, not a transfer specification.

## Evidence and confidence

- **ShopCrank:** verified from D1 migrations, Worker entity handling, frontend customer create/edit forms, and CSV import code at the revision above.
- **ARI:** verified where possible from ARI's public product/update pages, linked in [Sources](#sources). ARI's pages describe capabilities but generally do not publish exact export column names, types, nullability, or enum values.
- **Not available:** no Timothy-specific ARI export, API response, database extract, field dictionary, or ARI file appears in this repository.
- **Terminology:** ARI calls these records “clients”; ShopCrank calls them “customers.”

### Product identity warning

This report maps **ARI (Auto Repair Software) at `ari.app`**, because its documented client screen matches the requested actions and overrides. **ARI Network Services at `arinet.com` is a different product family.** Its former FootSteps lead-management CRM is retired, and ARI Network's publicly advertised DataSmart API is for OEM/aftermarket catalog data rather than customer records. If Timothy means an ARI Network/Dealer Spike product instead of the `ari.app` shop-management application, this mapping must be re-scoped against the exact product and export.

### Named desktop customer test case

The screenshot supplied with the October 5 update does **not** show a ShopCrank customer screen. It shows a browser open to a Cursor “Failed build installation” run for a ShopCrank repository; no customer name, phone, email, address, customer form, or ARI identifier is visible. Therefore:

| Test-case input | Available? | Result |
|---|---:|---|
| ShopCrank customer identity from screenshot | No | No specific ShopCrank customer can be selected safely. |
| ARI account/export access | No | No ARI record can be looked up or matched. |
| Same-customer comparison | Blocked by missing identity/data | Do not infer the customer from ShopCrank demo/seed records. |

To complete the record-level match, Timothy should provide either (a) a clear screenshot of the ShopCrank customer detail/edit screen showing the customer name and distinguishing contact data, or (b) the exact ShopCrank customer name/ID, plus the corresponding redacted ARI Clients export row. Until then, the tables below are schema/capability mappings only.

## 1. How ShopCrank stores customers

ShopCrank has no dedicated D1 `customers` table. All operational records use the generic `entities` table:

| D1 column | D1 type / requirement | Customer meaning |
|---|---|---|
| `shop_id` | `TEXT NOT NULL` | Tenant partition; copied into returned JSON as `shopId`. |
| `entity_type` | `TEXT NOT NULL` | Literal `customers` for these records. |
| `entity_id` | `TEXT NOT NULL` | Customer key; copied into returned JSON as `id`. |
| `data_json` | `TEXT NOT NULL`, valid JSON | Entire customer payload. There is no D1-enforced customer JSON schema. |
| `created_by` | `TEXT NOT NULL` | Audit actor; copied into JSON as `createdBy`. |
| `created_at` | `TEXT NOT NULL` | Creation timestamp; copied into JSON as `createdAt`. |
| `updated_at` | `TEXT NOT NULL` | Last-write timestamp; copied into JSON as `updatedAt`. |

`(shop_id, entity_type, entity_id)` is the primary key. The Worker accepts arbitrary additional JSON properties, then overwrites/adds `id`, `shopId`, `createdBy`, `createdAt`, and `updatedAt`. Consequently, an unknown ARI field could technically be stored in `data_json`, but it is **not a supported ShopCrank field** unless code defines its meaning and UI behavior. This report does not recommend relying on undeclared properties.

### API behavior

- Endpoints are `GET/POST /api/entities/customers` and `GET/PUT/DELETE /api/entities/customers/:id`.
- On `POST`, the Worker chooses `body.id`, otherwise `body.name`, otherwise a UUID as the entity key. It does not validate that `name` exists or is unique.
- The customer UI generates a UUID for new records and requires a name. It also blocks case-insensitive duplicate names in the currently loaded client state.
- Customer writes are full JSON-object replacements at the application level, not field-level patches.
- Legacy payload aliases are normalized: `address` populates `billingAddress`; `created_at`/`updated_at` populate camel-case timestamps. The original properties remain because normalization spreads the original payload.
- Customer deletion is blocked when vehicles, work orders, or invoices refer to the customer's **name**. Those relationships are name-based rather than ID-based.
- Renaming a customer does not rewrite linked records; the UI explicitly warns that links retain the old name.
- The customer detail “Save billing” path addresses the API by customer name, while the current create/edit path uses `id`. For UUID-keyed customers, that older detail action may not target the same entity. This should be resolved before any migration acceptance test, but it is outside this report-only task.

## 2. Existing ShopCrank customer fields

### Supported business fields

| ShopCrank JSON field | Type used in code | Required? | Create/edit UI | Notes |
|---|---|---:|---:|---|
| `name` | string | **UI and CSV: yes; API/D1: no** | Yes | Display name and current relationship key. UI uses trimmed text; no explicit maximum length. |
| `phone` | string | No | Yes | One free-text number. Customer CSV import accepts `phone` or `mobile` and truncates to 40 characters. |
| `email` | string | No | Yes | Browser form uses `type=email`. CSV import truncates to 120 characters but does not otherwise validate. One address only. |
| `billingAddress` | string | No | Yes | One unstructured textarea. Legacy API input `address` is copied here. Printed invoices use this value. |
| `billingNotes` | string | No | Yes | One unstructured textarea. No explicit maximum length in the customer form. |
| `vehicles` | number | No; defaults to `0` on create/import | No | Stored summary/cache value. Cards fall back to counting linked vehicles when the value is falsy; it is not a canonical relationship field. |
| `visits` | number | No; defaults to `0` on create/import | No | Stored display statistic. No customer-form control and no verified automatic maintenance path. |
| `spend` | number | No; defaults to `0` on create/import | No | Stored lifetime-spend display statistic. It is separate from the balance derived from invoices/payments and has no customer-form control. |

### Record and audit fields

| ShopCrank JSON field | Type used in code | Required? | Source / behavior |
|---|---|---:|---|
| `id` | string | Effectively yes after save | UUID generated by current UI; API falls back to name or UUID and overwrites payload `id` with the URL/entity key. |
| `shopId` | string | Server-added | Current authenticated tenant; client-supplied value is overwritten. |
| `createdBy` | string | Server-added | Authenticated actor; preserved from the existing D1 row on update. |
| `createdAt` | ISO timestamp string by convention | Server-added | UI sets it for current form-created records; otherwise Worker uses existing D1 time or now. Client input can supply it. |
| `updatedAt` | ISO timestamp string by convention | Server-added | Worker always replaces it with current server time. Also used for offline conflict handling. |

### Derived customer-screen values (not customer fields)

- `balance` is calculated from invoices and completed payments.
- Vehicle, work-order, invoice, payment, and statement sections are derived by matching customer name.
- “Message” uses `phone`/`email`; it is an action, not stored customer preference.
- Customer CSV import currently accepts only `name`, `phone`/`mobile`, and `email`. It does **not** import `billingAddress`, `billingNotes`, IDs, overrides, or metadata.

## 3. What ARI publicly exposes

### Verified public capabilities

ARI's public pages verify that client records/workflows can include:

- name and contact information;
- email;
- address;
- shipping location;
- geolocation;
- notes and searchable custom labels;
- lead/source information (examples: Social Media, Referral, Google);
- tax-exempt setting;
- customer Tax ID (VAT);
- client discount;
- labor-rate override;
- parts-markup override;
- payment-terms override (publisher release notes also give examples such as Net 30 and Due on Receipt);
- ID Scan, Contact Import, and phone actions;
- opening a client location in Google Maps;
- client statements, vehicles, invoices, estimates, messages, and portal access.

ARI documents two export routes:

1. `Reports → Data Export → Clients → Generate Report`, then export to Excel (the same article describes the underlying regular format as CSV) or PDF.
2. The Clients grid/table view can export the full list to Excel.

The public material does **not** establish:

- exact customer export headers or data types;
- whether every setting above is included in the Clients export;
- a public ARI customer API endpoint or payload schema;
- direct access to ARI's internal database schema;
- whether phone/email/address are singular, repeated, or split into components in Timothy's account;
- whether Tax ID, payment terms, or any other override is included in the Clients export and, if so, its exact representation.

For this reason, “typical ARI field” below means a publicly documented capability, not a guaranteed column in Timothy's file.

## 4. ARI → ShopCrank field mapping

| ARI customer data/capability | Evidence level | ShopCrank destination | Fit | Mapping note |
|---|---|---|---|---|
| ARI client ID | Expected in a system/export, but public header unverified | `id` | Conditional | Preserve only after seeing the actual value format. A namespaced ID such as `ari:<id>` would avoid collisions, but no import convention exists today. |
| Name / client name | Verified capability | `name` | Direct | Required by ShopCrank UI/import. Confirm whether ARI separates person/company or first/last name before concatenating. |
| Phone / contact info | Verified capability | `phone` | Lossy | ShopCrank supports one free-text phone. Determine preferred number and retain type/extension somewhere only if Timothy's export includes multiples. |
| Email | Verified capability | `email` | Direct if singular | ShopCrank supports one email. Choose a primary address if ARI exports more than one. |
| Address | Verified capability | `billingAddress` | Lossy | Combine ARI address components with a stable format. ShopCrank has no structured street/city/state/postal/country fields. |
| Shipping location | Verified capability | None | Gap | Do not silently merge into billing address unless Timothy confirms they are equivalent. |
| Geolocation | Verified capability | None | Gap | No latitude/longitude or place identifier. |
| Notes | Verified capability | `billingNotes` | Approximate | Semantics may be broader than “billing.” Confirm that operational/sensitive notes are appropriate to copy. |
| Labels/tags | Verified capability | None | Gap | Flattening into notes would destroy filterability; avoid without approval. |
| Customer source / lead source | Verified capability and report export | None | Gap | Public ARI documentation says source is exportable through Client Reports, but the exact header is unknown. |
| Tax exempt | Verified per-client setting | None | Gap | ShopCrank has shop/invoice tax controls, not a customer exemption field or automatic exemption behavior. |
| Customer Tax ID / VAT ID | Publisher-documented field; export header unverified | None | Gap | ShopCrank's `taxId` is a shop filing setting, not a customer field, and must not be used for this value. |
| Client discount | Verified per-client setting | None | Gap | ShopCrank supports estimate-level discounts and shop coupons, not a persistent customer default. |
| Labor rate override | Verified per-client setting | None | Gap | ShopCrank has a shop default and line-level labor rate, not a customer override. |
| Parts markup override | Verified per-client setting | None | Gap | ShopCrank has line prices and shop purchasing/vendor settings, not customer-level markup. |
| Payment terms override | Publisher-documented per-client setting; export header unverified | None | Gap | ShopCrank generates invoice due dates (currently 14 days in one workflow) but has no customer terms field. Confirm the exported value/unit/enum. |
| Created date | Plausible export field; unverified | `createdAt` | Conditional | Importing source provenance into server audit metadata needs an explicit policy. The Worker accepts client `createdAt`; do not use it until agreed. |
| Modified date | Plausible export field; unverified | `updatedAt` | No direct import | Worker overwrites `updatedAt` on save. A source-modified timestamp would need a separate supported field. |
| Total invoiced / paid / due | Verified on ARI client details, not verified in export | `spend` and derived balance | Unsafe | Definitions may differ. Recompute from later invoice/payment migration rather than copying into customer master data. |
| Vehicle/visit counts | Client relationships are verified; count columns unverified | `vehicles`, `visits` | Unsafe | Recompute after future vehicle/work-order migration; do not treat ARI summary counts as canonical now. |
| Client portal ID/password/access | Verified workflow | None | Do not map | Credentials/access keys must not be copied into notes or generic JSON. |

## 5. ShopCrank gaps

### ARI data with no ShopCrank home

| ARI data | ARI evidence | Why it has no safe ShopCrank destination |
|---|---|---|
| Additional/typed phone numbers or emails | ARI documents contact information; multiplicity/export shape unverified | ShopCrank has one `phone` and one `email`. |
| Structured address components | ARI documents address; export shape unverified | ShopCrank has one unstructured `billingAddress`. |
| Shipping/service location | Verified ARI capability | It must not be silently merged into billing address. |
| Geolocation | Verified ARI capability | ShopCrank has no latitude, longitude, place ID, or equivalent. |
| Labels/tags | Verified ARI capability | `billingNotes` would lose search/filter semantics. |
| Customer source | Verified and documented as report-exportable | ShopCrank has no acquisition-source field. |
| Customer Tax ID/VAT ID | Publisher-documented ARI field | ShopCrank's existing `taxId` is shop-level, not customer-level. |
| Tax-exempt setting/details | Verified per-client ARI setting | ShopCrank has no customer exemption/default behavior. |
| Customer discount | Verified per-client ARI setting | ShopCrank discounts/coupons are estimate/shop scoped. |
| Labor-rate override | Verified per-client ARI setting | ShopCrank rates are shop/line scoped. |
| Parts-markup override | Verified per-client ARI setting | ShopCrank has no customer markup policy. |
| Payment-terms override | Publisher-documented per-client ARI setting | ShopCrank has invoice due dates but no customer terms default. |
| ARI source ID and source timestamps | Plausible but exact export fields unverified | ShopCrank has no supported external-ID/provenance fields; its timestamps are ShopCrank audit metadata. |
| Portal credentials/access keys | Verified ARI workflow | Must not be copied into customer notes or generic JSON. |

### Data-model gaps

1. Structured address fields and separate billing/shipping addresses.
2. Latitude/longitude or another geolocation representation.
3. Multiple typed phone numbers and email addresses, including a preferred-contact marker.
4. Customer labels/tags.
5. Customer acquisition source.
6. Customer Tax ID/VAT ID.
7. Tax-exempt status and, likely, exemption certificate/identifier/effective dates.
8. Persistent customer discount (including percentage vs flat amount and applicability).
9. Customer labor-rate override.
10. Customer parts-markup override.
11. Customer payment-terms override.
12. Source-system ID and source-created/source-modified timestamps distinct from ShopCrank audit metadata.
13. A semantically general customer-notes field; `billingNotes` is the only current destination.

### Import/behavior gaps

1. The customer CSV importer ignores address and notes even though ShopCrank already supports those fields.
2. There is no saved external-ID deduplication key; current duplicate checking is name-based.
3. Customer links use mutable names instead of `id`, making renames and same-name customers risky.
4. The Worker has no customer payload schema, required-field validation, length limits, or type validation.
5. There is no migration reconciliation report for duplicate names, multi-valued contacts, or rejected fields.

These are findings only. This branch intentionally adds none of the missing fields or behaviors.

## 6. Requested customer-screen feature map

“ARI can supply?” distinguishes a documented ARI screen capability from a value proven to be present in Timothy's export. None of the exact export columns are proven without his file.

| Customer-screen action/setting | ShopCrank implemented? | Can ARI supply the capability? | Can ARI supply transferable data now? | Finding |
|---|---|---|---|---|
| **Scan ID** | **No** | **Yes, action verified** | **Unknown** | ARI calls it “ID Scan” and publisher notes mention driver-license AI extraction. Public material does not define retained/exported identity fields. ShopCrank's VIN scan is a vehicle function, not an equivalent. |
| **Import Contacts** | **Partial, not equivalent** | **Yes, verified** | **Core contact values likely; exact export unverified** | ShopCrank has a global CSV customer import for name/phone/email, but no customer-screen device-contact action. ARI imports device contacts and stores resulting client details. |
| **Call Number** | **No direct call action** | **Yes, verified** | **Phone likely; exact header unverified** | ShopCrank stores/displays one phone and can prepare a message, but no customer `tel:`/dial action was found. |
| **Get Address** | **No** | **Yes, verified** | **Address likely; exact shape unverified** | ShopCrank provides a manual billing-address textarea. ARI documents current-address recognition/population. |
| **Navigate** | **No** | **Yes, verified** | **Location/geolocation export unknown** | No Maps/navigation action or stored geolocation exists in ShopCrank. ARI can open the client location in Google Maps. |
| **Tax Exempt** | **No customer setting** | **Yes, verified** | **Export presence/value unknown** | ShopCrank can edit tax at invoice/shop level, but has no persistent customer exemption or automatic behavior. |
| **Apply Discount** | **Partial, not customer-level** | **Yes, verified** | **Export presence/type/value unknown** | ShopCrank supports estimate discounts and shop coupons. It has no customer default/toggle. |
| **Labor Rate Override** | **No customer setting** | **Yes, verified** | **Export presence/reference/value unknown** | ShopCrank has shop-default and estimate-line labor rates only. |
| **Parts Markup Override** | **No customer setting** | **Yes, verified** | **Export presence/reference/value unknown** | ShopCrank supports entered part prices but no customer-level markup policy. |
| **Payment Terms Override** | **No customer setting** | **Yes, publisher-documented** | **Export presence/value unknown** | ARI release notes list a per-client override and describe terms such as Net 30 and Due on Receipt. ShopCrank has no customer terms default. |

## 7. Proposed review-only disposition

If Timothy supplies an export, classify each incoming column before any implementation:

- **Map now:** `name`, one selected `phone`, one selected `email`, combined address → `billingAddress`, approved notes → `billingNotes`.
- **Hold for product decision:** external ID, structured/multiple contacts, shipping address, geolocation, labels, source, customer Tax ID, tax exemption, discount, labor/parts overrides, and payment terms.
- **Recompute later:** vehicle count, visits, spend, invoiced/paid/due totals.
- **Never import as customer notes:** passwords, portal access keys, payment credentials, or other secrets.

No transfer should proceed merely because D1's JSON column can accept an undeclared property. Each retained ARI field needs an agreed ShopCrank meaning, validation rule, and UI behavior first.

## 8. Open questions for Timothy

1. Which ShopCrank customer is the desktop test case? Please provide the exact name/ID or a customer-detail screenshot; the supplied screenshot only shows a Cursor failed-build page.
2. Can you provide that customer's redacted ARI Clients export row plus the export headers, along with 3–5 other representative rows (individual, fleet/company, tax-exempt, and override-bearing clients if possible)?
3. Confirm the product identity: is this **ARI (Auto Repair Software) from `ari.app`**, or an **ARI Network Services/Dealer Spike** product? Which version and platform produced the data?
4. Is there an ARI API agreement or private API documentation for this shop? If yes, provide a redacted customer response/schema and authentication-independent field documentation.
5. Does the export include a stable client ID? Is that ID visible in ARI and preserved across exports?
6. Does ARI split names into first/last/company fields, and can a company have multiple contacts?
7. Can clients have multiple phones/emails? Which types and preferred-contact flags should ShopCrank retain?
8. Are billing address, shipping/service location, and geolocation separate in the export? Which should appear on ShopCrank invoices?
9. What do ARI's per-client discount and override values contain: enabled flag only, percent/amount, named rate/markup tier, or explicit numeric value?
10. Does **Payment Terms Override** appear in Timothy's export, and how is it encoded (for example Due on Receipt, Net 15, Net 30, or a day count)?
11. Does the Clients export contain the customer Tax ID/VAT field documented in ARI's release notes?
12. For tax-exempt clients, does the export include only a boolean or also exemption number, jurisdiction, certificate, and expiry?
13. Should ARI labels and source remain searchable after migration? If so, they should not be flattened into billing notes.
14. Should ARI notes be copied at all, and do they contain sensitive data that requires exclusion or access controls?
15. Are `vehicles`, `visits`, and `spend` expected in the customer-only phase, or should they be recomputed after vehicles/work orders/invoices are mapped later?
16. How should duplicates be resolved when customers share a name or when the same person appears under multiple ARI records?

## Sources

### ShopCrank repository

- D1 generic entity storage: [`worker/migrations/0001_initial.sql`](../worker/migrations/0001_initial.sql)
- Customer entity CRUD and metadata: [`worker/src/index.js`](../worker/src/index.js)
- Customer legacy alias normalization and role behavior: [`worker/src/domain.mjs`](../worker/src/domain.mjs)
- Customer forms, customer record construction, cards, details, and derived values: [`src/runtime/legacy.js`](../src/runtime/legacy.js)
- Customer CSV columns and normalization: [`src/modules/imports.js`](../src/modules/imports.js)

### ARI public documentation

- [Auto Shop Clients Management](https://ari.app/features/auto-shop-clients-management/) — contacts, address, shipping location, geolocation, email, notes, address recognition, labels, and contact import.
- [ARI Update – Client Menu Redesign](https://ari.app/2024/11/ari-update-client-menu-redesign/) — ID Scan, Contact Import, phone action, Maps action, tax exemption, discount, labor-rate override, and parts-markup override.
- [ARI App Store listing](https://apps.apple.com/us/app/ari-auto-repair-software/id1189544427) — publisher release notes documenting customer Tax ID, per-client payment-terms override, example default terms, and driver-license AI extraction.
- [ARI update v9.9](https://ari.app/2022/01/ari-auto-repair-software-update-v9-improved-features/) — client source and source export through Client Reports.
- [Reports Feature Improvements, ARI v14](https://ari.app/2024/04/reports-feature-improvements-ari-v-14/) — Clients data export and CSV/Excel/PDF workflow.
- [Introducing Grid View](https://ari.app/2021/09/introducing-grid-view-to-ari/) — Clients grid support and full-list Excel export.
- [Profile Setup](https://ari.app/features/profile-setup/) — shop labor rates, parts markups, taxes, and discount coupons; useful for distinguishing global settings from per-client overrides.
- [FootSteps Shutdown FAQ](https://aridocs.com/footsteps-shutdown-faq/) — confirms ARI Network's FootSteps CRM and its historical lead-export path are retired.
- [ARI Network DataSmart](https://arinet.com/powersports/ecatalogs/datasmart/) — confirms the publicly advertised ARI Network API covers catalog/fitment content, not customer master records.
