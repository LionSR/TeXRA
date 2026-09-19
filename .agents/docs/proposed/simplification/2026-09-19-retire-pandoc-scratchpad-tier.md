# Retire the pandoc scratchpad conversion tier

Date: 2026-09-19
Origin: wave-8 simplification survey, utils-common domain (lane "External-binary
probing and scratchpad conversion"). Implemented in the same PR that carries
this note, on the owner ruling recorded below.

## Problem

`src/utils/text/xmlConversion.ts` carried two converters for one string. The
first tier probed for a `pandoc` binary, spawned
`pandoc -f <html|latex> -t markdown`, and rewrote pandoc's three reference
shapes back to `\ref{}` / `\eqref{}` / `\cref{}` (34 lines of compiled regex
pairs plus a format detector). The second tier — Turndown for HTML, a ten-entry
replacement table for LaTeX — ran only when pandoc was absent or its spawn
failed.

Consumer evidence at `main` 893cc3dbbb:

- `formatContent` had exactly one production consumer, `extractScratchpad`
  (`src/utils/text/xmlExtraction.ts:155`), which itself has exactly one caller:
  `src/agent/runtime/loop/reflection.ts:683`, one log line per reflection round.
  Its second importer, `src/test-kernel/utils/text/xmlUtils.vitest.ts:4`, was an
  unused import left behind with a `vi.mock` of `checkToolInstalled` whose only
  purpose was to force the fallback tier so the suite would not assert
  differently on a machine with pandoc installed.
- So the whole tier decided the rendering of one model-authored scratchpad,
  which is Markdown in practice — and a Markdown scratchpad short-circuited
  out of pandoc unchanged anyway (`detectInputFormat` returned `MARKDOWN` and
  `convertWithPandoc` returned the input).
- The cost fell on every user: the `pandoc --version` probe ran once per
  process on the machines that have pandoc, and the cached negative answer
  (`Effect.cachedWithTTL` with a zero TTL on failure, added in #12805) meant a
  machine _without_ pandoc re-spawned the probe once per reflection round for
  the life of the session.
- CI never exercised the pandoc tier: the only suite that reached
  `formatContent` mocked it away, so the branch shipped unpinned.

## Proposal

Delete the tier. `formatContent` keeps the deterministic Turndown/regex path
and becomes an ordinary synchronous function; `OutputFormat`,
`detectInputFormat`, the `pandocProbe` singleton and `isPandocAvailable`,
`PANDOC_REFERENCE_REWRITES`, `normalizePandocReferences` and
`convertWithPandoc` go, together with the `pandoc` `TOOL_CONFIGS` entry
(`src/utils/system/toolUtils.ts`) and `PANDOC_INSTALL_GUIDE`
(`src/shared/constants/latexToolchain.ts`), which had no other reader.

## What we give up

A user who has pandoc installed _and_ whose model writes a LaTeX or HTML
scratchpad now sees the Turndown/regex rendering of that scratchpad instead of
pandoc's. Pandoc's reference rewriting is the concrete loss: `\ref{eq:1}`
survived a pandoc round trip and is simply left alone by the fallback, which
does not touch `\ref` at all. No document output, no compile path and no
persisted row is involved — this is the scratchpad panel only. Pandoc was never
documented as a TeXRA dependency (no occurrence anywhere in `docs/` or
`packages/extension/resources/`); its one user-facing mention is a 0.x
changelog line about improving the fallback.

Owner ruling (2026-09-19): the conversion tier is retired and the scratchpad
renders through the fallback path only.

## Acceptance criteria

- No production module spawns or probes `pandoc`.
- `extractScratchpad` returns the same text for a Markdown scratchpad, the
  overwhelming majority case, on every machine.
- The retirement is noted in the changelog as a user-facing change.

## Risks

Low. The one behavioral difference is confined to a non-Markdown scratchpad on
a machine with pandoc, and the fallback it lands on is the path CI has always
pinned. Reversing the decision means restoring one file's deleted half; nothing
downstream was reshaped around it.
