# PostHog Self-driving setup report

## Summary

PostHog Self-driving is configured with Session Replay, Error Tracking, and Support enabled; health, error, and support responders are enabled for the inbox. A focused scout troop and two Replay Vision monitors are armed.

Findings will start appearing in the [Self-driving inbox](https://us.posthog.com/project/601278/inbox) within about 30 minutes once eligible data arrives.

## AI data processing

Approved by the organization-level wizard gate.

## GitHub

The PostHog GitHub App was already connected before this setup. No GitHub Issues responder was enabled because the connected-tools selection timed out without a choice.

## Products enabled

| Product | Result | Notes |
|---|---|---|
| Session Replay | already enabled | No `posthog-js` client initialization was found in the PWA, and no recordings exist yet. The server toggle is on, but browser recordings require a client-side Replay-capable SDK integration. |
| Error Tracking | already enabled | The Worker already uses `posthog-node` with exception autocapture enabled. |
| Support (Conversations) | enabled | Connect an inbound email, inbox, or Slack channel before support tickets can arrive. |

## Signal sources

| Source product | Source type | Result |
|---|---|---|
| `health_checks` | `health_issue` | Enabled (source id `01a0bf23-05ec-7992-9e58-60263b4b6dd8`) |
| `error_tracking` | `issue_created` | Enabled (source id `01a0bf23-0805-7cfc-b835-fc9e6464baf7`) |
| `error_tracking` | `issue_reopened` | Enabled (source id `01a0bf23-06b4-7c07-bb2e-9ce3994c63e4`) |
| `error_tracking` | `issue_spiking` | Enabled (source id `01a0bf23-0681-702e-a69f-a5c783019c64`) |
| `conversations` | `ticket` | Enabled (source id `01a0bf23-0679-7173-b349-b4ecbbdb3418`) |
| `signals_scout` | `cross_source_issue` | No row created: scout findings are on by default. |
| `session_replay` | `session_analysis_cluster` | Deliberately skipped: Replay Vision scanners provide the supported replay route. |

## Connected tools

The connected-tools picker timed out and was treated as a decline. No issue-tracker, support-desk, security, or search responder was added. GitHub remains connected through the PostHog GitHub App but GitHub Issues was not selected for Self-driving.

## Scout troop

**Active (4)**

| Scout | Why it is active |
|---|---|
| General | Cross-product coverage for unassigned patterns and correlations. |
| Anomaly detection | Watches saved dashboards and insights for unexpected breaks, drops, or flat-lines. |
| Product analytics | Covers the Worker’s product events and operational flow analytics. |
| Revenue analytics | Covers the Stripe-backed billing and payment surface. |

**Disabled (23)**

| Scouts | Reason |
|---|---|
| AI observability, APM, CSP violations, Customer analytics, Data pipelines, Data warehouse, Experiments, Feature flags, Insight alerts, Logs, MCP tool calls, Skills store, Surveys, Tasks, Web analytics, Web vitals | No evidence that these surfaces are active enough in this project to earn a recurring scout run. Enable one later if that product becomes a regular part of the deployment. |
| Conversations | Support has no confirmed inbound channel yet. |
| Error tracking | Covered by the native Error Tracking responders above. |
| Session replay | Covered by the Replay Vision monitors below. |
| Replay vision | No accumulated scanner observations yet for the trend-level scout to analyze. |
| Health checks | The native health-check responder is enabled; the troop is kept selective. |
| Inbox validation | Fresh setup with no resolved Self-driving reports to validate yet. |
| Observability gaps | General and anomaly coverage are the more relevant initial fit for the current project. |

Run budget: **100 runs/day**, **0 runs used today**, **100 remaining**. Announcement: “Scouts are in early access. Each project gets up to 100 scout runs a day. Contact team-self-driving@posthog.com if you need more.”

## Custom scouts

No custom scout was created. One candidate was proposed and declined:

- **Payment checkout completion** — would watch for a sustained fall in payment completion after checkout begins. It was a real discriminator not directly owned by the generic revenue scout, though it partially overlaps that scout’s Stripe-health coverage.

Work-order lifecycle monitoring was considered but ruled out: the current server instrumentation records generic entity mutations rather than an ordered work-order status funnel, so it lacks a reliable success/failure discriminator. If a future custom scout becomes noisy, set its config’s `emit` field to `false` in PostHog to switch it to dry-run.

## Replay Vision scanners

A Replay Vision scanner is an LLM that watches individual session recordings on a schedule and pushes high-confidence findings to the Self-driving inbox. These are the only setup components that spend Replay Vision quota. Each finding has half weight, so independent corroboration is required before it is promoted into a report.

| Scanner | Status | Query scope | Sampling | Estimated monthly spend |
|---|---|---|---:|---:|
| Invoice payment breakage | Created | Sessions whose current URL contains `#payment-success`, the configured success return for invoice payment checkout | 0.5 | 0 observations / 0 credits |
| ShopCrank user frustration | Created | Sessions containing `$rageclick` only | 1.0 | 0 observations / 0 credits |

The organization has 2,500 Replay Vision credits remaining in the current period and no current spend. There are no recordings yet, so both scanners are armed but will not observe anything until browser session recordings begin.

## Follow-ups

- [ ] Add and initialize a Replay-capable client-side PostHog SDK in the PWA. The existing Worker SDK cannot create browser session recordings; this is required for Replay Vision monitors to receive sessions.
- [ ] Connect an inbound Support channel (email, inbox, or Slack) so the enabled Conversations ticket responder can receive tickets.
- [ ] If GitHub Issues, Linear, Jira, Sentry, Zendesk, or another external tool should feed Self-driving, configure it from [new data warehouse source](https://us.posthog.com/project/601278/pipeline/new/source) and enable its responder.
- [ ] Rate the first Replay Vision observations from each scanner to generate configuration recommendations.

## What happens next

Fresh scout configurations are picked up within about 30 minutes and draw from the verified 100-runs/day budget. Self-driving clusters corroborated findings into reports in the inbox; immediately actionable reports can start coding tasks.

## Files changed

- Created `posthog-self-driving-report.md`.

No application source files were modified.
