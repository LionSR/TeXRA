---
created: 2026-09-21
status: proposed
---

# Reflection raw-output recovery: shipped behavior and verification

This note closes the reflection half of
[#12427](https://github.com/LionSR/TeXRA/issues/12427): what the shipped
reflection loop actually does for complete, partial, and conflicting raw
output across a process reopen, which existing test pins each case, and what
remains unpinned. It is source-based and suite-verified against `origin/main`
at `6eb322f83e75b81602a7f4fdcfede2d329af29f9` (2026-09-21). No durable shape
changes: the recommendation at the end is stated, not landed.

## 1. The mechanism, as shipped

The reflection loop commits an `output.pending` snapshot **before any output
file is touched** (`src/agent/runtime/loop/reflection.ts:822-830`; the
snapshot is `:826`, the `output.ready` step rides the same batch at `:828`).
Resume re-enters that phase by running `produceOutput` again
(`reflection.ts:1161-1162`; definition `:1031-1053`), which re-runs the
pipeline over the round's raw output file and the artifacts the run already
produced. The raw output file itself is written earlier, one response cycle at
a time, by `writeOutputFragment` (`reflection.ts:597-650`).

`writeOutputFragment` decides between a repeated append and a rewrite using
two numbers only:

- `expected` — the recorded byte offset, `flow.rawOutputBytes ?? 0`
  (`reflection.ts:604`), and
- `actual` — the file's on-disk length, `stat(...).size`, with a missing file
  read as `0` (`reflection.ts:609-613`).

It never reads back the bytes it is about to skip or the prefix it is about to
keep. The three branches:

| Case        | Condition                                       | Action                                                                                                                    |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| COMPLETE    | `actual === expected + fragmentBytes` and `> 0` | Skip: "Raw output already holds this response; not appending twice." (`:614-617`)                                         |
| PARTIAL     | `actual === expected`                           | Append with `flag: 'a'` if the file exists (`:619-621`), else create it (`:622-624`)                                      |
| CONFLICTING | neither of the above                            | Rewrite from the recorded offset: keep `existing[0..min(expected, len)]`, drop the rest, append the fragment (`:626-647`) |

Every branch then advances the recorded offset to `expected + fragmentBytes`
(`reflection.ts:649`), and that value is persisted in the next snapshot. The
offset is part of the durable snapshot vocabulary:
`rawOutputBytes` is `ReflectionSnapshotStateSchema.rawOutputBytes`
(`src/shared/schemas/runFlowState.ts:334-339`), the snapshot rows are stamped
by `SESSION_EVENT_FORMAT` (`src/shared/schemas/sessionEvent.ts:588`, currently
`7`), and `src/test-kernel/schemas/sessionEventFormat.vitest.ts` pins the
stored shape so a vocabulary change cannot land without a version bump.

## 2. Behavior across a process reopen

A reopen runs `restore` (`reflection.ts:417-462`), which reads the persisted
`flow` — including `rawOutputBytes` and `outputLocation` — back from the
snapshot. For a mid-round phase (`model.ready`, `model.submitted`,
`response.ready`) it also reads the raw output file's first
`persisted.rawOutputBytes` bytes into `accumulatedOutput`/`lastResponse`
(`reflection.ts:439-458`); a file the resume finds gone contributes `''`
(`:454`), any other read failure fails the resume. The loop then re-processes
the response (`processResponse` → `writeOutputFragment`) or, at
`output.pending`, re-runs `produceOutput`. The offset writer therefore
reconciles a reprocessed response against whatever a previous process left on
disk.

Two consequences follow from section 1's "no content read-back":

1. **Equal length does not verify matching content.** If the file length
   equals `expected + fragmentBytes`, the writer skips without comparing a
   single byte. Conflicting bytes of the same length are indistinguishable
   from a completed write, and the offset still advances.
2. **The kept prefix is trusted by length, not content.** Both the append
   branch (`actual === expected`) and the rewrite branch
   (`subarray(0, min(expected, len))`) assume the first `expected` bytes are
   what the run wrote; a same-length conflicting prefix is never detected.

## 3. What the existing reflection suite pins

The suite is `src/test-kernel/agent/ReflectionLoop.vitest.ts`. The C15 case
(`describe('an interrupted reflection run')`, `:1120`) interrupts a run with
`interruptedAt(..., 'afterResponse')` — after the response row is committed
but before the raw output write — so the halt leaves `phase: response.ready`,
`lastTurn` set, and `rawOutputBytes` still `0` (`:1213-1221`). It then seeds
the raw output file and resumes the same run, asserting the resulting file
content. The case is `it.effect.each` over four seeds at `:1190-1235`,
`reconciles a reprocessed response by the recorded output byte length
($name)`:

| Seed                           | Rendered test name              | Branch exercised     | Pins                                                |
| ------------------------------ | ------------------------------- | -------------------- | --------------------------------------------------- |
| `null` (file absent)           | `... (missing file)`            | create (`:622-624`)  | PARTIAL with nothing written                        |
| `'round 0 output'`             | `... (completed write)`         | skip (`:614-617`)    | COMPLETE                                            |
| `'stale bytes from the crash'` | `... (different-length debris)` | rewrite (`:626-647`) | CONFLICTING by length                               |
| `'stale 0 output'`             | `... (same-length debris)`      | skip (`:614-617`)    | the gap: same-length conflict is kept, not detected |

The fourth row is the important one: its seed has exactly the fragment's byte
length, so the writer takes the COMPLETE branch and leaves the debris in
place; the assertion `expect(content).toBe('stale 0 output')` (`:1233`)
pins that equal-length conflicting content is **not** repaired. The test's own
doc comment says this explicitly (`:1185-1188`).

The suite runs against a real SQLite session database
(`src/controllers/session/Database.ts` builds an `@effect/sql-sqlite-node`
client) and a real on-disk raw output file (the case writes and reads it via
`node:fs`), so the resume exercises the durable-ledger and on-disk-file
reconciliation path — but it does so **within one process**. No second
process is spawned, so a literal kill-and-restart reopen is not driven here.
The code a reopen takes is identical, because `restore` reads only the
persisted snapshot and the writer reconciles only against the file on disk;
that identity is a source fact, not a suite fact.

## 4. What is unpinned

- **Equal-length conflicting content** is pinned only as _undetected_ (the
  `same-length debris` row). The code has no content check, and no test shows
  a repair, because none exists.
- **The append branch with a non-zero offset** (`reflection.ts:619-621`,
  `actual === expected && actual > 0`) is never exercised: the C15 case always
  interrupts at `rawOutputBytes === 0`, so it always takes the create branch.
  A resume mid-round after earlier cycles already wrote to the file is not
  driven.
- **`restore`'s non-zero `subarray(0, rawOutputBytes)` read**
  (`reflection.ts:446-448`) is never exercised with a non-zero offset, because
  no test resumes at a mid-round phase with a partially written raw output.
- **The `output.pending` → `produceOutput` re-entry** (`reflection.ts:1161-
1162`) is not pinned by any test: nothing lands a run at `output.pending`
  and resumes it, so "re-entry re-runs the pipeline over the same raw output"
  is established from source, not from a suite.
- **A file shorter than the recorded offset** (external truncation) is not
  pinned: the rewrite keeps `min(expected, len)` bytes, appends the fragment,
  and leaves a short file while the offset advances — it does not double-append,
  but it also does not restore the missing prefix.

## 5. Recommendation (stated, not landed)

Keep the offset-and-length writer: it already prevents the duplicate append
that would otherwise repeat paid work, and it repairs different-length debris.
Close the equal-length-content gap without changing the durable record by
reading back the last `fragmentBytes` bytes in the COMPLETE branch before
skipping and comparing them against the fragment about to be written; only
skip on a match, otherwise fall through to the rewrite branch. This uses only
data already in hand (the fragment text and the file) and adds no durable
field, so `SESSION_EVENT_FORMAT` stays at `7` and
`sessionEventFormat.vitest.ts` stays green.

If a content digest is genuinely required, that is a durable-shape change:
it would add a field to `ReflectionSnapshotStateSchema` (`runFlowState.ts`),
bump `SESSION_EVENT_FORMAT` (`sessionEvent.ts:588`), regenerate the
`sessionEventFormat.json` snapshot, and accept that every existing `texra.db`
is cleared by the bump — the session-format version rule. That is not done
here, and the issue does not ask for it.
