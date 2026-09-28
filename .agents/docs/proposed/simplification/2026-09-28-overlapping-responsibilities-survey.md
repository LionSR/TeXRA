# Overlapping-responsibility survey: 2026-09-28

Date: 2026-09-28
Status: proposed (one item shipped directly, see below)
Origin: scheduled audit with the charter "find confusing or overlapped
responsibilities between modules/classes and consolidate the most
significant one."

## Method

Checked the existing record first, since this repo runs this exact audit
routinely: `config/ratchets/refuted-candidates.json`, the 2026-09-23
whole-architecture SSOT/ownership survey, and the 2026-09-27
path-segment/basename-dup note. All eleven filed issues from the
2026-09-23 survey were already merged (#13064). Its "still open" section 4
items (the run/session-fold duplication list) were spot-checked against
current `main`: finding 4 ("the phase-move rule is written four times") is
already fixed — `phaseMoveOf` in `src/shared/session/runRows.ts` is now the
one predicate both `sessionFold.ts` and `transcriptFold.ts` import. The
tool-catalog drift the same survey flagged is also already fixed (compared
current `tool_catalog.md` against the tool registry directly: only
`report_review_issue` was still listed as missing, and that tool no longer
exists in the registry at all — a stale doc reference, not real drift).

A same-day PR (#13435, opened 2026-09-28) fixes another instance of this
exact bug class (`GoalGrants` mirroring core approval state) in the
run/session layer, confirming that area is under active owner iteration —
not a place for an unsupervised pass to add a second, competing fix.

A fresh sweep then covered the less-audited corners: `packages/cli/src`,
`packages/desktop/src`, `packages/trace-viewer`, `scripts/`,
`docs/scripts/`, and `src/latex`, `src/replacement`, `src/housekeeping`,
`src/telemetry`, `src/skills`. Result: clean. Byte/duration formatting,
ANSI handling, markdown pipelines, skill loading, arXiv-ID normalization,
LaTeX formatter dispatch, desktop project-record storage, the main/preload
IPC halves, and the packaging-verification scripts all resolve to one
documented owner already. One thin, sub-bar item surfaced —
`scripts/verify-desktop.mjs`'s local `formatBytes` reimplements
`src/utils/text/stringUtils.ts`'s `formatBytes` because plain Node scripts
under `scripts/` cannot import from the TS/path-alias build; fixing it
would mean a bundling step for one packaging-diagnostic line, not a small
dedup, so it's noted here and left alone.

## Findings

### 1. Fixed directly: `monacoLanguage.ts` re-derives `getBasename`

`src/shared/monaco/monacoLanguage.ts` hand-rolled
`filePath.replaceAll('\\', '/').split('/').at(-1) ?? ''` to get a file's
basename for its Dockerfile/Makefile check, instead of importing
`getBasename` from `@utils/core`. Two owners of one fact, and not
equivalent: the hand-rolled split returns `''` on a trailing slash (a
directory-shaped path such as `/workspace/Dockerfile/`), so that path
silently fell through to `plaintext` instead of being detected as a
Dockerfile. `getBasename('/workspace/Dockerfile/')` correctly returns
`'Dockerfile'`.

This was flagged and deliberately left unfixed in the 2026-09-27 note
because the file's own header warns "no `monaco-editor` import of any kind"
(importing the table used to drag ~12MB of Monaco language workers into
the extension build via Vite's eager `import('...?worker')` handling) and
the note wanted a maintainer to confirm `@utils/core` doesn't carry that
risk before landing the swap. It doesn't: `@utils/core` pulls in only the
small, browser-safe `pathe` + `nanoid`, does no dynamic
`import('...?worker')`, and is already the allowlisted browser-safe util
this module's webview consumers are held to (`BROWSER_SAFE_UTILS` in
`eslint.config.mjs`). That's confirmed
by inspection, not assumption, so the fix ships in this PR rather than
staying a documented-only candidate: one file changed, one regression test
added for the trailing-slash case, `npm run typecheck`, the full
`test:pure` tier (178 files), and `check:dead-code-ratchet` all pass.

### 2. Already resolved: the "two AI agent-creation systems" finding is stale

The 2026-09-23 SSOT survey (section 2) flagged two parallel agent-creation
systems — the VS Code-only `texra.createAgentWithAI` wizard and the bundled
`creator` tool-use agent — as needing an owner ruling, since collapsing them
would reverse two recorded rulings. This draft originally re-cited that
finding as still open without re-verifying it against current `main`. It
isn't: commit `cacc2b07` (#13416, "remove: the Create agent with AI wizard
(use the creator agent or New from template)"), merged the evening before
this audit ran, already deleted the wizard — `agentCreatorFlow.ts`,
`TOOL_GROUPS`, `texra.createAgentWithAI` and the rest of the stack named in
that survey's evidence section are gone, and `CHANGELOG.md:600-601` records
it. The owner already made the ruling. `creator.yaml` is now the one AI
agent-creation system; there is nothing left to consolidate here. (Caught by
review on this PR — see the PR discussion for the correction.)

### 3. Documented, not actioned: path-segment splitting duplicates `pathCore.ts`

Re-confirmed still open and still accurate, see
`.agents/docs/proposed/simplification/2026-09-27-path-segment-and-basename-dup.md`
section 1. Three files (`fileListingRules.ts`, `compiledPdfArtifacts.ts`,
`outputFileUtils.ts`) re-derive path-segment splitting instead of using
`pathCore.ts`'s `getPathSegments`/`toPosixPath`, but at least one of them
(`compiledPdfArtifacts.ts`) differs in `..`-traversal handling (filters a
literal `..` segment vs. resolving it), which is a security-relevant
semantic choice, not a mechanical rename. Left as a design decision for
whoever picks it up, per the existing note.

## Estimated delta

Finding 1 (shipped): +7/-1 production lines (net small positive: the
import plus header note against the one-line simplification), +12 lines of
regression test, one duplicate basename implementation removed, one latent
trailing-slash misclassification fixed.

Finding 2: no code change; the wizard's deletion already shipped in #13416.
This note's job was to catch that its citation here was stale, which it
now does.

Finding 3: no code change; tracked with full evidence in its originating
note, re-verified current here.
