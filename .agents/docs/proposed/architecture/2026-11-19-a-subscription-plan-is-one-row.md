# A subscription plan is one row

Date: 2026-11-19
Status: proposed

Origin: section 2 of
`.agents/docs/proposed/architecture/2026-11-19-what-the-refused-candidates-share.md`.
The PR that
adds this note takes the first step that review named: every site that
decides something per plan is now exhaustive over `PlanRoute`
(`packages/llm/src/errors.ts`), and the sign-in ids and stored route lists
are derived from llm's routes. This note is the step it does not take.

## Where a plan lives now

Measured on the branch that adds this note. Route literals appear in 14 source
files across four packages. A plan is described by:

- **Six route-keyed tables**: `PLAN_ROUTES` (provider, credential kind),
  `PLAN_DECISIONS` (`packages/llm/src/models/modelRoute.ts`), `PLAN_LIMITS`
  (`packages/llm/src/api/verdict.ts`), `PLAN_EFFORTS`
  (`packages/llm/src/models/reasoningChoice.ts`), `on`
  (`packages/harness/src/model/modelSettings.ts`), and the app's
  `PLAN_NAMES` (`packages/texra/src/ui/copy/modelAccess.ts`).
- **Four route switches**: `routeConfig` (`modelRoute.ts`), the Responses
  request (`packages/llm/src/api/responsesConfiguration.ts`),
  `subscriptionCredential`
  (`packages/harness/src/agent/runtime/modelAccess/credentials.ts`) and
  `usageRouteBadge` (`modelAccess.ts`).
- **Sign-in-keyed tables** (`chatgpt`, `grok`): `SUBSCRIPTION_ROUTES`
  (`packages/harness/src/shared/model/subscriptionAuth.ts`, now checked total
  over the session plans), `SUBSCRIPTION_AUTH_COPY`
  (`packages/texra/src/ui/copy/accountAuth.ts`), `SUBSCRIPTION_PROVIDERS`
  (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`),
  `SUBSCRIPTION_SECTIONS`
  (`packages/texra/src/ui/settings/components/profile/SubscriptionSection.ts`)
  and the CLI's first-run rows.
- **Key-plan-keyed data** (`kimiCode`, `glmCodingPlan`):
  `CODING_PLAN_SUBSCRIPTIONS` (`packages/texra/src/shared/model/codingPlans.ts`),
  the usage cache key and request
  (`packages/texra/src/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService.ts`,
  `packages/llm/src/providers/planUsage.ts`). This vocabulary is not derived
  from the route; its catalog row is the one place a new key plan is still
  not held by the compiler.

The tables are typed, so the open problem is no longer silent wrong paths.
It is that the llm facts of one plan sit in four tables and two switches in
three files, and that two id vocabularies outside llm translate back to it.

## Design A: one plan row in llm

`PLAN_ROUTES` grows into the plan table. Each row carries what the llm
branches test: `provider`, `credential`, `serves(config, facts)` (today's
decider), `limit(reply, onRoute)`, `efforts`, `wireModel(config)` and
`contextWindow(config, route)` (today's `routeConfig` cases), and `usage`
(the request a usage read makes, or `null`). The session plans' request
dialect stays in `responsesConfiguration.ts`, since it is a protocol fact.

Deletes: `PLAN_DECISIONS`, `PLAN_LIMITS`, `PLAN_EFFORTS`, the `routeConfig`
switch and `PlanUsageRequest`'s own plan ids (three tables, one switch, one
union; about 90 lines in three files). Adds: one row shape and its type,
about 50 lines. Harness and app tables are untouched.

Against: a row of functions is the same code moved, not removed; it pulls
the route decision, the failure reader and the usage read into
`errors.ts`, three modules with no other shared reader. The refusal of
`LLM-subscription-credential-facade` (`.agents/docs/refuted-candidates.json`)
holds for the credential: it stays in the harness, read by route.

## Design B: one vocabulary, route-keyed tables

Keep a table per concern (what this PR leaves), and key the app's tables by
route instead of by the two app ids. `chatgpt`/`grok` stay as wire and
command spellings, translated once at their boundary (`SUBSCRIPTION_ROUTES`
read both ways); `kimiCode`/`glmCodingPlan` become the usage-route keys
`CODING_PLAN_SUBSCRIPTIONS` already carries (`usageRoute`).

Deletes: the key-plan id as a type (`SubscriptionUsageProvider`, with its
schema and the `codingPlanForUsageRoute` overloads), `SESSION_ACCOUNTS`
(derived from `SUBSCRIPTION_AUTH_COPY` through the route), and the two
key-plan branches in the usage service; about 60 lines over five files.
Changes a format: the usage snapshot's provider id
(`packages/texra/src/shared/model/subscriptionUsage.ts`, which calls it a
stored enum) would carry the route, so it lands as its own commit and is
listed for the owner.

## Recommendation

B first: it removes a vocabulary, which is what made the branches
unchecked, and it leaves each fact with the module that reads it. A is
worth doing only if a fifth plan arrives and its row turns out to touch all
four llm tables; measure that then, against this note's counts.
