# PRD: Automatic LaTeX Compilation, Fragment Handling, and latexFixer Agent

**Owner:** TBD
**Status:** Draft
**Branch:** `claude/auto-compile-pdf-output-rhqla`

---

## 1. Summary

After every workflow round, TeXRA must automatically produce a viewable PDF (or a clear failure log), handle the case where the LLM emits a partial fragment instead of a full file, recover from compile errors via a bounded LLM-driven fix attempt, generate a clean "changes-only" latexdiff PDF, and surface results to the user without polluting their workspace.

## 2. Problem

Today:

- Compile-after-output exists (`compileCheck.ts`) but failures are silent — user only sees them by digging into a log file.
- Fragments (no `\documentclass`) are silently skipped — never compiled.
- Latexdiff `.tex` files are written **inside the user's workspace**, polluting git and the file tree (`LatexDiffManager.buildSiblingDiffLocation`, comment at line 306–310).
- Compile errors are not fed back to the orchestrator; subsequent rounds don't know the previous round failed to compile.
- Diff PDFs frequently contain `??` for citations because latexdiff wraps `\cite` and bibtex doesn't recognise `\DIFcite`.
- No PDF surfacing — user must navigate the file tree to open the result.
- Existing LaTeX/compile settings live in `vscode.workspace.getConfiguration` rather than TeXRA's storage-backed settings UI.

## 3. Goals

1. Every successful round opens a PDF; every failed round opens its truncated log.
2. Fragments compile by inferring a preamble from the workspace (main file via `\input`/`\include` map → newest workspace `.tex` with `\documentclass`).
3. Compile failures trigger a single bounded fix attempt by a tool-using LLM agent (`latexFixer`) before surfacing the failure.
4. Compile result is a first-class signal in the round loop — failure can reject the round and inject the log into the next round's context.
5. Diff `.tex` and diff PDF live in shadow storage, never in the user's workspace.
6. Diff PDFs render citations correctly (no spurious `??`).
7. Compiled PDFs (main + diff) are persisted across cleanup.
8. All compile/diff/auto-fix settings live in TeXRA's storage layer and are surfaced in the **LaTeX** tab of `settingsView`.

## 4. Non-goals

- New PDF viewer, webview, or annotation UI. Use `vscode.open` and rely on the user's installed PDF extension.
- Splice-mode fragment compile (replacing fragment into a copy of main and compiling that). Deferred until standalone-mode feedback proves it insufficient.
- Multi-pass fix loops. Hard cap at 1 attempt = 3 internal tool-use turns.
- Migrating non-LaTeX VS Code config keys to storage.
- Copying compiled PDFs into the user's workspace.
- Tool-use agent for preamble selection on the happy path. Only the deterministic resolver runs first; the agent appears only on compile failure.
- Persistent on-disk preamble cache. In-memory per-run scan only.

## 5. User stories

- **As a researcher running an enhance workflow,** I want to see the rendered PDF the moment the workflow finishes, without opening the file tree.
- **As a researcher iterating on a chapter,** when the agent emits only the chapter (no `\documentclass`), I want it compiled with my project's actual preamble so I can review the PDF.
- **As a researcher reviewing changes,** I want a changes-only diff PDF that doesn't show pages full of unchanged text, with citations rendered correctly, kept out of my git tree.
- **As a researcher whose round produced a syntactically broken `.tex`,** I want TeXRA to attempt a one-shot fix before showing me the failure.
- **As a researcher with strong opinions about LaTeX behaviour,** I want all compile/diff/fix settings in one tab in the TeXRA settings UI, not scattered between TeXRA storage and `settings.json`.

## 6. Functional requirements

### 6.1 Auto-open PDF / log

After each round, in `finalOutputOpener.ts`:

- If compile succeeded: `vscode.commands.executeCommand('vscode.open', pdfUri, { viewColumn: Beside })`.
- If compile failed: open the truncated `.log`.
- Same path used for the diff PDF when available.
- Gated by `WORKFLOW_AUTO_OPEN_PDF` (default on).

### 6.2 Diff in shadow storage

- Write all diff `.tex` and diff build artifacts to `<runDir>/diff/r<round>/...`.
- Remove `buildSiblingDiffLocation`'s "next to the base" placement.
- Verify `MediaExtractionNode` mirrors `.bib`, `.cls`, `.sty`, and `\input` targets into `<runDir>/diff/r<round>/` so latexmk resolves them.
- The latexFixer agent's `compile_tex` tool operates on real disk paths — no virtual filesystems.

### 6.3 Fragment compile (deterministic wrap)

When `XmlOutputManager` extracts a `<document name="X">` lacking `\documentclass`:

1. **Resolve preamble**, in order:
   1. Workspace parent map: scan `.tex` files via `extractFileDependencies.ts`, build `child → parent`. If `X` (or `X.tex`) has a parent with `\documentclass`, use that parent's preamble.
   2. Agent input file's preamble, if it has `\documentclass`.
   3. Newest workspace `.tex` with `\documentclass` (mtime tiebreak).
   4. Skip with a clear log line — do not compile, do not invoke latexFixer.
2. **Wrap**: `<preamble>\n\begin{document}\n<fragment>\n\end{document}`. `extractPreamble()` returns content up to but excluding `\begin{document}` (conventional definition), so the wrap explicitly inserts the document boundary. Save to `<runDir>/compile/r<round>/<name>__wrap.tex`.
3. **Compile** via existing `compileLatex2Pdf` with `latexmk -pdf`.
4. Resolution source is logged: `Compile (fragment): preamble from <source description>`.
5. Gated by `WORKFLOW_FRAGMENT_COMPILE` (default on).

### 6.4 latexFixer agent

- New agent YAML: `resources/agents/latexFixer.yml`.
- Built on existing `src/agent/implementations/flows/tool-use/` substrate.
- Default model: cheap (Haiku-class).
- **Tools available:**
  - `compile_tex(path)` → `{ success, logExcerpt, pdfPath? }`. New tool in `src/tools/`. Body stays `vscode`-free — delegates to `src/latex/texTools.ts` (`compileLatex2Pdf`).
  - `read_file(path)` — existing.
  - `edit_file(path, ...)` — existing.
  - `open_pdf(path)` — new tool in `src/tools/`. Body stays `vscode`-free; it invokes an injectable opener callback (mirrors the `setExtensionChecker()` pattern in `src/tools/external/externalToolDefs.ts`). The callback is registered at extension activation from the command/frontend layer and performs `vscode.commands.executeCommand('vscode.open', ...)`. If no callback is registered the tool returns a structured "not available" result instead of importing `vscode`.
- **Constraints:**
  - 3 internal turns max.
  - Wall-clock cap: `WORKFLOW_AUTO_COMPILE_TIMEOUT_MS × 3`.
  - Edits restricted to `<runDir>/...`. User's workspace files are read-only.
  - Single attempt — no retry of the agent itself.
- Triggered when deterministic compile fails and `WORKFLOW_AUTO_FIX_COMPILE` is on (default on).
- Used for both fragment-wrap failures and full-file failures — one path.

### 6.5 Compile result → round loop

In `RoundPersistedFlow.shouldContinueNextRound()`:

- Add one clause: if `lastCompileResult.status === "failed"` and `WORKFLOW_REJECT_ON_COMPILE_FAILURE` is on, the round is marked rejected.
- The truncated compile log is injected into the next round's context (whether the next round is the user's planned next round or a follow-up triggered by rejection — semantics confirmed in §10 Q1).
- Compile result stored in `shared.lastCompileResult` for the orchestrator to consume.
- No new node, no new metadata fields on `WorkflowFlowResult` for round-level decisions until UI consumes them.

### 6.6 Latexdiff bib quality

- Default `latexdiff` invocation passes `--exclude-textcmd="cite,citep,citet,citeauthor,citeyear,..."` so citations remain unwrapped and bibtex resolves them.
- `latexmk` invoked with `BIBINPUTS`/`BSTINPUTS` env vars set to the workspace TeX roots, in addition to symlinked deps.
- Verify the symlink mirroring covers fragment wraps and diff `.tex` (not just main compiles).

### 6.7 Latexdiff changes-only

- Default on (`LATEXDIFF_CHANGES_ONLY`). Apply via the appropriate latexdiff flag — exact spelling pinned at implementation time after verifying the shipped binary.
- If unavailable in the shipped version: fallback is post-process the diff PDF with `pdftk` keeping pages containing `\DIFadd`/`\DIFdel` markers. If neither works in our deployment, surface the setting as no-op and document the version requirement.

### 6.8 PDF persistence

- Housekeeping cleanup excludes `*.pdf` under `<runDir>/compile/` and `<runDir>/diff/`.
- Final round's main PDF and final diff PDF symlinked to:
  - `<runDir>/output/<name>.pdf`
  - `<runDir>/output/<name>-diff.pdf`
- The latexFixer agent and `open_pdf` tool reference `<runDir>/output/...` for stable paths.

### 6.9 Settings storage migration + LaTeX tab

**Migrated to `WorkspaceStateKey` in `src/common/state/stateManager.ts`:**

| Old `vscode` config | New storage key |
|---|---|
| `texra.workflow.autoCompileAfterOutput` | `WORKFLOW_AUTO_COMPILE` |
| `texra.workflow.autoCompileTimeoutMs` | `WORKFLOW_AUTO_COMPILE_TIMEOUT_MS` |
| `texra.latexdiff.generateBetweenRoundDiffs` | `LATEXDIFF_BETWEEN_ROUNDS` |
| `texra.latexdiff.timeoutMs` | `LATEXDIFF_TIMEOUT_MS` |
| `texra.latexdiff.mathMarkup` | `LATEXDIFF_MATH_MARKUP` |
| `texra.latex.formatter` | `LATEX_FORMATTER` |

**New keys:**

| Key | Type | Default | Purpose |
|---|---|---|---|
| `WORKFLOW_AUTO_OPEN_PDF` | bool | true | Open PDF (or log) after each round |
| `WORKFLOW_FRAGMENT_COMPILE` | bool | true | Enable deterministic fragment wrap+compile |
| `WORKFLOW_AUTO_FIX_COMPILE` | bool | true | Run latexFixer on compile failure |
| `WORKFLOW_REJECT_ON_COMPILE_FAILURE` | bool | true | Compile failure rejects round, feeds log to next |
| `LATEXDIFF_CHANGES_ONLY` | bool | true | Render only changed pages in diff PDF |

**Migration:** on activation, for each migrated key, if storage has no value but `vscode.workspace.getConfiguration` does, copy it over once. Then remove from `package.json` `contributes.configuration`. Migration commit lands first, isolated from feature work.

**UI:** Surface all keys in the existing **LaTeX** tab (`src/settingsView/handlers/latexSettingsHandlers.ts`, `src/settingsView/frontend/SettingsApp.ts`).

## 7. Non-functional requirements

- **Cost control.** latexFixer is gated, single attempt, capped at 3 turns, on a cheap model by default.
- **Determinism first.** Deterministic wrap runs before any LLM call. Agent only on failure.
- **No workspace pollution.** No new files written under the user's workspace by default. Only the `.pdf` outputs are exposed to the user, and only via `vscode.open` (no copies).
- **No regressions on existing config.** Migration preserves user-set values.
- **Logging.** Each automated step (preamble source, compile invocation, latexFixer attempt, latexdiff flags) emits one log line on the existing channel.

## 8. Architecture impact

| Area | Change |
|---|---|
| `src/common/state/stateManager.ts` | New keys; migration helper. |
| `src/settingsView/handlers/latexSettingsHandlers.ts` + frontend | Read/write new keys. |
| `package.json` | Remove migrated `contributes.configuration` entries. |
| `src/agent/output/LatexDiffManager.ts` | Diff write path → `<runDir>/diff/...`; pass `--exclude-textcmd` and changes-only flags; `BIBINPUTS` env. |
| `src/latex/latexdiff.ts` | Accept explicit output dir; honour new flags. |
| `src/agent/output/compileCheck.ts` | Call new fragment-wrap helper before bailing on missing `\documentclass`; emit `lastCompileResult` to shared state. |
| `src/agent/output/fragmentWrap.ts` (new) | Resolve preamble → wrap fragment → return location to compile. ~100 lines. |
| `src/latex/extractFileDependencies.ts` (or sibling) | Add `extractPreamble()`; add `buildParentMap()`. |
| `src/agent/node/roundPersistedFlow.ts` | One clause in `shouldContinueNextRound`; one line of context injection. |
| `src/tools/` | New `compile_tex` tool (delegates to `src/latex/texTools.ts`); new `open_pdf` tool (body `vscode`-free, calls an injectable opener callback). |
| `src/extension.ts` (or equivalent activation site) | Register the `open_pdf` opener callback that invokes `vscode.commands.executeCommand('vscode.open', ...)`. Mirrors the `setExtensionChecker()` pattern. |
| `resources/agents/latexFixer.yml` | New agent definition. |
| `src/agent/implementations/flows/reflection/nodes/OutputNode.ts` | Hand off to latexFixer on failure when setting is on. |
| `src/frontend/agents/finalOutputOpener.ts` | Open PDF or log via `vscode.open`. |
| `src/housekeeping/` | Exclude `*.pdf` from cleanup under runDir. |

## 9. Phases

Each phase is independently shippable.

1. **Settings migration** to storage + LaTeX tab. No feature changes. Lands first.
2. **Diff → shadow storage.** Fixes the workspace-pollution bug.
3. **Auto-open PDF / log** + PDF persistence (housekeeping rule + output symlinks).
4. **Fragment wrap** (deterministic, no agent).
5. **Tools:** `compile_tex`, `open_pdf`.
6. **latexFixer agent + wiring** on failure.
7. **Compile result → round loop** (reject + log injection).
8. **Latexdiff bib quality** (`--exclude-textcmd`, `BIBINPUTS`).
9. **Latexdiff changes-only** (after verifying flag in shipped binary).

## 10. Open questions

1. **Round-loop semantics on rejection:** does a rejected round consume a slot from the user's requested round count (replace), or extend total rounds by up to N (extend)? *Recommendation: replace. Same total cost, simpler.*
2. **Diff location confirmation:** `<runDir>/diff/...` (real on-disk path under extension storage) — confirm this satisfies "real filesystem" and the latexFixer agent can drive it. If the intent was actually "in the user's workspace," reopen.
3. **Workspace PDF copy:** off entirely, or off-by-default with a setting (`WORKFLOW_COPY_PDF_TO_WORKSPACE`, gitignore-friendly subdir)?
4. **Latexdiff `--only-changes` exact flag and version floor:** verify at implementation time.

## 11. Out of scope / future work

- **Splice mode** for fragments. Adds correct context for cross-references. Reopen if the standalone PDF too often lacks resolved `\ref`/`\cite` for fragment-only cases.
- **Tool-use preamble resolver** (LLM picks preamble before compile). Reopen only with measured evidence the deterministic resolver is wrong.
- **Persistent preamble cache** in storage. Reopen if scan time becomes a profile hotspot.
- **Round-decision metadata in progress view UI** (per-round accept/reject badges). Reopen when there is a UI consumer.
- **Multi-attempt fix loops.** Reopen with measured data showing single-attempt success rate is too low.
- **Webview-based PDF / diff viewer** with side-by-side or annotation. Out of scope.
- **Migration of non-LaTeX VS Code config to storage.** Separate effort.

## 12. Acceptance criteria

- After running an enhance/rewrite/critique workflow on a multi-file LaTeX project:
  - The revised `.tex` opens in the editor (existing behaviour).
  - The compiled PDF opens beside it automatically when compile succeeds.
  - The truncated log opens beside it when compile fails (and latexFixer also fails).
  - The diff PDF is produced in `<runDir>/diff/...`, opened automatically, contains no `??` for citations on a project with a working bib setup.
  - No new files appear in the user's workspace tree.
- After running a workflow whose agent emits a chapter fragment:
  - The fragment compiles using the project's main preamble.
  - Logs show which preamble source was used.
- When the LLM emits broken `.tex`:
  - latexFixer runs (one attempt, ≤ 3 tool turns).
  - On agent success: PDF opens.
  - On agent failure: log opens; round is marked rejected; next round (if any) receives the truncated log.
- Settings UI:
  - All compile/diff/fix knobs in the LaTeX tab.
  - Pre-existing user settings carry over from `settings.json` after migration without user intervention.

