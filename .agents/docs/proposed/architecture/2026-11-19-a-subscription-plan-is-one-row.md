# A subscription plan is one row

Date: 2026-11-19
Status: proposed (design B built in the PR that adds this note; design A's
id columns wait on a naming decision)

Origin: section 2 of
`.agents/docs/proposed/architecture/2026-11-19-what-the-refused-candidates-share.md`.
The PR that adds this note first makes every per-plan branch exhaustive over
`PlanRoute` (`packages/llm/src/errors.ts`), then takes the design below that
deletes more restated facts.

## What a plan is described by

Measured on the branch that adds this note. Route literals appear in 14
source files across four packages.

- **Llm, route-keyed:** `PLAN_ROUTES` (provider, credential kind),
  `PLAN_DECISIONS` and `routeConfig`
  (`packages/llm/src/models/modelRoute.ts`), `PLAN_LIMITS`
  (`packages/llm/src/api/verdict.ts`), `PLAN_EFFORTS`
  (`packages/llm/src/models/reasoningChoice.ts`) and the Responses switch
  (`packages/llm/src/api/responsesConfiguration.ts`).
- **Harness:** the switch (`on`, `packages/harness/src/model/modelSettings.ts`),
  `subscriptionCredential`
  (`packages/harness/src/agent/runtime/modelAccess/credentials.ts`) and the
  sign-in ids (`SUBSCRIPTION_ROUTES`,
  `packages/harness/src/shared/model/subscriptionAuth.ts`).
- **App:** plan names and the usage badge
  (`packages/texra/src/ui/copy/modelAccess.ts`), the sign-in copy and
  sections, and the coding-plan catalog
  (`packages/texra/src/shared/model/codingPlans.ts`).

## Design A: one table in llm that the harness and app read

`PLAN_ROUTES` carries every column a branch tests, and the other layers
read it.

- Data columns fit: `efforts` (deletes `PLAN_EFFORTS`), a limit shape
  (`{ codes }` read on any route, `{ phrase }` on the plan's own route;
  deletes `PLAN_LIMITS` and its readers' dispatch), and the two app ids,
  `signIn` (`chatgpt`, `grok`) and `usage` (`kimiCode`, `glmCodingPlan`),
  which would delete `SUBSCRIPTION_ROUTES` with its totality check and the
  catalog's `id` column.
- Function columns do not fit. The route decision and the config rewrite
  read `modelRoute.ts` helpers, and `modelRoute.ts` and `verdict.ts` import
  `PLAN_ROUTES`, so a row of deciders in `errors.ts` is an import cycle;
  moving the table to its own module moves the cycle with it.
  `PLAN_DECISIONS` and `routeConfig` stay where they are under either design.
- Cost: four new public fields on `PLAN_ROUTES`. Two of them are app
  vocabulary, the sign-in id is a CLI command name and a settings wire value,
  and the usage id is a stored enum
  (`packages/texra/src/shared/model/subscriptionUsage.ts`), now owned by an
  llm export.

Deletes about 3 tables and 1 check, 70 lines in 4 files.

## Design B: a row per plan, built from each layer's own columns

Each layer keys its table by the route and takes the columns it does not
own from `PLAN_ROUTES`, so nothing is restated and every table is total over
the plans it covers.

- Built in the PR that adds this note. The coding-plan catalog is keyed by
  `KeyPlanRoute`, and its rows no longer write `usageRoute` or `apiProvider`:
  both come from the route. That deletes the route-to-plan map, the usage
  service's lookup by array position, and four restated cells, and closes the
  one plan site the compiler did not hold.
- The stored and wire route lists were already derived from `PLAN_ROUTES`
  in the same PR, and the sign-in ids from `SUBSCRIPTION_ROUTES`.
- Left as is: `SESSION_ACCOUNTS` (`modelAccess.ts`) restates the sign-in table
  by route. Its index already fails to compile for a new session plan, and
  deleting it needs a route-to-sign-in lookup that no other reader wants.

Deletes about 2 tables' worth of restated columns, 25 lines in 2 files, with
no public change.

## Choice

B was built. A deletes more lines, but most of them are two id columns that
would make llm own the harness's and app's vocabulary, and the deciders,
which are most of the per-plan code, stay put under both designs. B is what
the code can decide on its own.

The open decision is A's two id columns on `@texra-ai/llm` (`signIn`,
`usage`) and `efforts`. If the owner wants the ids owned by llm, the step is:
add the columns, derive `SUBSCRIPTION_ROUTES` and the catalog's `id` from
them, and delete `PLAN_EFFORTS` and the totality check, in one PR with
`npm run docgen`.
