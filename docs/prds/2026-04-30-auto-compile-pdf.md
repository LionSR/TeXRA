---
created: 2026-04-30
updated: 2026-06-07
---

# PRD: Automatic LaTeX Compilation, Fragment Handling, and latexFixer Agent

## Status: Draft

## 1. Summary

After every workflow round, TeXRA must automatically produce a viewable PDF (or a clear failure log), handle the case where the LLM emits a partial fragment instead of a full file, recover from compile errors via a bounded LLM-driven fix attempt, generate a clean "changes-only" latexdiff PDF, and surface results to the user without polluting their workspace.

## 2. Problem

Today:

- Compile-after-output exists (`compileCheck.ts`) and failures _are_ surfaced — `OutputNode` emits `updateCompileFailures` events that render in the progress view via `compile-failure-panel` (with an "Open log" action). But failures are not promoted as primary output: the resulting PDF is not auto-opened on success, the log is not auto-opened on failure, and the user has to switch to the progress view to act on either.
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

After each round, in `finalOutputOpener.ts`. **All branches below are keyed on the _final_ post-fixer compile status** (same `lastCompileResult` defined in §6.5) — never on the initial failed compile attempt. A round whose initial compile failed but whose latexFixer pass repaired it sees only the success branch; no failure log is opened.

- If final status is `"ok"`: `vscode.commands.executeCommand('vscode.open', pdfUri, { viewColumn: vscode.ViewColumn.Beside })`.
- If final status is `"failed"` (initial compile failed and either latexFixer also failed, or `WORKFLOW_AUTO_FIX_COMPILE` is off, or the failure is a fragment-wrap failure per §6.3 step 4): open the truncated `.log`.
- Same path used for the diff PDF when available.
- Gated by `WORKFLOW_AUTO_OPEN_PDF` (default on).

### 6.2 Diff in shadow storage

- Write all diff `.tex` and diff build artifacts to `<runDir>/diff/r<round>/...`.
- Remove `buildSiblingDiffLocation`'s "next to the base" placement.
- Verify `MediaExtractionNode` mirrors `.bib`, `.cls`, `.sty`, and `\input` targets into `<runDir>/diff/r<round>/` so latexmk resolves them.
- All compile invocations (deterministic compileCheck and any latexFixer-triggered `bash latexmk` run) operate on real disk paths — `<runDir>/...` for shadow artifacts, workspace paths post-accept. No virtual filesystems.

### 6.3 Fragment compile (deterministic wrap)

When `XmlOutputManager` extracts a `<document name="X">` lacking `\documentclass`:

1. **Resolve preamble**, in order:
   1. Workspace parent map: scan `.tex` files via `extractFileDependencies.ts`, build `child → parent`. If `X` (or `X.tex`) has a parent with `\documentclass`, use that parent's preamble.
   2. Agent input file's preamble, if it has `\documentclass`.
   3. Newest workspace `.tex` with `\documentclass` (mtime tiebreak).
   4. **No preamble found:** set `lastCompileResult = { status: "failed", reason: "fragment-no-preamble", logExcerpt: "<one-line: no preamble source available for fragment <X>" }` so §6.1 (auto-open log) and §6.5 (round rejection) have a concrete terminal status to branch on. Do not compile, do not invoke latexFixer. Same handling as a wrap-compile failure (step 4 below) — log auto-opens, round is rejected per `WORKFLOW_REJECT_ON_COMPILE_FAILURE`.
2. **Wrap**: `<preamble>\n\begin{document}\n<fragment>\n\end{document}`. `extractPreamble()` returns content up to but excluding `\begin{document}` (conventional definition), so the wrap explicitly inserts the document boundary. Save to `<runDir>/compile/r<round>/<name>__wrap.tex`.
3. **Compile** via existing `compileLatex2Pdf` with `latexmk -pdf`.
4. **On wrap-compile failure**, surface the truncated log via the auto-open path (§6.1). **latexFixer is _not_ invoked for fragment-wrap failures.** The wrap lives in `<runDir>/compile/r<round>/<name>__wrap.tex`, and post-accept the workspace contains only the raw unwrapped fragment (no `\documentclass`); latexFixer's `read_file`/`edit_file` are workspace-scoped and would have nothing meaningful to compile or fix without re-wrapping (which is unspecified). Pre-accept fixing of the wrap requires the run-storage-aware file tools deferred in §6.4. So fragment-wrap failures fall through to the user until that follow-up lands.
5. Resolution source is logged: `Compile (fragment): preamble from <source description>`.
6. Gated by `WORKFLOW_FRAGMENT_COMPILE` (default on).

### 6.4 latexFixer agent

- **The agent already exists** at `resources/tool_use_agents/latexFixer.yaml` and runs on the existing `src/agent/implementations/flows/tooluse/` substrate. This PRD wires it into the post-compile failure path; it does not introduce a new YAML.
- Default model: kept as configured in the existing YAML (cheap / tool-use class).
- **Tools (already declared in the YAML):** `bash`, `read_file`, `edit_file`, `glob`, `grep`, `ls`, `diagnostics`, `executions`. No `compile_tex` tool is introduced — `bash` already runs `latexmk -pdf -interaction=nonstopmode` per the existing system prompt.
- **New optional tool:** `open_pdf(path)` in `src/tools/`. Body stays `vscode`-free; it invokes a host-owned opener callback, following the same host-capability boundary as typed `Platform` ports. The callback is registered at extension activation from the command/frontend layer and performs `vscode.commands.executeCommand('vscode.open', ...)`. If no callback is registered the tool returns a structured "not available" result instead of importing `vscode`. **Whether to expose this to latexFixer or to keep PDF opening orchestrator-driven is open (§10 Q5).**
- **File-tool path scope (important architectural constraint):** the existing `read_file`/`edit_file` tools operate on **workspace** paths only; they cannot read or edit `<runDir>/...`. The existing latexFixer prompt encodes this: run-storage is read-only via the `executions` tool; edits happen post-`accept_run_files` on the workspace. This contradicts an earlier draft of this PRD that restricted edits to `<runDir>/...`. The chosen approach (see §10 Q4):
  - **Default:** invoke latexFixer **post-accept** on workspace files. Matches the existing tool semantics; no new file-tool work.
  - **Pre-accept (shadow-mode) compile-fix is deferred** until a follow-up effort introduces run-storage-aware file tools (either by extending `read_file`/`edit_file` with explicit path-scoping/authorization or by adding `read_run_file`/`edit_run_file` variants).
- **Constraints:**
  - 3 internal turns max (orchestrator-enforced ceiling on top of whatever the YAML allows).
  - Wall-clock cap: `WORKFLOW_AUTO_COMPILE_TIMEOUT_MS × 3`.
  - Single attempt — no retry of the agent itself.
  - **latexFixer must not touch the diff.** It is forbidden to read, edit, copy, move, or regenerate diff `.tex` / diff `.pdf` files (they live in `<runDir>/diff/...`, shadow storage). It is forbidden to bring the diff into the user's workspace under any name. The diff is purely a review artifact for the user; only the orchestrator and the auto-open path interact with it. The agent's mandate is the compile of the main `.tex` files post-accept; touching the diff would corrupt the audit trail and pollute the workspace.
- Triggered when a **full-file** post-accept compile fails and `WORKFLOW_AUTO_FIX_COMPILE` is on (default on).
- **Scope: full-file failures only.** Fragment-wrap failures (per §6.3 step 4) are surfaced to the user via the log-open path and do not invoke latexFixer; the wrapped `.tex` lives only in `<runDir>/...` and the workspace contains the raw fragment, neither of which the current workspace-scoped file tools can act on usefully. Extending latexFixer to the fragment case is part of the same deferred run-storage-aware-tools effort.

### 6.5 Compile result → round loop

In `RoundPersistedFlow.shouldContinueNextRound()`:

- Add one clause: if `lastCompileResult.status === "failed"` and `WORKFLOW_REJECT_ON_COMPILE_FAILURE` is on, the round is marked rejected.
- **`lastCompileResult` is the _final_ compile status for the round, after any latexFixer pass.** If latexFixer was invoked and produced a clean compile, the result is `"ok"` and the round is _not_ rejected — the user does not lose a slot for a successfully-repaired round. Only when latexFixer also fails (or wasn't invoked because `WORKFLOW_AUTO_FIX_COMPILE` is off, or the failure is a fragment-wrap failure per §6.3 step 4) does the status remain `"failed"` and trigger rejection.
- The truncated compile log is injected into the next round's context. **Round-loop semantics on rejection: replace, not extend** — a rejected round consumes a slot from the user's requested round count, so total rounds (and total cost) are unchanged regardless of how many compile failures occur. The next round is therefore always the user's already-planned next round (carrying compile-log context); there is no separate "fix-only" round inserted on top.
- Final compile result stored in `shared.lastCompileResult` for the orchestrator to consume. Intermediate (pre-fixer) failures are not exposed to the round-decision clause to avoid double-counting.
- No new node, no new metadata fields on `WorkflowFlowResult` for round-level decisions until UI consumes them.

### 6.6 Latexdiff bib quality

- Default `latexdiff` invocation passes `--exclude-textcmd="cite,citep,citet,citeauthor,citeyear,..."` so citations remain unwrapped and bibtex resolves them.
- `latexmk` invoked with `BIBINPUTS`/`BSTINPUTS` env vars **prepended** to the kpathsea default search path, not replacing it. Use the trailing-separator convention so kpathsea's compiled-in defaults are preserved: `BIBINPUTS="<workspace-roots>:"` on POSIX, `BIBINPUTS="<workspace-roots>;"` on Windows (likewise for `BSTINPUTS`). Without the trailing separator, standard `.bst` files such as `plain.bst` would no longer resolve and otherwise-valid latexdiff builds would fail at bibtex.
- Verify the symlink mirroring covers fragment wraps and diff `.tex` (not just main compiles).

### 6.7 Latexdiff changes-only

- Default on (`LATEXDIFF_CHANGES_ONLY`). Apply via the appropriate latexdiff flag — exact spelling pinned at implementation time after verifying the shipped binary.
- **No PDF post-processing fallback.** A previously sketched "scan rendered PDF text for `\DIFadd`/`\DIFdel` and keep those pages with `pdftk`" approach does not work — those are LaTeX source macros that latexdiff transforms into typeset markup at compile time and are _not_ preserved as literal strings in the PDF text layer. If the shipped `latexdiff` lacks the changes-only flag, `LATEXDIFF_CHANGES_ONLY` becomes a no-op with a one-time warning logged and a documented minimum-version requirement. Any source-side fallback (e.g., wrapping changed blocks with `\includeonly` regions or using `latexdiff --append-mboxcmd` patterns to introduce markers we can read from compile metadata) is deferred and not in scope for this phase.

### 6.8 PDF persistence

- Housekeeping cleanup excludes `*.pdf` under `<runDir>/compile/` and `<runDir>/diff/`.
- **Per-round stable paths.** After every round (not just the final one), update symlinks:
  - `<runDir>/output/r<round>/<name>.pdf` — the round's main PDF.
  - `<runDir>/output/r<round>/<name>-diff.pdf` — the round's diff PDF, when one was generated.
- **"Latest" convenience symlinks** also refreshed every round:
  - `<runDir>/output/latest/<name>.pdf` and `<runDir>/output/latest/<name>-diff.pdf` always point at the most recently compiled round. The auto-open path (§6.1) uses `latest/` so the user sees fresh artifacts each round; the per-round paths exist for archival/reference (e.g. user clicking back to round 2's PDF after round 3 has run).
- `open_pdf` and the auto-open code reference `<runDir>/output/r<round>/...` for round-specific opens and `<runDir>/output/latest/...` for the default after-round behavior. **Never** the bare `<runDir>/output/<name>.pdf` (which doesn't exist) — that earlier draft was final-round-only and conflicted with §6.1's per-round contract.
- latexFixer operates on workspace files post-`accept_run_files`; it inspects PDFs (when needed) via `bash` or `executions`, not via `open_pdf`.

### 6.9 Settings storage migration + LaTeX tab

**Migrated to `WorkspaceStateKey` in `src/common/state/stateManager.ts`:**

| Old `vscode` config                         | New storage key                    |
| ------------------------------------------- | ---------------------------------- |
| `texra.workflow.autoCompileAfterOutput`     | `WORKFLOW_AUTO_COMPILE`            |
| `texra.workflow.autoCompileTimeoutMs`       | `WORKFLOW_AUTO_COMPILE_TIMEOUT_MS` |
| `texra.latexdiff.generateBetweenRoundDiffs` | `LATEXDIFF_BETWEEN_ROUNDS`         |
| `texra.latexdiff.timeoutMs`                 | `LATEXDIFF_TIMEOUT_MS`             |
| `texra.latexdiff.mathMarkup`                | `LATEXDIFF_MATH_MARKUP`            |
| `texra.latex.formatter`                     | `LATEX_FORMATTER`                  |

**New keys:**

| Key                                  | Type | Default | Purpose                                          |
| ------------------------------------ | ---- | ------- | ------------------------------------------------ |
| `WORKFLOW_AUTO_OPEN_PDF`             | bool | true    | Open PDF (or log) after each round               |
| `WORKFLOW_FRAGMENT_COMPILE`          | bool | true    | Enable deterministic fragment wrap+compile       |
| `WORKFLOW_AUTO_FIX_COMPILE`          | bool | true    | Run latexFixer on compile failure                |
| `WORKFLOW_REJECT_ON_COMPILE_FAILURE` | bool | true    | Compile failure rejects round, feeds log to next |
| `LATEXDIFF_CHANGES_ONLY`             | bool | true    | Render only changed pages in diff PDF            |

**Migration:** on activation, for each migrated key, copy a value into storage **only when the user (or workspace) has explicitly set it**. Use `vscode.workspace.getConfiguration().inspect(key)` and consider only `workspaceFolderValue`, `workspaceValue`, `globalValue` (in that precedence order) — never `defaultValue`. This avoids persisting VS Code's compiled-in defaults into workspace state, which would otherwise prevent future default changes from taking effect and create silent config drift across upgrades. **Gate per workspace, not per user.** The migration writes to `WorkspaceStateKey` (per-workspace storage), so a global once-per-user marker (e.g. `GlobalStateKey.LATEX_CONFIG_VERSION`) would let the first opened workspace consume the migration and silently drop config in every other workspace. Use either a workspace-scoped marker (e.g. a new `WorkspaceStateKey.LATEX_SETTINGS_MIGRATED`) **or**, simpler and equivalent, a per-key idempotent rule: only copy a key when its workspace storage is currently empty. The per-key rule is preferred — no marker needed, naturally idempotent, and rerunning on a future TeXRA upgrade just no-ops.

**Ordering invariant.** Migration is one logical unit but lands in three sub-commits to keep each reviewable; the ordering between them is not optional:

1. **Add storage keys + migration helper.** New `WorkspaceStateKey` entries + the per-key copy-on-activation logic. Legacy `getConfig('texra.…')` readers continue to work because the `package.json` entries are still present.
2. **Rewire all runtime readers** to `workspaceSM.get(...)`. This includes the 10 known call-sites: `compileCheck.ts` (×2), `LatexDiffManager.ts` (×2), `latexdiff.ts`, `latexdiff/diffCommandExecutor.ts`, `texFormatter.ts`, `housekeeping/indent.ts`, `latexdiffCommands.ts` (×2). Also remove the migrated keys from the `ConfigTools.ts` setup-wizard `UPDATABLE_KEYS` allowlist (and its test) — that path was the wizard's only legitimate reason to write into VS Code config and is now obsolete.
3. **Remove `contributes.configuration` entries** from `package.json`.

Sub-commit 3 must not land before sub-commit 2. There must be no window in which the legacy keys exist in `package.json` but are no longer read by runtime code (would silently fall back to defaults), nor a window in which runtime readers point at empty storage while the legacy keys are gone (same outcome). Sub-commit 1 is safe to land alone because it's purely additive. Migration sequence lands first overall, isolated from feature work.

**UI:** Surface all keys in the existing **LaTeX** tab (`packages/extension/src/settingsView/handlers/latexSettingsHandlers.ts`, `packages/extension/src/settingsView/frontend/SettingsApp.ts`).

## 7. Non-functional requirements

- **Cost control.** latexFixer is gated, single attempt, capped at 3 turns, on a cheap model by default.
- **Determinism first.** Deterministic wrap runs before any LLM call. Agent only on failure.
- **No workspace pollution.** No new files written under the user's workspace by default. Only the `.pdf` outputs are exposed to the user, and only via `vscode.open` (no copies).
- **No regressions on existing config.** Migration preserves user-set values.
- **Logging.** Each automated step (preamble source, compile invocation, latexFixer attempt, latexdiff flags) emits one log line on the existing channel.

## 8. Architecture impact

| Area                                                                               | Change                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common/state/stateManager.ts`                                                 | New keys; migration helper.                                                                                                                                                                                |
| `packages/extension/src/settingsView/handlers/latexSettingsHandlers.ts` + frontend | Read/write new keys.                                                                                                                                                                                       |
| `package.json`                                                                     | Remove migrated `contributes.configuration` entries.                                                                                                                                                       |
| `src/agent/output/LatexDiffManager.ts`                                             | Diff write path → `<runDir>/diff/...`; pass `--exclude-textcmd` and changes-only flags; `BIBINPUTS` env.                                                                                                   |
| `src/latex/latexdiff.ts`                                                           | Accept explicit output dir; honour new flags.                                                                                                                                                              |
| `src/agent/output/compileCheck.ts`                                                 | Call new fragment-wrap helper before bailing on missing `\documentclass`; emit `lastCompileResult` to shared state.                                                                                        |
| `src/agent/output/fragmentWrap.ts` (new)                                           | Resolve preamble → wrap fragment → return location to compile. ~100 lines.                                                                                                                                 |
| `src/latex/extractFileDependencies.ts` (or sibling)                                | Add `extractPreamble()`; add `buildParentMap()`.                                                                                                                                                           |
| `src/agent/node/roundPersistedFlow.ts`                                             | One clause in `shouldContinueNextRound`; one line of context injection.                                                                                                                                    |
| `src/tools/`                                                                       | New `open_pdf` tool (body `vscode`-free, calls an injectable opener callback). No `compile_tex` — latexFixer already calls `latexmk` via the existing `bash` tool.                                         |
| `packages/extension/src/extension.ts` (or equivalent activation site)              | Register the `open_pdf` opener callback that invokes `vscode.commands.executeCommand('vscode.open', ...)`, keeping host-specific UI work out of `src/tools/`.                                              |
| `resources/tool_use_agents/latexFixer.yaml`                                        | Existing agent — wired into the post-compile failure path. No definition changes required for the default flow; if pre-accept shadow-mode is later pursued, the YAML's tool list and prompt are revisited. |
| `src/agent/implementations/flows/reflection/nodes/OutputNode.ts`                   | Hand off to latexFixer on failure when setting is on.                                                                                                                                                      |
| `packages/extension/src/frontend/agents/finalOutputOpener.ts`                      | Open PDF or log via `vscode.open`.                                                                                                                                                                         |
| `src/housekeeping/`                                                                | Exclude `*.pdf` from cleanup under runDir.                                                                                                                                                                 |

## 9. Phases

Each phase is independently shippable.

1. **Settings migration** to storage + LaTeX tab. No feature changes. Lands first.
2. **Diff → shadow storage.** Fixes the workspace-pollution bug.
3. **Auto-open PDF / log** + PDF persistence (housekeeping rule + output symlinks).
4. **Fragment wrap** (deterministic, no agent).
5. **`open_pdf` tool** (vscode-free body, injectable opener callback registered at activation). No `compile_tex` — latexFixer already runs latexmk via `bash`.
6. **latexFixer wiring** on failure (post-accept). Existing YAML reused; orchestrator hand-off and per-call iteration cap added.
7. **Compile result → round loop** (reject + log injection).
8. **Latexdiff bib quality** (`--exclude-textcmd`, `BIBINPUTS`).
9. **Latexdiff changes-only** (after verifying flag in shipped binary).

## 10. Open questions

1. **Round-loop semantics on rejection — DECIDED: replace.** A rejected round consumes a slot from the user's requested round count. Total rounds and total cost are unchanged whether or not compile fails. Spelled out in §6.5.
2. **Diff location confirmation:** `<runDir>/diff/...` (real on-disk path under extension storage) — confirm this satisfies "real filesystem" and the diff is reachable from the eventual fixer pass. If the intent was actually "in the user's workspace," reopen. (Note: latexFixer in default mode operates on workspace files post-accept, so diff in shadow doesn't block it; this question matters for any future pre-accept shadow-mode fixer.)
3. **Workspace PDF copy:** off entirely, or off-by-default with a setting (`WORKFLOW_COPY_PDF_TO_WORKSPACE`, gitignore-friendly subdir)?
4. **Latexdiff `--only-changes` exact flag and version floor:** verify at implementation time.
5. **latexFixer invocation timing — DECIDED: post-accept.** Phase 6 wires latexFixer into the post-accept full-file failure path only. Pre-accept shadow-mode is explicitly deferred (§11) and requires new run-storage-aware file tools (or extending `read_file`/`edit_file` semantics) before it can be reopened. Phase 6 is therefore independently shippable as written.
6. **`open_pdf` exposure:** keep PDF opening orchestrator-driven (auto-open on success / failure log on failure), or expose `open_pdf` as a tool latexFixer can call? _Recommendation: orchestrator-driven only in this phase; expose to latexFixer later if there's a clear use case._

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
