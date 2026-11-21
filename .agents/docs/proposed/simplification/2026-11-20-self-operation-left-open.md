# An agent running itself: what the 2026-11-20 review left open

Date: 2026-11-20
Status: proposed
Origin: a four-angle review (reuse, simplification, efficiency, depth of fix)
of the change that added child-run limits, the `wake` tool, an agent's own
programs, native plugins loaded while running and the `resources` tool. The
same change implements the findings that fit a reviewable diff: one owner of
a program's origin (`programOrigin`), an own program's launch reading only its
own files, the native loader on Effect's `Cache`, the live table as the one
owner of the revision in use, a child's launch taking the published table,
trust as a fact of the request kind, a slimmer `pluginTrust` payload, queued
input read in commit order, one wait for a time, one time rendering, one wake
timer per run, and `resources` on llm-zoo's own rates. This note records what
was found and not done, with the reason.

## 1. A child's spend cap is a fact of the waiting call, not of the run

`withinLimits` (`packages/harness/src/agent/runtime/delegation/agentChild.ts`)
holds `maxCostUsd` in the call that waits for the child. Three consequences
follow from that one placement:

- A child nobody waits for (a direct call, or `background: true`) can take
  no cap, so the call rejects one.
- `resources` rebuilds the caps a run is under by walking up its parents and
  decoding each parent's waiting call from its `tool.intent` rows (`capsOver`,
  `packages/harness/src/tools/ResourcesTool.ts`). It reads each ancestor's
  whole tool-call history to find one card, because the log has no read of
  one card's rows.
- The goal's cap is a third mechanism, written in the goal's script
  (`packages/harness/src/tools/plan/goalScript.ts`), which pauses rather than
  stops.

The deeper shape: the cap is recorded on the child run when it starts and
carried in the session view; one watcher of the view stops the subtree at the
cap. A background child can then take a cap, `resources` reads the view, and
`capsOver` and the background rejection go. The goal's pause is a different
outcome and stays.

Not done because it changes a stored row (the run's start), and so belongs
with the other format changes before the store is frozen. It needs the
owner's word on whether a cap survives a resume of the run by a person.

## 2. An agent's own programs are spliced into the step by hand

`packages/harness/src/agent/runtime/loop/step.ts` reads the own programs
(`readOwnPrograms`), merges their sources into the step's importable modules
and their descriptions into its program list, cuts the listing at twenty, and
guards the read by the run's origin and by whether the step offers `script` or
`program`. Own programs are a source shaped like a plugin (modules, programs,
warnings) that reaches the step through its own path instead of the table the
step pins, the way a native plugin's programs do (`withNatives`,
`packages/harness/src/tools/toolTable.ts`).

The deeper shape: a per-project source that joins the pinned table. The
step's merge goes, and "read a source only for the tools the step offers"
becomes the table's rule, not this one guard's.

Not done because it changes what the plugin table is keyed by (a table is
per process today, and own programs are per project) and deserves its own
design pass.

## 3. Own programs are read and hashed on every step

A step that offers `script` or `program` lists the directory, then for every
file reads it, parses the memory tool's header and reads its declarations;
the step then hashes every module source to pin it. That runs before every
request and every wait. The plugin digest already caches a file's hash by
inode, size and modification time (`packages/harness/src/common/plugins/`);
the same key would make an unchanged directory cost one listing.

Not done because item 2 moves this read; caching it first would be redone.

## 4. The gate on a third party's tool is applied by each loader

`packages/harness/src/tools/thirdPartyTool.ts` owns the approval command and
the deadline, and the MCP loader and the native loader each wrap their tools
with it. A third loader that forgets the wrap offers ungated tools. A mark on
the tool, read by the loop's one guard, would make the gate the default.

Not done: two callers, both correct, and no third in sight.

## 5. The background service does not stay up for a pending wake

A wake note whose process is gone is delivered late, once, at the project's
next open. The service that holds projects for windows
(`packages/texra/src/controllers/server/serve.ts`) releases an idle project
and exits with a note still pending, and nothing reopens it. Staying up needs
the session to say publicly that a wake is pending, and a rule for how long a
service with nothing else to do stays alive.

Not done because it is a product decision (a process that outlives every
window to fire a timer) and not a refactor.
