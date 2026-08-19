# Dead-code gate blind spots

- **Date**: 2026-08-19
- **Status**: proposed
- **Scope**: `scripts/check-dead-code-ratchet.mjs`, `knip.json`, contributor tooling

## Problem

A 269-commit simplification campaign landed between 2026-08-17 and 2026-08-19
(1,247 files, net −13k LOC). A survey of that surface found roughly forty
verified leftovers — write-only fields, dead options, orphaned exports — that
the campaign walked past. The interesting question is not that leftovers exist;
it is that `npm run check:dead-code-ratchet` reported the tree clean throughout.

Three independent gaps explain it. Each is verified, not inferred.

### 1. A test is a consumer

`knip.json` declares the root workspace's entry points as
`src/test-kernel/**/*.vitest.ts`. Knip therefore counts an export consumed only
by a test as _used_. Production-dead-but-test-alive is structurally invisible
to the gate.

Specimen: `getAgentsBySource` (`src/agent/index/agentRegistry.ts:311`). Its sole
production consumer was deleted in-window by `12f9b30f96`, which also removed it
from the `src/agent/index/index.ts` barrel — and left the function standing. It
has 0 production consumers, 7 assertion sites in
`src/test-kernel/agent/AgentRegistry.vitest.ts`, and the ratchet is green.

This is the highest-volume gap: most of the survey's findings are this species.

### 2. `packages/cli` exports are not reported

Specimen: `getCliSessionAccessToken`
(`packages/cli/src/runtime/supabaseAuth.ts:206`). It has exactly **one**
occurrence repo-wide — its own declaration. Zero consumers in production, tests,
scripts, or docs. Its last caller (`loadIncludedUsageLine`) was deleted in-window
by `368ee4f601`. The full-repo knip run does not flag it.

The mechanism is undetermined. The workspace's `scripts/**/*.{ts,tsx,mjs}` entry
glob pulls in `packages/cli/scripts/tui-harness.tsx`, which imports a great deal
of CLI internals — but not this symbol, so the harness does not explain it.
Diagnosing this should precede fixing it.

### 3. A stray `.js` sibling shadows its `.ts` and inverts the report

If a compiled `foo.js` sits beside `foo.ts` under `src/`, module resolution
prefers the `.js`, so the `.ts` is reported as an unused _file_ — while the
genuinely dead code goes unreported.

Reproduced locally: two untracked artifacts from 2026-08-12
(`src/controllers/modelAccess/chatGptAuthStatus.js`,
`src/common/errors/sdkError/chatgptSubscriptionDetection.js`) made the ratchet
fail with:

```
Dead-code ratchet failed: this PR introduces 2 unused file(s)/export(s) not in the baseline.
  - [files] src/common/errors/sdkError/chatgptSubscriptionDetection.ts
  - [files] src/controllers/modelAccess/chatGptAuthStatus.ts
```

Both `.ts` files have live importers (`providerErrorFormat.ts:53`,
`packages/desktop/src/main/desktopCredentialSettingsController.ts:2`). Renaming
the two `.js` files away turns the gate green (`8 current vs 8 baselined`).

Issue #10858 ("Harden the dead-code ratchet against stray compiled .js siblings
under src/") is closed, and its fix — `"project": ["src/**/*.ts",
"!src/**/*.js"]` — stops the `.js` from being _reported_. It does nothing about
the `.ts` being _shadowed_, so the failure mode it was closed against still
reproduces.

## Related hazard: the global gitignore hides tracked source

Not a gate defect, but it invalidates the manual greps the gate is supposed to
backstop. `~/.gitignore_global` carries AI-scratch patterns — `*gpt*.*`,
`*sonnet*.*`, `*_opus*.*`, `*gemini*.*`, `*o1*.*`, `*o3*.*`, `*o4*.*`.
Ripgrep applies ignore rules regardless of tracked status, so a recursive search
silently skips nine tracked files, six of them real source:

```
packages/cli/src/commands/chatgptAuth.ts
src/common/errors/sdkError/chatgptSubscriptionDetection.ts
src/controllers/modelAccess/chatGptAuthStatus.ts
src/test-kernel/cli/ChatgptLoginBrowser.vitest.ts
src/test-kernel/common/ChatGptSubscriptionDetection.vitest.ts
docs/proposals/2026-06-21-chatgpt-subscription-codex-auth.md
```

Verified: `rg --files packages/cli/src/commands | grep -c gpt` → 0; the same
command with `--no-ignore-vcs` → 1. Every "zero consumers" claim made with plain
`rg` in this repo is unsound. The `o1`/`o3`/`o4` patterns are broad enough to
catch future source files by accident.

Note for anyone applying the workaround: `--no-ignore-vcs` also un-ignores
`dist/`, so it needs `-g '!dist' -g '!*.js'` or it drowns in bundled output.

## Proposal

1. **Report production-dead exports separately from test-dead ones.** Keep
   test-kernel as an entry point so tests are not themselves reported as dead,
   but add a second knip pass whose entry set excludes `src/test-kernel/**`, and
   ratchet its export findings against a new baseline. The delta between the two
   passes _is_ the production-dead-test-alive set.
2. **Diagnose gap 2 before fixing it.** Establish why `packages/cli` exports go
   unreported; a config change made without knowing the cause may just move the
   blind spot.
3. **Fail loudly on stray `.js` siblings.** In
   `scripts/check-dead-code-ratchet.mjs`, before reporting a `.ts` file as
   unused, check for a `.js` sibling and fail with "stray build artifact at
   `<path>` — delete it and re-run" instead of a phantom dead-code finding.
4. **Narrow the global-ignore patterns** (owner's machine, not the repo): scope
   them to a scratch directory or to non-source extensions.

## What we give up

Gap 1's fix widens the reported surface, which will surface a backlog on first
run. That backlog is the point, but it means the second baseline starts large
and shrinks — the same shape as the existing ratchets, and it must never widen.

## Acceptance criteria

- A production-dead export whose only consumer is a `.vitest.ts` file is
  reported by the gate. `getAgentsBySource` is the regression fixture.
- `getCliSessionAccessToken` is reported.
- A stray `src/**/foo.js` beside `foo.ts` fails the gate with an explicit
  stray-artifact message naming the file, not a dead-code finding.

## Risks

- Ratchet churn: three of the survey's findings are already-baselined symbols,
  so the baselines and the new pass must land together or CI flaps.
- Gap 1's fix may reclassify sanctioned test-only seams (`clearInlineAgents`,
  `resetExecutionLeaseCoordinationForTests`, `assertSupported`) as dead. These
  are required by AGENTS.md's "no bare module-level mutable singletons in tested
  code" rule and must be baselined, not deleted.
