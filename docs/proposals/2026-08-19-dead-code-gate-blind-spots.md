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
`src/test-kernel/**/*.vitest.ts` and `scripts/**/*.mjs`. Knip therefore counts an
export consumed only by a test as _used_. Production-dead-but-test-alive is
structurally invisible to the gate.

Specimen: `getAgentsBySource` (`src/agent/index/agentRegistry.ts:312`). Its sole
production consumer was deleted in-window by `12f9b30f96`, which also removed it
from the `src/agent/index/index.ts` barrel — and left the function standing. It
has 0 production consumers and 7 references in
`src/test-kernel/agent/AgentRegistry.vitest.ts`: the import and 6 assertion sites.
The ratchet is green.

This is the highest-volume gap: most of the survey's findings are this species.

### 2. `packages/cli` exports are not reported

Specimen: `getCliSessionAccessToken`
(`packages/cli/src/runtime/supabaseAuth.ts:206`). It has exactly **one**
occurrence repo-wide — its own declaration. Zero consumers in production, tests,
scripts, or docs. Its last caller (`loadIncludedUsageLine`) was deleted in-window
by `368ee4f601`. The full-repo knip run does not flag it.

The mechanism is undetermined. The `packages/cli` workspace's entry points are
`src/bin/texra.ts` and `scripts/**/*.{ts,tsx,mjs}`. The latter pulls in
`packages/cli/scripts/tui-harness.tsx`, which imports a great deal of CLI
internals — but not this symbol, so the harness does not explain it. Diagnosing
this should precede fixing it.

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
silently skips nine tracked files, five of them real source:

```
packages/cli/src/commands/chatgptAuth.ts
src/common/errors/sdkError/chatgptSubscriptionDetection.ts
src/controllers/modelAccess/chatGptAuthStatus.ts
src/test-kernel/cli/ChatgptLoginBrowser.vitest.ts
src/test-kernel/common/ChatGptSubscriptionDetection.vitest.ts
```

Verified: `rg --files packages/cli/src/commands | grep -c gpt` → 0; the same
command with `--no-ignore-vcs` → 1. Every "zero consumers" claim made with plain
`rg` in this repo is unsound. The `o1`/`o3`/`o4` patterns are broad enough to
catch future source files by accident.

Note for anyone applying the workaround: `--no-ignore-vcs` also un-ignores
`dist/`, so it needs `-g '!dist' -g '!*.js'` or it drowns in bundled output.

## Proposal

### The governing constraint: one owner of "dead"

The three gaps share a root cause. "Is this symbol dead?" is answered today by
whichever mechanism happens to see it — knip's default pass for most of `src/`,
nothing at all for `packages/cli`, and module resolution (accidentally) for
files with a stray `.js` sibling. Three partial authorities, no single one that
can be asked the question and trusted.

So the fix must not be "add another check". A second knip pass ratcheted
against a second baseline would answer the same question in a second place, and
the next contributor would have to know which one is authoritative for their
case. That is the shape this repo has repeatedly paid to remove.

**`scripts/check-dead-code-ratchet.mjs` is the single authority.** knip is an
input to it, never a peer. Everything below follows from that.

1. **One script, one baseline, one vocabulary.** The script may invoke knip more
   than once — once with test files as entry points, once without — but those
   are two _inputs_ to one classifier, not two gates. The difference between the
   runs is what produces the finding category, and all categories land in the
   existing `config/ratchets/knip-baseline.json` with a `category` field
   (`unused` vs `production-dead`) rather than in a new baseline file. A
   contributor reads one file to learn what is grandfathered.

2. **Classification belongs to the script, not to config.** The stray-`.js`
   case is not a knip configuration problem; it is a question of what a finding
   _means_. Before reporting a `.ts` file as unused, the script checks for a
   `.js` sibling and, if present, fails with "stray build artifact at `<path>` —
   delete it and re-run". Same single owner deciding, in one place, that this
   input does not mean what it appears to mean.

3. **Diagnose gap 2 before changing config.** Establish why `packages/cli`
   exports go unreported. A config change made without knowing the cause moves
   the blind spot rather than closing it, and leaves the authority ambiguous
   again.

4. **Narrow the global-ignore patterns** (owner's machine, not the repo): scope
   them to a scratch directory or to non-source extensions.

## What we give up

Widening the reported surface will surface a backlog on first run. That backlog
is the point, but it means the baseline grows once and then only shrinks — the
same discipline as the existing ratchets, and it must never widen.

Running knip twice costs wall-clock in CI. That is the price of the single
authority actually being able to answer the question; splitting the work across
two gates to save time would reintroduce exactly the ambiguity this proposal
exists to remove.

## Acceptance criteria

- One command answers "is this dead?" for every corpus. A contributor never has
  to know which gate covers their file.
- A production-dead export whose only consumer is a `.vitest.ts` file is
  reported, categorized `production-dead`. `getAgentsBySource` is the regression
  fixture.
- `getCliSessionAccessToken` is reported.
- A stray `src/**/foo.js` beside `foo.ts` fails with an explicit
  stray-artifact message naming the file, not a dead-code finding.
- `config/ratchets/knip-baseline.json` remains the only baseline for dead code.

## Risks

- Ratchet churn: three of the survey's findings are already-baselined symbols,
  so the baselines and the new pass must land together or CI flaps.
- Gap 1's fix may reclassify sanctioned test-only seams (`clearInlineAgents`,
  `resetExecutionLeaseCoordinationForTests`, `assertSupported`) as dead. These
  are required by AGENTS.md's "no bare module-level mutable singletons in tested
  code" rule and must be baselined, not deleted.
