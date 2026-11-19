# A plugin's own aggregates: no writer since the external inquiry went

Date: 2026-11-19
Status: proposed (needs a storage decision)
Origin: the PR that retired the external inquiry and the plugin request
(`feat!: retire the external inquiry tool`). Its threads were the one user
of a plugin's own aggregate, and the PR stops short of removing that
mechanism because removing it changes what the store accepts.

## What is left with no consumer

Measured on the PR's branch:

- The write side: `ToolFact.aggregate`
  (`packages/harness/src/shared/schemas/toolResult.ts`), the `aggregate`
  branch of `factRow`, `FactKind.accepts` and `FactKind.supersedes`, and the
  parent rule of `ownFactsChecked` (`packages/harness/src/tools/plugins.ts`).
  No plugin in the repo states a fact with an `aggregate`, and none declares
  `accepts` or `supersedes`. One session test
  (`src/test-kernel/controllers/session/sessionEvents.vitest.ts`, "closes a
  run tree with its dependents and collects it") uses a test-local kind.
- The view: `SessionView.pluginFacts` and `applyPluginFact`
  (`packages/harness/src/shared/session/sessionViewUpdate.ts`), which no
  renderer reads.
- The store: the `plugin` aggregate kind (`pluginAggregateId` and
  `aggregateTarget`, `packages/harness/src/shared/schemas/identifiers.ts`;
  `aggregateOf`, `packages/harness/src/controllers/session/rowCodec.ts`),
  a `plugin.fact` row's `parent` edge, and its closing with its parent
  run's removal (`packages/harness/src/controllers/session/databaseLayer.ts`).

The documents plugin's facts are about their run (no `aggregate`) and stay.

## Why it is not removed yet

The write side and the view go with no row change. The store does not: a
store an earlier build wrote can hold `plugin` aggregates (the inquiry's
threads), and `aggregateOf` throws on a kind it does not know, so removing
the kind turns those stores into a defect at read. Two ways out:

1. Bump the schema stamp (`storeSchema.ts`): every earlier store fails to
   open and says to move the file away. Clean, and costly for every user of
   a pre-1.0 build.
2. Read a row of an unknown aggregate kind as an earlier build's
   (`DatabaseRowEarlier`) instead of throwing. That is a rule about the
   store, not a reader of the old format, and it holds for any kind a later
   build retires.

Recommended: 2, with the write side and the view in the same PR.
