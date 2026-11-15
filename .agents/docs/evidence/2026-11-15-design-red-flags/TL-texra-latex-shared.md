Read at `cb22acd`; covers `packages/texra/src/{shared,latex,agent,replacement,utils,model,common,types}`.

### TL-1: "is this `_diff.tex` a generated latexdiff artifact" is decided by two callers

- **Package:** texra
- **Flags:** repetition (a rule with two owners), information leakage, special and general code mixed
- **Evidence:** `detectGeneratedLatexdiffArtifact` (`packages/texra/src/latex/latexdiff/diffFileNameManager.ts:93`) answers from the name alone and returns a `kind` so that each caller can finish the decision. Both callers then probe the inferred source and apply the same exception, with the same comment:
  - `packages/texra/src/latex/latexdiff/diffFileNameManager.ts:165-171`: `if (artifact.kind === 'workspaceDiff' && !sourceExists) { return base; }` ("A user may legitimately keep a source file named chapter_diff.tex").
  - `packages/texra/src/agent/output/compileFixer.ts:273-287`: `if (artifact.kind === 'workspaceDiff' && !sourceExists) { return [{ path: relativePath }]; }` ("A user may legitimately name a source file `chapter_diff.tex`").

  `kind` has three values (`:9-12`) and nothing branches on `versionControlDiff` or `betweenRoundDiff`; the only read of `kind` in `packages/*/src` is those two `=== 'workspaceDiff'` tests. Production consumers of `detectGeneratedLatexdiffArtifact`: 2 (`compileFixer.ts:267`, and `buildLatexdiffAwareFixInstruction` in its own file); tests: 3 files name it. `parseVersionControlDiffFilename` (`:126`, 1 consumer, `packages/extension/src/progressView/extensionHostRequests.ts:244`) runs the same `VERSION_CONTROL_DIFF_PATTERN` a second time for any extension.
- **Better design:** one Effect in `diffFileNameManager.ts`, `generatedLatexdiffArtifact(fs, absolutePath)`, that returns `{ sourcePath, sourceExists } | null` and already answers null for a bare `_diff` stem whose source is absent. `compileFixer` and the fix instruction read the result; neither knows that one suffix is weaker than the others.
- **Deleted:** `GeneratedLatexdiffArtifactKind`, the `kind` field and the `kind` column of `GENERATED_LATEXDIFF_ARTIFACT_PATTERNS`, the second copy of the exception and its comment, one `exists` probe in `compileFixer.ts`.
- **Size:** about 50 lines, 2 files (plus the existing suite's `kind` assertions).
- **Risk / owner decision:** none.

### TL-2: the accept-edited flow keeps its two-host scaffolding with one caller left

- **Package:** texra
- **Flags:** single-caller extraction, pass-through, a comment that is false, repetition
- **Evidence:** `packages/texra/src/latex/acceptedFileTarget.ts`. `acceptEditedFileReplace` (`:232`) has 1 production consumer (`packages/texra/src/controllers/progressView/ProgressDocumentTaskFileActionsController.ts:148`) since V-R1 landed, and 1 test file. Around it:
  - `commitAcceptedFile` (`:147`) is called once (`:275`); its doc comment explains why `targetExisted` "is the caller's to compute" (`:140`), a hand-off that exists only because the function was cut in two.
  - Two port interfaces for the one caller: `CommitAcceptedFilePorts<E>` (`:116`, `showInfo`) and `AcceptEditedFileReplacePorts<E>` (`:126`, adds `confirm`), both generic in `E`.
  - `getAcceptAction` (`:71`), `buildAcceptConfirmMessage` (`:82`) and `buildAcceptSuccessMessage` (`:99`) each have one call site.
  - False comments: "Shared by the VS Code command and the desktop bridge so both hosts surface identical wording" (`:79`) and "can run on both the VS Code command (warning dialog) and the desktop bridge (dialog IPC)" (`:122`). Neither host calls this file; the controller does.
  - "Remove the stale `_diff` companion, warn and carry on" is written twice: over the process `FileSystem` at `:202-212` and over `WorkspaceFs` at `:333-343`.
- **Better design:** `acceptEditedFileReplace(base, edited, { confirm, showInfo })` as one function body: resolve target, confirm, re-check, write, remove the companion, report. One ports type without the generic split. The companion removal is one local helper over an absolute path used by both the accept and `cleanupAcceptedWorkspaceDiffFiles`.
- **Deleted:** `commitAcceptedFile`, `CommitAcceptedFilePorts`, `getAcceptAction`, `buildAcceptSuccessMessage`, the `targetExisted` parameter, two false comments, one of the two removal blocks.
- **Size:** about 80 lines, 1 file.
- **Risk / owner decision:** none. (`staleDiffFileLocation`'s repeated argument was I12 and has landed; this is what is left around it.)

### TL-3: the tool resolver restates three facts the tool catalog owns

- **Package:** texra
- **Flags:** repetition (a fact with two owners), special and general code mixed, a comment that is false
- **Evidence:** `LATEX_TOOLS` (`packages/texra/src/shared/constants/latexToolchain.ts:205`) says of itself "The runner … and four surfaces read it and none restates a name". The runner's two files restate three of its facts:
  - Ghostscript's Windows names. Catalog: `alternates: ['gswin64c', 'gswin32c']` (`latexToolchain.ts:326`), walked by `probeTool` (`packages/texra/src/utils/system/toolChecks.ts:112-116`). Resolver: `if (tool === 'gs') { candidates.push('gswin64c', 'gswin32c', 'gswin64c.exe', 'gswin32c.exe'); }` (`packages/texra/src/utils/system/binaryResolver.ts:59-62`). On Windows a `gs` probe tries the alternates through both lists.
  - The platform's package manager. `PLATFORM_PACKAGE_MANAGER = { darwin: 'brew', linux: 'apt', win32: 'scoop' }` (`latexToolchain.ts:613`) and `PREFERRED_PACKAGE_MANAGER = Object.freeze({ darwin: 'brew', linux: 'apt', win32: 'scoop' })` (`toolChecks.ts:159`). The second one's comment says it must agree with "the PM that the install advice uses for that platform", which is the first table. Each has one reader.
  - Which catalog tools are TeX Live Perl scripts. `WINDOWS_EXTENSIONLESS_PERL_TOOLS` and `TEXMF_SCRIPTS` (`binaryResolver.ts:18-33`) list `latexdiff`, `latexdiff-vc`, `latexindent`, `latexmk`, `texcount` by name; the catalog entry of each has no such field, so a new Perl-script tool is added in two files.
  - `needsPerlLauncher(toolName, resolvedPath, isWindows)` (`binaryResolver.ts:127`) takes a parameter its one caller always fills with the module constant `IS_WINDOWS` (`:154`); no test names the function.
- **Better design:** the catalog entry carries `texmfScript?: true` beside `alternates`; `findCommand` takes the entry's candidates (name plus `alternates`) and that flag from `LATEX_TOOL_ENTRIES` when the name is a catalog name, and treats any other name (`sox`, `lake`) as a plain PATH lookup. `detectPackageManager` reads the exported platform table.
- **Deleted:** the `gs` branch of `toolCandidates`, `WINDOWS_EXTENSIONLESS_PERL_TOOLS`, `TEXMF_SCRIPTS`, `PREFERRED_PACKAGE_MANAGER`, the `isWindows` parameter.
- **Size:** about 45 lines, 3 files.
- **Risk / owner decision:** none; `2026-11-04-core-dependency-check-overlap.md` covers the probe surfaces, not the resolver.
