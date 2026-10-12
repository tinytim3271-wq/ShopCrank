# Shop Crank support plan

Shop Crank is currently operated by one owner, so support promises must be
specific, limited, and achievable. The in-app help center handles common
questions; every submitted ticket is stored in D1 and can notify the configured
support mailbox.

## Service tiers

| Plan | Channel | Initial-response target | Included help |
| --- | --- | --- | --- |
| Solo | In-app ticket/email | 2 business days | Product questions and defect triage |
| Shop | In-app ticket/email | 1 business day | Product questions, defect triage, guided setup |
| Shop Pro | In-app ticket/email | 8 business hours | Priority operational and diagnostics triage |
| Enterprise | In-app ticket/email plus scheduled call | 4 business hours for urgent incidents | Named onboarding plan and multi-location coordination |

These are response targets, not guaranteed resolution times. A response may be
an acknowledgement, workaround, request for evidence, or escalation.

## Hours and severity

Normal support hours: Monday–Friday, 9:00 AM–5:00 PM Central Time, excluding
published US holidays. Do not advertise 24/7 coverage while one owner operates
the service.

- **Urgent:** the shop cannot sign in, create/access work orders, take payments,
  or retrieve customer records; a suspected security or cross-tenant exposure.
- **Normal:** a feature is degraded, a provider integration fails, setup help,
  data questions, or a feature request.

Urgent reports outside hours are best-effort. Publish maintenance and incidents
at the configured status-page link. Security incidents take precedence over
feature work.

## Onboarding and migration

Self-service onboarding includes account creation, shop settings, CSV templates,
and the ARI conversion script. Offer a paid assisted-migration package with:

1. A signed data-handling agreement and secure transfer method.
2. Source export inventory and field mapping.
3. Trial import into a non-production shop.
4. Record-count, balance, tax, and customer/vehicle relationship checks.
5. Owner sign-off before cutover.
6. A retained source export and rollback window.

Never request provider passwords, card data, Social Security numbers, or
unredacted payroll tax documents in a support ticket.

## Operating workflow

1. Review the ticket queue at opening and before closing each business day.
2. Acknowledge urgent tickets first and set `in_progress`.
3. Link incidents affecting multiple shops to one status-page incident.
4. Record reproduction steps, affected IDs, workaround, and resolution.
5. Close only after customer confirmation or two documented follow-ups.
6. Review recurring categories monthly and promote answers into the FAQ.

## Tooling options

Start with D1 tickets, Cloudflare Email Routing, and a public status page such as
Better Stack, Atlassian Statuspage, or a small Cloudflare Pages status site.
When ticket volume exceeds what one owner can reliably handle, connect the D1
workflow to a lightweight help desk (Help Scout, Freshdesk, Zendesk, or Linear)
through a Worker webhook. Require MFA, least-privilege accounts, audit history,
and exports before adopting a tool.

Use uptime checks for Pages, Worker `/api/healthz`, login, and a synthetic D1
read. Alert on elevated Worker errors, failed webhooks, email delivery failures,
and exhausted provider quotas. Do not promise an uptime SLA until monitoring,
incident ownership, backups, and a tested recovery procedure exist.

## Launch approval

Before selling to another shop, Timothy should approve the published hours and
targets, choose the support mailbox/status tool, name an emergency backup
contact, test D1 restore procedures, and define prices for assisted onboarding
and migration.
