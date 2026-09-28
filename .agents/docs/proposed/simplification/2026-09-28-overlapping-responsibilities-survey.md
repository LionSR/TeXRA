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

### 2. Documented, not actioned: two AI agent-creation systems (needs an owner ruling)

Re-confirmed still open and still accurate: TeXRA ships two ways to create
an agent with AI — the VS Code-only `texra.createAgentWithAI` wizard
(`agentCreatorFlow.ts`, `TOOL_GROUPS`) and the bundled `creator` tool-use
agent (`packages/extension/resources/tool_use_agents/creator.yaml`), each
with its own tool taxonomy. Full evidence and both options are already
written up in
`.agents/docs/proposed/simplification/2026-09-23-ssot-ownership-survey.md`
section 2. Not re-litigated here: collapsing this changes user-visible
behavior and reverses two recorded rulings (the 2026-07-12 "keep validated
template" fallback-audit ruling, and the 2026-09-17 readiness-reverify
decision to keep the `runAgentCreator` boundary open pending a
`HostInteractions` design), so it is a product decision for the repo owner,
not something to fold into an unsupervised structural-audit PR.

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

Finding 1 (shipped): +8/-1 production lines (net small positive: the
import plus header note against the one-line simplification), +28 lines of
regression test, one duplicate basename implementation removed, one latent
trailing-slash misclassification fixed.

Findings 2 and 3: no code change; both already tracked with full evidence
in their originating notes, re-verified current here.
