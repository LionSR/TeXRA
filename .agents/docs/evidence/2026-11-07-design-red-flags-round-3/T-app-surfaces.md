# T. The trace viewer, the VS Code commands and the bundled prompts: design red flags

Area: `packages/trace-viewer/`; `packages/extension/src/commands/`,
`packages/extension/src/commands.ts`, the command catalog and registry they
read (`packages/texra/src/shared/commands/`) and
`scripts/sync-package-contributes.mjs`; the bundled agents
(`packages/extension/resources/agents/`, `resources/plugins/*/agents/`), the
agent templates (`resources/templates/`), the creator's reference docs
(`resources/docs/agent-creation/`), the bundled skills (`resources/skills/`,
`resources/plugins/*/skills/`) and `.github/prompts/`. Read-only.

**Commit read: `4e32bb921018ccb4626c0fb47b25a2c2d365b5f4`** (HEAD when the
audit started, R6 landed as #14789). HEAD at writing is `ad0f38c`, which adds
only the round-3 `BRIEF.md`. Open PRs at writing: 14773 (docs only) and 14741
(the store); neither touches a file below. PR 14713 merged on 2026-11-07, so
nothing here waits on it. Paths are repo-relative; consumer counts are over
`packages/*/src` unless stated.

Found before this round and not repeated: N11's trace-viewer items (the
viewer re-declares the reader's frame order, now `traceFrames.ts:103-129`;
the `cloneNode` remount, `main.ts:93-101`; the bridge's module `let`s,
`traceHostBridge.ts:179-181`); J10's catalog columns (`extensionRegistry`,
`host`, `commandKeybindingOrder`, `setupInvokable`); I3's compile-outcome
sentinel; I7's extraction ladder; M5's `/executions` route table. Where a
finding below borders one of them it says so and adds only the new angle.

## Numbers

Lines (excluding tests and `dist/`):

| Subtree                                                      | Lines                              |
| ------------------------------------------------------------ | ---------------------------------- |
| `packages/trace-viewer/` (`src/*.ts`, `vite.config.ts`)      | 468                                |
| `packages/extension/src/commands/`                           | 2,015                              |
| `  latex/` · `git/` · `files/` · `api/` · `system/`          | 728 · 331 · 179 · 170 · 143        |
| `  housekeeping/` · `setup/` · `agent/` · the two root files | 139 · 87 · 47 · 191                |
| `packages/extension/src/commands.ts`                         | 171                                |
| `packages/texra/src/shared/commands/` (catalog, registry)    | 518                                |
| `scripts/sync-package-contributes.mjs`                       | 125                                |
| bundled agents: 35 core + 5 Lean (`*.yaml`)                  | 4,364 (3,749 + 615)                |
| agent templates (`resources/templates/`)                     | 118 (two agent YAMLs, `chatExport.tex`) |
| agent-creation docs (4 `.md`)                                | 484                                |
| bundled skills: 15 `SKILL.md` + references; 15 `openai.yaml` | 1,209 Markdown                     |
| `.github/prompts/` (6)                                       | 518                                |

The 40 agent files are 15 document tasks (a `task:` block), 24 tool-using
personas and one text-only persona (`critic.yaml`).

Five largest files. Code: `shared/commands/catalog.ts` 413,
`commands/git/gitCommands.ts` 331, `commands/latex/latexCommands.ts` 185,
`commands.ts` 171, `commands/api/apiKeyCommands.ts` 170. Prompts:
`enhance.yaml` 402, `criticize.yaml` 336, `setup.yaml` 327, `logic.yaml` 298,
`notation.yaml` 259.

Comment-line share (`^\s*(/\*|\*|//)` over total). Only two code files in the
area reach 200 lines: `catalog.ts` 11% (46/413), `gitCommands.ts` 6%
(21/331). The worst below 200: `commands/extensionCommandIds.ts` 50% (11/22, a
header explaining why a second spelling of seven ids exists, finding 8),
`shared/commands/registry.ts` 39% (41/105), `trace-viewer/src/traceFrames.ts`
29%, `commands/extensionCommandHandlers.ts` 24% (41/169, why the map is
`vscode`-free and what `openDoc` is not), `trace-viewer/src/traceHostBridge.ts`
24%.

Primitives in the area's code: `new Promise` 0; `.then(` 2 (the trace
viewer, N11's); `async function` 1 (`loadTrace`); module-level `let` 3 (the
trace viewer); `Effect.forkDetach(` 19, every one around a notice
(`commands/`); `Effect.tryPromise` 2; `runtime.run*` 3 (the one execution
boundary, `commands.ts:136,144,154`); `*Unsafe(` 1 (`Queue.offerUnsafe` inside
a `Stream.callback`, the primitive used right); `Effect.uninterruptible`,
`Effect.never`, `addObserver` 0; a hand-written once-flag 1
(`apiKeyCommands.ts:84`); `Effect.sleep` 1 (`latexCommands.ts:100`).

Prompt counts: 56 distinct lines of 40+ characters appear verbatim in two or
more agent files (one in 7 files, one in 6, five in 4, eleven in 3); the
`<documents>` reply skeleton is written 27 times in the 15 tasks and twice in
the task template; the `\criticize` macro is defined 9 times in three
different versions; one "Voice" paragraph is copied identically into 7
personas.

The key questions, answered:

- **The trace viewer** keeps no copy of transcript rendering: it mounts the
  progress webview unchanged (`main.ts:16,91`) and labels with the shared copy
  (`formatLoopPositionLabel`, `runIdentityDisplayName`). Its one copy of
  reading is the frame order (N11, found). What it does duplicate sits on the
  producer side: the standalone page is built twice (finding 9).
- **A command** is declared in the catalog, given a handler twice over (a
  map entry and an actions member) and an execution in `commands.ts`; its
  manifest row is generated, but its palette row is hand-written and
  unchecked. A new no-argument command is six hand edits in five files
  (findings 7 and 8).
- **The bundled agents** repeat two kinds of block. Protocol facts the code
  owns (the reply grammar, the `\criticize` annotation, the executions
  routes, approval, a task's result layout) should leave the prompts
  (findings 3, 4 and 5). House style (voice, file-output rule, LaTeX rules)
  stays copied by design ("Already settled"). Tool lists are explicit per
  agent and stay that way (also "Already settled").

---

## Finding 1. The "new document task" template writes an agent that asks for documents named `{`, `I`, `N`, …

**Red flags:** a latent defect; information leakage (a two-pass render
protocol every template author must know); special and general code mixed
(one template language for two render times).

**Evidence.**

- The settings view's Agents tab creates an agent by rendering a bundled
  template through Nunjucks once, at creation
  (`packages/texra/src/controllers/settingsView/settingsAgentCommands.ts:86-101`,
  shared by the VS Code and desktop settings views), with the harness's
  passthrough map underneath: every runtime token maps to the literal text
  `{{ TOKEN }}` (`buildTemplatePassthrough`,
  `packages/harness/src/agent/prompt/templateInputs.ts:83-100`;
  `agentTemplateRenderer.ts:16-20,40-48`).
- That keeps a `{{ TOKEN }}` *expression* literal, but not a *tag* that reads
  the token. The task template wraps its `{% if INSTRUCTION %}` in
  `{% raw %}` (`resources/templates/agentTemplate-workflowSingle.yaml:33,38`)
  and does not wrap its two loops:
  `<documents>{% for output in INPUT_FILES %}<document name="{{ output }}">…` (`:42,44`).
  At creation `INPUT_FILES` is the 17-character string `{{ INPUT_FILES }}`,
  and Nunjucks iterates it character by character. Rendering the bundled
  template exactly as the creation path does (the same Nunjucks, no loaders,
  autoescape off, the same passthrough) writes:
  `Output the revised \LaTeX as <documents><document name="{">...</document><document name="{">...</document><document name=" ">...</document><document name="I">...</document>…<document name="}">...</document></documents>.`
  Both requests carry it, so every document task created from the Agents tab
  asks the model for seventeen one-letter documents, and the extraction
  ladder (I7) has to recover from a reply that cannot match.
- The one regression test for this path (`packages/texra/test/agent/AgentTemplateRenderer.vitest.ts:12-29`,
  #7678) checks only that `{{ ALL_CONTEXTS }}` survives.
- The creator agent's prompt shows the same protocol from the other side: it
  must `{% raw %}` a mention of `{{ X_FILE }}` because a persona prompt is
  rendered at launch (`resources/agents/creator.yaml:93`).

**The design decision behind it.** "What does creation fill in?" is answered
by a second render pass in the same template language as the runtime render,
so the template has to say, tag by tag, which render each piece belongs to.
Creation fills three values the code computes itself: the validated name,
a description derived from it (`settingsAgentCommands.ts:75-77`) and a fixed
tool list (`DEFAULT_AGENT_TEMPLATE_TOOLS_YAML`, `agentTemplateRenderer.ts:22-31`).
None needs a template engine.

**The better design.** A template is a valid agent file. Creation parses it
as YAML, sets `name`, `description` (and `tools` for the persona kind) as
data, and writes it with the `yaml` package the harness already uses
(`packages/harness/src/agent/memory/memoryMeta.ts:87`); the runtime render is
then the only render, so no tag needs escaping. Deleted:
`renderAgentTemplateString` (1 production consumer, 1 test), its Nunjucks
environment and `PASSTHROUGH` (`agentTemplateRenderer.ts:12-20`),
`DEFAULT_AGENT_TEMPLATE_TOOLS_YAML` as a YAML string (becomes an array, 1
consumer), the `{% raw %}` wrappers and the `{{ AGENT_NAME }}`,
`{{ DESCRIPTION | replace("'", "''") }}`, `{{ TOOLS_YAML }}` placeholders in
both templates, and the #7678 test, whose failure mode no longer exists.
`buildTemplatePassthrough` keeps one consumer, which uses it only as a set of
names (`packages/texra/src/tools/documents/documentTask.ts:97`), so it
becomes an exported list of the fixed token names.

**What we give up.** A template can no longer interpolate creation values
into its prompt body (the persona template's first prompt line is
`{{ DESCRIPTION }}`, `agentTemplate-toolUse.yaml:8`); creation writes it as
a field instead. The written file's YAML formatting follows the serializer.
The bug fix itself changes behaviour, so it carries the one regression test
the testing budget allows: a template-created task asks for its input
names.

**Change amplification.** "A template gains a runtime `{% if %}` or loop":
today the author must know to escape it, and nothing checks (1 file and a
silent defect); after, nothing to know.

**Depends on:** none; a small fix that changes behaviour, so it goes first
(the order note's rule 1).

## Finding 2. Customizing a bundled document task copies its YAML but not the files its `task.files` binds

**Red flags:** a latent defect; information leakage (what an agent consists
of is known by the documents plugin, and the copy does not know it);
silent degradation.

**Evidence.**

- Two bundled tasks bind sibling files: `write/paper2poster.yaml:15-18`
  (`template_poster.tex`, `beamercolorthemempi.sty`, `beamerthemeconfposter.sty`)
  and `write/paper2slide.yaml:24-25` (`template_slide.tex`). The documents
  plugin resolves each binding against the agent file's own directory
  (`packages/texra/src/tools/documents/documentTask.ts:109-111`).
- "Customize" writes a copy of the one YAML file into the custom directory,
  stamped with the bundled file's digest
  (`packages/harness/src/agent/index/AgentDirectoryService.ts:324-336`
  `writeStampedCopy`, `:340-359` `copyTarget`). Its callers are the settings
  view (`settingsAgentCommands.ts:275,286,355`, both GUI hosts) and the CLI
  (`packages/cli/src/commands/agents.ts:128,185`). A customized
  `paper2poster` therefore resolves its templates under the custom directory,
  where they are not; the read fails, is logged at warn, and "the variable is
  simply absent from the prompt after this" (`documentTask.ts:112-121`): the
  poster task runs without its template, its card showing the entries as not
  ok.
- The digest that tells a copy "the bundled version changed" covers the YAML
  alone (`agentYamlScanner.ts:235`), so an update to `template_poster.tex`
  never reaches a customized copy as a notice either.

**The design decision behind it.** "What is an agent?" is answered twice: the
catalog and the copy say one YAML file; the documents plugin says a YAML file
and the files its block binds. The harness reads nothing inside a block
(`packages/harness/AGENTS.md` "Run loop architecture"), so the copy cannot
learn the second answer on its own.

**The better design.** The block contract names the block's sibling files:
`AgentBlock.files?: (block: A) => readonly string[]`, relative to the agent
file (`packages/harness/src/tools/toolTable.ts:130-138`; the documents block
answers `Object.values(task.files)`). `customizeCopy` copies each one that
resolves inside the original's directory beside the copy (`FileSystem.copyFile`)
and refuses one that escapes it; the scanner's digest hashes the YAML with
those files, so a changed template raises the same "newer built-in" notice a
changed prompt does. The callers write against `AgentCatalog.customize` as
today. Two designs compared: embedding the bundled templates in the YAML
(no contract change) loses the separate `.tex`/`.sty` files a user edits and
leaves the same hole for every user task that binds files; the block naming
its files fixes both.

**What we give up.** The public `AgentBlock` contract grows one optional
member (an API-report diff); a copy now writes several files, and `keep`
re-stamps against a digest that also changes when only a template changed.

**Change amplification.** "Ship a third bundled task with a template file":
today it works until a user customizes it, and breaks with a warning; after,
nothing to remember.

**Depends on:** none. Finding 4's shared macro file depends on this one.

## Finding 3. The `<documents>` reply grammar is spelled by every document task instead of by the recipe that parses it

**Red flags:** information leakage (a wire format known by 15 YAML files, a
template, a doc and three code modules); two representations of one
decision (which names a reply may use); a column derivable from a fact the
code holds (`INPUT_FILES` or `OUTPUT_FILES`).

**Evidence.**

- The code calls it a fixed protocol:
  `// The output protocol: every agent wraps its documents in <documents><document name="...">...</document></documents> … Fixed constants, not per-agent configuration.`
  (`packages/texra/src/shared/plugins/documentOutputs.ts:40-48`,
  `OUTPUT_DOCUMENTS_TAG` and `OUTPUT_DOCUMENT_TAG`, 19 references). The
  parser reads it (`packages/texra/src/utils/text/xmlExtraction.ts:56-110`,
  `agent/output/outputFileExtraction.ts:88,120`), and a replacement rule
  repairs it (`replacement/rules.ts:493-495`).
- Each task writes the skeleton itself, once per request: 27 blocks in the
  15 bundled tasks (two in each two-request task, for example
  `polish.yaml`, `correct.yaml`, `criticize.yaml:217,332`,
  `firstread.yaml:144,171`), two in the task template
  (`agentTemplate-workflowSingle.yaml:42,44`) and six in
  `docs/agent-creation/document_task_schema.md:95-150`. Five tasks add an
  order line on top ("Output the documents in this order: …",
  `polish.yaml:78`, `devise.yaml:175`, `enhance.yaml:394`, `generic.yaml:77`,
  `notation.yaml:251`).
- The loop variable is chosen by hand: the 11 tasks with no `outputs:` loop
  over `INPUT_FILES`; the 4 that declare `outputs:` (`ocr`, `paper2slide`,
  `paper2poster`, `transcribe_audio`) name `OUTPUT_FILES[0]`
  (`ocr.yaml` requests, `paper2slide.yaml:49,57`). The recipe already holds
  this fact: the names a reply may use are the run's output names or its
  inputs (I7 is the decision itself), and `task.outputs` are "the files a
  task writes when the launch names none" (`shared/plugins/documents.ts:169-175`).
- The recipe builds each revision's prompt as `prefix`, earlier replies,
  then the request, and appends only the compile-failure context
  (`packages/texra/src/tools/documents/documentState.ts:216-265`); it adds
  nothing about the reply's shape.

**The design decision behind it.** "How does a reply carry its documents,
and under which names?" is a contract between the recipe and its parser,
written in the one place the parser does not control.

**The better design.** `revisionPrompt` ends every request with the reply
instruction it will parse, built from the two tag constants and the names
the recipe accepts for that revision (the same list I7's extraction checks):
one `<document name="…">` per accepted name, in order. A task's YAML says only
what to do. Deleted: the 27 skeletons and five order lines in the bundled
tasks, the template's two, and the "Output protocol" section of
`document_task_schema.md`; the "which loop variable" choice disappears with
them. Callers (`documentRecipe.ts`) are unchanged.

**What we give up.** A task's own placeholder wording inside the skeleton
(`% UPDATED LATEX DOCUMENT 1 HERE`, `{LATEX_OCR_CONTENT}`,
`[HH:MM:SS:MS] SpeakerName: …` in `transcribe_audio.yaml`) moves to the
request's prose or goes; a user's own task that keeps its skeleton gets the
instruction twice, which is harmless. The resolved prompt of every bundled
task changes, so the change is reviewed as the final resolved prompt with
behaviour checks (AGENTS.md "Prompts").

**Change amplification.** "Add an attribute to `<document>` or rename the
container": today `documentOutputs.ts`, `xmlExtraction.ts`, `rules.ts`, 15
task files, the template and the doc (20 files); after, the three code
files.

**Depends on:** I7 (package C, step 4.3), which settles the list of names the
recipe would print; land with it or after.

## Finding 4. The `\criticize` annotation is defined nine times in three versions, with two label sets for one scale

**Red flags:** information leakage (an annotation protocol known by eight
prompt files and three code modules); two representations that already
disagree; a "canonical" claim the copies contradict.

**Evidence.**

- The macro definition appears 9 times in 8 files, in three versions:
  - A (severity 0 renders green, math text in `\text`): `criticize.yaml:102,297`,
    `enhance.yaml:81`, `firstread.yaml:119`, `orchestrator.yaml:79`;
  - B (no severity-0 branch, math text in `\textit`): `logic.yaml:219`,
    `notation.yaml:176`;
  - C (a different macro, `\textcolor{red}{\textbf{[#2|#3]} #1}`):
    `skills/inline-paper-critic/SKILL.md:22`,
    `skills/inline-paper-critic/references/critique-checklist.md:39`.
  `firstread.yaml:118` and the orchestrator call version A "the canonical
  TeXRA \criticize macro"; each task adds it "if it is not already there", so
  which version a paper ends up with depends on which task ran first.
- The scale's labels disagree. `logic.yaml:29-31` and `notation.yaml:25-27`:
  "severity and confidence are 1-5", 5 Critical, 4 Major, 3 Moderate.
  `criticize.yaml:229-250`: 5 Fatal, 4 Critical, 3 Major, and it writes
  severity 0 (`:319`) after saying "severity is 1-5" (`:29`).
  `apply.yaml:10`, which consumes the annotations the others write:
  0 verified, 3 major, 4 critical, 5 fatal. So a logic pass's "4 (Major)" is
  read by apply as "critical".
- The code holds the grammar and the range: the parser accepts severity 0-5
  and confidence 1-5
  (`packages/extension/src/frontend/latex/criticismParser.ts:65-75`); the
  stripper names the macro (`packages/texra/src/replacement/advanced.ts:390-393`,
  used by `accept_run_files`'s `strip_criticize`,
  `tools/AcceptRunFilesTool.ts:153-156`).

**The design decision behind it.** "What is a `\criticize` annotation, how
does it render, and what does each level mean?" is decided per prompt.

**The better design.** One definition and one scale, in one file the tasks
bind through the mechanism they already have: `resources/agents/criticize.tex`
(the macro, plus the severity and confidence labels as a comment block),
bound by each producing task as `task.files: { CRITICIZE: criticize.tex }`
and read as `{{ CRITICIZE_CONTENT }}` in its `task.prefix`. The two copies now
in `prompt:` (`criticize.yaml:102`, `enhance.yaml:81`) move to the prefix,
since task-file variables render only there. The orchestrator's copy and its
"add the definition beforehand" step (`orchestrator.yaml:77-79`) go: every
producing task adds the macro itself. The parser keeps its range check as the
boundary (0-5, 1-5), now stated beside the file it must agree with. The skill
keeps a copy of its own by the standalone rule
(`docs/dev/skill-authoring.md:3,12`), version A. Deleted: 8 of 9
definitions, 4 scale statements.

**What we give up.** The rendering differences between versions (B's
`\textit`), and a customized copy of a producing task needs finding 2 to
carry `criticize.tex` with it. Choosing one label set changes what some
tasks are told; that is a prompt change reviewed as such.

**Change amplification.** "Add a severity level or relabel one": today 9
definitions and 4 scale statements in 8 files, and the parser; after, the
file and the parser.

**Depends on:** finding 2 (a customized task must carry its bound file).

## Finding 5. Persona prompts restate tool, approval and task-result mechanics that their owners already state

**Red flags:** information leakage (route grammars, a database schema, a
result layout and an approval rule written into personas); two
representations that drift independently of the code.

**Evidence.**

- **The executions tool.** `orchestrator.yaml:87-91` and
  `plugins/lean4/agents/leanOrchestrator.yaml:44-48` carry the same three
  paragraphs: `/executions/{id}/report` after compaction, `/executions/current`,
  the query `SELECT id, name, lifecycle, outcome FROM runs WHERE parent_id = ?`,
  `bash` with `run_in_background=true` and `/executions/{id}/output`.
  The tool says each of these itself: its route table
  (`packages/harness/src/tools/ExecutionsTool.ts:249-264`), its description
  ("Use "current" as {id}", "Children: SELECT * FROM runs WHERE parent_id = ?",
  `:722-734`), and `bash`'s (`packages/harness/src/tools/bash.ts:58,389,451`).
  `engineer.yaml:94` and `latexDiff.yaml:20` restate parts of it too.
- **A document task's result.** `orchestrator.yaml:62-68` describes the
  `diff="diffs/filename.diff"` and `large-change="true"` attributes and says
  "look for entries matching `compile/*.log`. If none appear, the build
  succeeded". Those are the documents plugin's facts
  (`tools/documents/documentResult.ts:62,86,258`) and I3's sentinel, read here
  by a fourth reader; `agent/output/compileCheck.ts:157` keeps a comment so
  that "the orchestrator can use 'no compile/*.log entries'". The plugin
  already pins a prompt section whenever `document_task` is offered
  (`packages/texra/src/tools/registry.ts:296-305`).
- **Approval.** "Do not ask for permission in chat … the harness requests it"
  in four wordings (`assistant.yaml:77`, `prover.yaml:43`, `research.yaml:30`,
  `plugins/lean4/agents/lean.yaml:31`); the other 20 tool personas say
  nothing. Approval is the harness's, and its tool-use suffix, appended to
  every tool-using persona, already carries the cross-agent rules
  (`packages/harness/src/agent/prompt/PromptBuilder.ts:22-32`).

**The design decision behind it.** "Who tells the model how a tool behaves?"
The tool's description, the plugin's prompt section and the harness's
suffix are the owners; the personas were written before, or beside, them.

**The better design.** Each fact said once, by its owner, and only while it
applies: the executions and background-shell paragraphs go (the
descriptions say it whenever the tool is offered); the task-result paragraph
moves into the documents plugin's section, which is shown exactly when
`document_task` is; one approval sentence joins `TOOL_USE_INSTRUCTIONS` and
the four persona copies go. Personas keep what is theirs (when to delegate,
what to check). Deleted: about 12 paragraphs over 7 files.

**What we give up.** Emphasis: a persona that repeated a mechanic did so to
make it salient, and the section or description may sit further from the
persona's own instructions. The approval sentence reaches the 20 personas
that lacked it, a behaviour change reviewed as such.

**Change amplification.** "Rename `/executions/{id}/report`": today the
route table plus `orchestrator.yaml`, `leanOrchestrator.yaml`,
`progressCheck.yaml` (`:21`) and the creator's doc; after, the route table.

**Depends on:** none; I3 changes what the result-layout paragraph says, so
it moves after I3 if I3 lands first.

## Finding 6. The creator's reference docs are a hand-kept second copy of the tool registry and the template vocabulary, and they have drifted

**Red flags:** two representations of one fact; a comment (here, a document)
substituting for a read of the real structure.

**Evidence.**

- The creator is told the docs are "the source of truth" and that
  `tool_catalog.md` holds "every tool in the registry"
  (`resources/agents/creator.yaml:36-46`). The doc's per-tool section restates
  each tool's description and parameters by hand
  (`resources/docs/agent-creation/tool_catalog.md:5-150`).
- It has drifted from the code it copies. The doc's `script` entry
  (`tool_catalog.md:66-81`) says scripts have "no imports" and lists
  `tools`, `agent`, `document_task`, `phase`, `console.log`. The tool's own
  description (`packages/harness/src/tools/codemode/ScriptTool.ts:335-349`)
  documents `await import('builtIn:<module>')`, `searchTools`, `describeTool`
  and `self(prompt, …)`; the documents plugin's section tells the model to
  `import('builtIn:documents')` (`registry.ts:300-302`). `self` does not
  appear in the doc at all.
- `document_task_schema.md:62-75` lists nine template variables by hand;
  the vocabulary's declared owner is `TemplateInputsSchema`
  ("the single source of truth for the vocabulary",
  `packages/harness/src/agent/prompt/templateInputs.ts:21-67`), which has 22.
- Nothing checks either doc (`grep` for `tool_catalog` outside `resources/`
  finds only the packaging list, `scripts/extension-package-utils.mjs:24`).

**The design decision behind it.** "What may an agent name in `tools:` and
in a template?" is answered by the registry and the schema at run time, and
by prose for the one agent that writes agents.

**The better design.** The doc keeps only what no code states: the
recommended groups and the conventions (`tool_catalog.md:150-175`). The tool
list becomes one generated table (name, plugin, first sentence of its
description) and the variable list one generated table from
`TemplateInputsSchema.fields`, both written by the sync script that already
bundles the command catalog for the manifest
(`scripts/sync-package-contributes.mjs:29-47`) and checked by its `--check`
in `gate:invariants`. The parameter and mechanics prose (`agent`,
`document_task`, `script` entries) goes: the agent being created reads those
from the live descriptions when it runs. Deleted: about 120 hand-written
lines.

**What we give up.** Hand-written nuance per tool; the sync script must
bundle the tool registry (it pulls Node modules, unlike the catalog), which
is the risk to check first. The fallback is a names-only check (every
registered tool appears in the doc and nothing else does), which catches a
missing tool but not drifted semantics.

**Change amplification.** "Add a tool": today `defineTool`, its plugin's
list and `tool_catalog.md` (unchecked); after, the first two and a
regenerate the gate demands.

**Depends on:** none.

## Finding 7. Palette visibility is a hand-written, unchecked 28-row table beside the generated manifest

**Red flags:** change amplification; a third silent wiring point for a
command (AGENTS.md names two); a fact (needs a folder) known in three
places.

**Evidence.**

- The sync script generates `contributes.commands`, `keybindings` and
  `chatSkills` and carries every other key over by spread
  (`scripts/sync-package-contributes.mjs:101-106`).
  `menus.commandPalette` (`packages/extension/package.json:287-400`) is
  written by hand: one row per non-desktop catalog row, in catalog order, 16
  with `when: "texra.activated"` and 12 with `when: "false"`. Nothing compares
  it with the catalog (the catalog test checks keybindings only,
  `packages/texra/test/commands/CommandCatalog.vitest.ts:22-34`).
- A catalog row added without a palette row is shown in the palette
  unconditionally, including before activation and in the no-folder window
  that never registers it: the "command not found" the activation gate exists
  to prevent (`packages/extension/src/extension.ts:581-586`).
- The `when` string is constant across the visible rows, so the only real
  fact per row is "hidden" (12 of 28).
- Which commands work without a folder is known three times: the no-folder
  window registers four of them by hand (`extension.ts:331-366`), the
  walkthrough bridge types five that need one
  (`WalkthroughCommandNeedingWorkspace`, `:246-258`), and the walkthrough
  Markdown routes those five through `texra.walkthroughWorkspaceAction?[...]`
  by hand (`package.json:221,236,248`). The no-folder window never sets
  `texra.activated`, so the four commands it does register are hidden from
  its palette too.

**The design decision behind it.** "Where does a command appear, and in which
window does it work?" is decided outside the catalog that owns its identity.

**The better design.** The catalog gains `palette: false` on the 12 hidden
rows; the sync script writes `menus.commandPalette` from it (every other
non-desktop row with `when: texra.activated`), and its `--check` fails on
drift. The four no-folder handlers become one record in `extension.ts`
keyed by `CommandId`; the bridge's type is the catalog ids not in it. The
bridge itself stays: it exists so that a no-folder click does not fire the
real command's walkthrough completion event (`extension.ts:246-250`).
Deleted: 28 hand rows (regenerated), the hand-kept type union.

**What we give up.** Nothing users see; one more catalog field (J10 removes
two).

**Change amplification.** "Add a command": today a catalog row, the handler
wiring (finding 8) and a palette row nothing checks; after, the row and the
handler.

**Depends on:** J10 (same file, same columns); land together.

## Finding 8. The extension's command layer: three names per command, a second spelling of seven ids, and two commands nothing needs

**Red flags:** pass-through (a handler map that forwards to an actions record
that forwards to the module); two representations of a command id; a
command used as an internal function call; an option nothing passes, with a
false comment.

**Evidence.**

- **Forwarding.** `EXTENSION_COMMAND_HANDLERS`
  (`packages/extension/src/commands/extensionCommandHandlers.ts:116-169`)
  maps 26 ids; 14 entries are `(actions) => actions.x()` (`:124-146`).
  `ExtensionCommandActions` (`:79-99`) declares the 19 members, and
  `commands.ts:77-125` implements them, mostly as
  `() => module(roots, …)`. Its stated purpose is a `vscode`-free map
  (`:28-35`), whose one user is the #3782 regression test
  (`src/test-kernel/commands/ExtensionCommandRegistry.vitest.ts:42-62`, a
  19-member literal of no-ops), and that test asserts what
  `dispatchCommandFromRegistry` does: it returns the handler's program
  untouched (`packages/texra/src/shared/commands/registry.ts:263-296`).
- **A second spelling.** `EXTENSION_COMMANDS` (`commands/extensionCommandIds.ts:14-22`,
  seven ids, 12 references in 3 files) exists so "a renamed ID [is] a compile
  error" (`:1-10`); `CommandId` is already a literal union
  (`catalog.ts:344`), and the extension uses raw literals beside the constants
  in the same block (`extension.ts:356`, `frontend/statusBar/taskStatusBar.ts:141`).
- **`texra.openDoc`**, absent from the catalog on purpose
  (`extensionCommandHandlers.ts:54-61`), has one invoker: the extension
  itself, round-tripping through `vscode.commands.executeCommand('texra.openDoc', docId)`
  inside an `Effect.tryPromise` (`frontend/ui/errorHandlingUtils.ts:112-124`),
  to reach `openGuidePage`, which that file already imports (`:12`).
- **`texra.execute`'s wrapped argument.** `{ config, preferHelperModel }`
  (`commands/agent/executeCommand.ts:14-17,34-45`) has no caller: the README
  link and the keybinding pass nothing, and the comment saying it is "Set only
  by the 'fix LaTeX' actions (see handleFixCompilation and the progress-view
  compile fixer)" (`:41-43`) is false: both call the launcher directly with
  `{ helperModel: true }` (`latexCommands.ts:59`, `hostRunActions.ts:508`).

**The design decision behind it.** "Where is a command's behaviour bound?"
Three times: the map, the actions record and its implementation, so that one
test can run without VS Code.

**The better design.** `commands.ts` builds the one map from id to handler
over the module functions it already imports, typed `satisfies
Record<ExtensionCommandId, CommandHandler<void, CommandProgram<unknown>>>`,
keeping `definedHandler` for the five commands with arguments. The #3782
regression moves to the registry, where its behaviour lives (a one-entry
map). `errorHandlingUtils` calls `openGuidePage(docId)`. `texra.execute`
takes nothing (the composer's Send) or a launch config. Deleted:
`ExtensionCommandActions` (19 members, 3 files), the 14 forwarders, the test's
literal, `EXTENSION_COMMANDS` (12 references become typed literals),
`texra.openDoc` (handler, union member, action member, the round trip),
`WrappedExecuteInputSchema` and `preferHelperModel`.

**What we give up.** The handler map can no longer be imported without
`vscode`; nothing but the moved test did. A third-party extension passing
`{ config, preferHelperModel }` to `texra.execute` would break; none is
documented, and 1.0 keeps no such compatibility.

**Change amplification.** "Add a no-argument command": today the catalog row,
an actions member, a map entry, the actions implementation, the test literal
and a palette row (6 edits in 5 files, plus the generated manifest); after
this and finding 7, the row and one map entry (2 files).

**Depends on:** none (J10 removes `extensionRegistry`, which this map no
longer reads either). The desktop's `DesktopCommandActions` is the same
species (`packages/desktop/src/shared/desktopCommandSurface.ts:127-196`),
area N's.

## Finding 9. "Export a run as a standalone trace page" is written twice, once per host family

**Red flags:** repetition; information leakage (the bundle's location, the
absent-bundle case and the injection sequence known by two programs).

**Evidence.**

- The GUI path (VS Code and desktop): `writeTranscript`'s HTML branch
  (`packages/texra/src/controllers/progressView/ChatExportController.ts:75-131`)
  reads the trace, words its two missing statuses, requires an absolute
  bundle path (`:111-114`), reads it with an absent-file hint
  ("rebuild the extension (npm run package:fast)", `:115-122`, through
  `bundleFailure`, `:30-39`), then injects. Its caller computes the path
  (`controllers/session/openGuiWindow.ts:484`).
- The CLI path: `runHistoryExport` (`packages/cli/src/commands/history.ts:126-155`)
  reads the trace, words the same two statuses its own way, reads the bundle
  through `readCliHistoryStandaloneTemplate`
  (`packages/cli/src/runtime/history.ts:296-327`, `null` when absent,
  "Rebuild the CLI"), then injects.
- What they share is the two leaf helpers
  (`agent/export/standaloneTraceHtml.ts:16-18` `traceViewerTemplatePath`, 2
  consumers; `:35-48` `injectStandaloneTrace`, 2 consumers and a test).

**The design decision behind it.** "Turn a run into a self-contained page" is
one operation; it is written as two sequences over two shared steps, and the
hosts differ only in the words they print and where the page goes.

**The better design.** `standaloneTraceHtml.ts` exports one
`Effect.fn` `traceHtml(session, runId, resourcesPath)` that reads the trace,
reads the bundle and injects, failing with two `Schema.TaggedError`s,
`TraceUnavailable { status }` and `TraceViewerMissing { path }`; each host
`catchTag`s them into its words (and its rebuild hint) and writes the page
where it writes it. Deleted: `readCliHistoryStandaloneTemplate` (1 consumer),
`bundleFailure` and the absolute-path check, `writeTranscript`'s
`templatePath` option (its caller passes the resources path), and the
exports of `traceViewerTemplatePath` and `injectStandaloneTrace` (both
file-local after).

**What we give up.** The GUI's "empty trace" check exists only to stamp a
file name (`ChatExportController.ts:97-106`); it stays in the GUI caller.

**Change amplification.** "The page gains a second inline asset" (a
stylesheet the bundle cannot inline): today `standaloneTraceHtml.ts`,
`ChatExportController.ts`, both CLI files (4); after, 1.

**Depends on:** none.

## Finding 10 (batched). Smaller items

- **Whether a notice is waited for is decided per call site.** Of 44
  `showLogged*` calls in the extension, 20 are wrapped in
  `Effect.forkDetach(…)` (19 in `commands/`) and 24 are awaited; VS Code
  settles a notice's thenable "when being dismissed"
  (`@types/vscode` `index.d.ts:11285`), so an awaited notice holds its
  command until the user closes it (for example `latexCommands.ts:88-104`,
  whose result an `executeCommand` caller receives). A notice with no items
  has nothing to wait for: the helper decides from its arguments, forking
  itself when it offers no action (`Effect.forkDetach`, `Effect.d.ts:17255`),
  and the 19 wrappers go.
- **`commands/` holds four host-request modules.** `compareCommands.ts`,
  `latexdiffCommands.ts`, `fileSelectionCommands.ts` and `openFileCommands.ts`
  (472 lines) are imported only by `progressView/extensionHostRequests.ts`
  and register no command; `gitCommands.ts`'s `findCommitInHistory` likewise.
  AGENTS.md: "a host's own request handling sits beside the view it serves".
  Move them beside it; `commands/` then means what its name says.
- **A once-flag Effect already provides.** `promptForApiKey`'s `settled`
  (`commands/api/apiKeyCommands.ts:84-90`) guards a second `resume`, which
  `Effect.callback` already ignores ("Call `resume` at most once …; later
  calls are ignored", `Effect.d.ts:1689-1690`); the input box's `dispose` is
  idempotent. Delete the flag.
- **A sleep with no stated reason** (`latexCommands.ts:100`,
  `Effect.sleep(100)` before the success notice). If it waits for an editor
  reload, wait for that event; otherwise delete it.
- **False text in the tooling.** `sync-package-contributes.mjs:118` says the
  manifest drifted "from the settings/command catalogs" (settings are never
  synced; `configuration` is refused at `:96-100`);
  `CommandCatalog.vitest.ts:15-17` calls itself "the CI diff checks" (the
  diff gate is the sync script's `--check`).

---

## Good modules in this area

- `packages/texra/src/shared/commands/registry.ts`: `definedHandler` decodes
  a command's positional arguments once at the boundary, with
  `onExcessProperty: 'error'`, and `dispatchCommandFromRegistry` returns the
  handler's result untouched, so a rejection reaches `executeCommand` callers
  (#3782). One dispatch for both hosts.
- `commands.ts`'s registration loop: one execution boundary, every program
  run over the window's rooted filesystems (N's verdict; finding 8 keeps it
  and deletes the layer above it).
- `scripts/sync-package-contributes.mjs`: the manifest's command rows,
  keybindings and chat skills generated from their owners, a skill-name clash
  refused, `contributes.configuration` refused, and a `--check` in
  `gate:invariants`. Findings 6 and 7 extend it rather than add a tool.
- The trace viewer's boundary: one `parseTraceData` for both load paths
  (`traceDataSchema.ts:26-36`), plugin facts read by the store's own rules
  over one table (`APP_FACT_KINDS`, which the plugin registry also reads), and
  the unchanged progress webview mounted on a page-local host
  (`traceHostBridge.ts`). `injectStandaloneTrace` escapes `<` once, with the
  reason beside it (`standaloneTraceHtml.ts:22-33`).
- `promptForApiKey`'s key-portal button: the listener as a
  `Stream.callback` over `Effect.acquireRelease`, forked into the prompt's
  scope, so closing the prompt removes it (`apiKeyCommands.ts:61-98`).
- `TOOL_USE_INSTRUCTIONS` and `Plugin.prompt` sections
  (`PromptBuilder.ts:22-82`, `registry.ts:209-305`): the owners of
  cross-agent prompt text, shown only while their tool or plugin is offered.
  Finding 5 moves text to them.
- `.github/prompts/`: they point at `AGENTS.md` and the review skill instead
  of restating them.

## Already settled, left alone

- **N11's trace-viewer items, J10's catalog columns, I3, I7, M5**: found;
  cited above only for the new angle.
- **House style copied across personas.** The "Voice" paragraph (identical
  in 7 personas), the "CRITICAL - File Output Rule" (7, with four endings)
  and the LaTeX style lists (13 identical lines in `polish`, `correct`,
  `generic`; shorter variants in `devise`, `research`, `assistant`, `search`
  and the task template) are persona content, not facts a module owns. A
  bundled agent is customized as a whole-file copy stamped with `basedOn`
  (`AgentDirectoryService.ts:290-336`), a prompt is reviewed as its final
  resolved text (AGENTS.md "Prompts"), and the renderer refuses
  `{% include %}` on purpose (`packages/harness/src/utils/prompt.ts:52-60`).
  A shared fragment would change a user's copy under it without changing its
  digest. Left as copies; the wording is out of scope.
- **Tool lists per agent.** The six file tools appear in 19 of 24 tool
  personas and the five Lean tools always together in 6 files, so "add a
  sixth Lean tool" touches 6 YAML files. A group name in `tools:` would be a
  second vocabulary beside tool names and would grow an agent's offered set,
  and so its behaviour, without a prompt review; a plugin that wants a tool
  offered everywhere already has `injectedWhen`
  (`packages/harness/src/tools/plugins.ts:122-127`). Left explicit.
- **Skills' `agents/openai.yaml`** (15 files, no TeXRA reader): documented as
  optional product metadata for standalone skills
  (`docs/dev/skill-authoring.md:18`).
- **The skill's own `\criticize` definition**: skills must stand alone
  (`docs/dev/skill-authoring.md:3,12`); finding 4 asks only that its copy be
  the shared version.
- **The walkthrough bridge command**: it keeps a no-folder click from firing
  the real command's completion event (`extension.ts:246-250`); finding 7
  derives its type and keeps it.
- **`DESKTOP_LOCAL_COMMANDS` and `DesktopCommandActions`**: the same species
  as finding 8 in the desktop, area N's.

## Effect-native mapping (checked against node_modules/effect 4.1.2 .d.ts)

Most of this area is data (manifests, prompts, templates), so most rows name
a structure, not a runtime primitive. Every Effect API named was read in
`node_modules/effect/dist/` (version 4.1.2, `package.json`). There is no
`Layer.scoped` in 4.1.2 and none is proposed.

| Finding | Hand-rolled today | The structure or primitive (4.1.2) | Why it is the thing |
| ------- | ----------------- | ---------------------------------- | ------------------- |
| 1 | a Nunjucks creation pass over the runtime template, a passthrough map, `{% raw %}` per tag | none: the template as YAML data (`yaml` parse/stringify, as `memoryMeta.ts:87`), validated with `Schema.decodeUnknownEffect(AgentDefinitionSchema)` (`Schema.d.ts:1229`) before the write | one render, at run time, so no tag belongs to the wrong pass |
| 2 | a one-file copy and a one-file digest | `AgentBlock.files` (data); the copy with `FileSystem.copyFile` (`FileSystem.d.ts:85`), refusing a path outside the original's directory | the block knows its files; the harness copies what it is told without reading inside the block |
| 3 | 27 reply skeletons in YAML | none: pure TypeScript in `revisionPrompt`, from `OUTPUT_DOCUMENTS_TAG` / `OUTPUT_DOCUMENT_TAG` and the names the recipe accepts | the module that parses the reply writes the instruction for it |
| 4 | 9 macro copies, two label sets | one bound file (`task.files`); the parser's range as `Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))` (`Schema.d.ts:6180`, `:6117`) | one definition the tasks read, one range the boundary checks |
| 5 | tool mechanics in personas | none: the tool's `description`, `Plugin.prompt` (`packages/harness/src/tools/plugins.ts:130`), `TOOL_USE_INSTRUCTIONS` | each fact shown by its owner, only while the tool or plugin is offered |
| 6 | a hand tool catalog and variable list | none: generated by the sync script from the registry and `TemplateInputsSchema.fields`, checked by `--check` | the registry and the schema are the facts; the doc is a projection |
| 7 | a hand palette table | none: a `palette: false` catalog field, written by the sync script | the catalog owns a command's identity, so it owns where it appears |
| 8 | a map forwarding to an actions record; awaited notices | one id-to-handler map in `commands.ts`; the notice helper forks itself when it has no items, `Effect.forkDetach` (`Effect.d.ts:17255`, "a new fiber with no parent and no scope") | a notice with nothing to answer must not hold its command |
| 9 | two export sequences | `Effect.fn` (`Effect.d.ts:18880`) with `Schema.TaggedError` failures (`Schema.d.ts:11985`), `Effect.catchTag` at each host (`Effect.d.ts:4392`), `Effect.catchIf(absentReason, …)` (`Effect.d.ts:5517`) over `FileSystem.readFileString` (`FileSystem.d.ts:246`) | one operation with typed failures; the hosts own only their words |
| 10 | `settled` once-flag around `resume` | `Effect.callback` (`Effect.d.ts:1724`; "Call `resume` at most once …; later calls are ignored", `:1689-1690`) | the primitive already makes a second resume a no-op |
