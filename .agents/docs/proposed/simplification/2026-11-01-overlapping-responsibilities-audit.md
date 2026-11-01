# Overlapping responsibilities audit (2026-11-01)

A read-only survey of module layout across `packages/{harness,texra,llm}` for
files whose responsibilities overlap or whose owner is unclear. Overall the
layering is well defined (the ratchets hold it); the items below are the
residue. Nothing here was changed in code.

## Findings

1. **Subscription vocabulary is split across two same-named files.**
   `packages/harness/src/shared/model/subscriptionAuth.ts` owns the provider
   ids and the `SUBSCRIPTION_AUTH_NAMES` copy.
   `packages/texra/src/shared/model/subscriptionAuth.ts` owns the status wire
   schema and `codexAccountLabel` / `xaiAccountLabel`, which are the same kind
   of fact (how a provider is named in user text) as the harness names. Two
   import specifiers (`@shared/...`, `@texra/shared/...`) end in the same
   `model/subscriptionAuth`, so a reader cannot tell which owns a given name.
   Why it matters: a new provider must edit both files, and the account-label
   copy can drift from the sign-in copy. Direction: move the two label
   functions beside `SUBSCRIPTION_AUTH_NAMES` (one owner per fact) and rename
   the app file for what stays in it (`subscriptionAuthStatus.ts`).

2. **The file-category vocabulary has three layers for one table.**
   `packages/texra/src/common/files/fileHandlingRules.ts` (data),
   `fileTypeUtils.ts` (34 lines that re-key the same data by category and strip
   dots) and `fileListingRules.ts` (builds filter configs from the same data).
   `INCLUDED_EXTENSIONS` in `fileTypeUtils.ts` only repackages
   `FILE_HANDLING_RULES.included`. Seven hosts and controllers import
   `fileTypeUtils`. Direction: make the rules table keyed by category and
   export `getIncludedExtensions` / `getFilterExtensions` from it, deleting
   `fileTypeUtils.ts`.

3. **Extension/MIME knowledge lives in two packages.**
   `packages/harness/src/utils/files/mimeUtils.ts` (`OFFICE_EXTENSIONS`,
   audio overrides) and the app's `FILE_HANDLING_RULES.included.mediaExtensions`
   both enumerate media-like extensions with no shared source. Needs a check
   that the lists cannot disagree (e.g. `.heic` handling) before deciding an
   owner; the harness cannot import the app, so the harness list would be the
   owner.

4. **Same-named helpers with different meaning.**
   `toErrorMessage` exists in `@utils/errors/errorMessage` (cause-chain
   joining) and `packages/llm/src/oauth/support.ts` (message only), and
   `stringField` / `numberField` exist in `packages/llm/src/api/failureReply.ts`
   and the app's `subscriptionUsageParsing.ts` with different signatures
   (single key vs. alias list). `llm` sits below the harness, so these are not
   mergeable by import, but the OAuth `toErrorMessage` hides the cause chain
   that the harness version surfaces; at minimum rename it.

5. **Parallel directory names across layers** (`controllers/`, `model/`,
   `platform/`, `common/`, `shared/`, `utils/` exist in both harness and app).
   Intentional per `AGENTS.md`, but `common/` vs `utils/` inside the app and
   `model/` vs `shared/model/` vs `controllers/modelAccess/` have no written
   rule for which file goes where.

## Most significant: finding 1 (and 2 as the cheaper companion)

### Draft PR

**Title:** `refactor: give subscription provider naming one owner`

**Description:**

Moves `codexAccountLabel` and `xaiAccountLabel` from the app's
`shared/model/subscriptionAuth.ts` next to `SUBSCRIPTION_AUTH_NAMES` in the
harness, exports them through `@texra-ai/harness/schemas`, and renames the app
file to `subscriptionAuthStatus.ts` since it then holds only the status wire
schema. Adding a provider now edits the provider table and its names in one
file.

Planned commit message:

```
refactor: give subscription provider naming one owner

Account labels sat in the app beside the status schema while the
subscription and sign-in labels sat in the harness. Keep every
user-facing provider name in the harness file and rename the app file
for the status schema it still holds.
```

## Net elements (R6)

Files: 0 (one rename). Exports: 0 net (two move). Import specifiers that end in
`model/subscriptionAuth`: 2 down to 1.

## Consumer counts (R8)

`codexAccountLabel` / `xaiAccountLabel`: 2 consumers each
(`controllers/modelAccess/subscriptionProviders.ts`,
`settingsView/frontend/components/profile/SubscriptionSection.ts`). Status
schema: 5 consumers to re-point on rename. The settings webview already imports
from `@texra-ai/harness/schemas`, so no new boundary edge is added.

## Verification before landing

`npm run typecheck`, `npm run test:pure`, `npm run check:dead-code-ratchet`.
