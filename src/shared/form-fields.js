/**
 * Form field names that survive the HTML sanitizer.
 *
 * DOMPurify (via safeHtml) removes any `name`/`id` whose value is a property
 * of `document` or `<form>` (DOM-clobbering protection). Fields that would be
 * named `name`, `title`, `role`, `method`, or `body` therefore use these
 * aliases in markup, and readFormValues() maps them back to the canonical key
 * so handlers and stored records keep using `data.name`, `data.title`, etc.
 * See .10x/adrs/001-form-field-names-vs-sanitizer.md.
 */
export const FORM_FIELD_ALIASES = Object.freeze({
  displayName: 'name',
  jobTitle: 'title',
  accessRole: 'role',
  paymentMethod: 'method',
  messageBody: 'body',
});

/** Maps alias keys in a plain values object back to their canonical keys. */
export function canonicalFormValues(input) {
  const values = { ...input };
  for (const [alias, canonical] of Object.entries(FORM_FIELD_ALIASES)) {
    if (Object.prototype.hasOwnProperty.call(values, alias)) {
      if (!Object.prototype.hasOwnProperty.call(values, canonical)) values[canonical] = values[alias];
      delete values[alias];
    }
  }
  return values;
}

/** Canonical form values: Object.fromEntries(new FormData(form)) with aliases mapped back. */
export function readFormValues(form) {
  return canonicalFormValues(Object.fromEntries(new FormData(form)));
}
