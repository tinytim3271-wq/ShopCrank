# Staff Engineer — [DISCOVERED]
- Pattern: modal HTML rendered through showModal → safeHtml (DOMPurify). Any form field named after a DOM/form property is stripped. Avoid name/title/method/action/role/id as field names.
- Pattern: legacy functions are monkey-patched by later reassignment (apiFetch is wrapped ~4 times). Behavior depends on load order.
