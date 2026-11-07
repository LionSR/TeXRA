# Round 5, package I: the bundled prompts as the model reads them

This audit reads the bundled prompts whole, as resolved prompts, against the code they describe. Earlier rounds fixed single spots:

- #14822 W5 fixed the orchestrator labels and `leanBlueprint`.
- #14805 fixed the creator prose.
- The round-4 W audit covered the Lean 4 plugin.

## Sources read

- The resolved prompts a real CLI run stored in `src/test-kernel/fixtures/storage/golden-1.0.sql`. Their blobs are zstd JSON: an opening system prompt with `<delegation_targets>`, a step's sections, and the `executions` and `script` tool definitions rendered for three tool sets.
- Every bundled agent in `packages/extension/resources/agents/`, the Lean 4 and multi-agent plugins, the skills, and the two agent templates.
- The harness's prompt assembly (`packages/harness/src/agent/prompt/`), the plugin sections, and the tool descriptions.

## How to read the citations

- Line numbers are from base `c9ceb23`.
- Every finding was checked against the code it cites.
- `.agents/docs/refuted-candidates.json` refuses nothing about prompts.
- Left alone:
  - `packages/extension/resources/docs/agent-creation/*`, which package B owns (T6).
  - The three `phase(title)` mentions in `plugins/multi-agent/skills/multi-agent-orchestration/SKILL.md:41,108,241`. These follow E's rename to `section(title)`.

Fixed in this PR means a YAML or Markdown prompt changed. Code items (§3) are text in `.ts` files or behaviour; they are listed for F, not edited.

## 1. Prompts naming behaviour that no longer exists (fixed)

| #   | Prompt                                                                                                   | Says                                                                                           | Code                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `agents/orchestrator.yaml:58,62`                                                                         | Outputs are "written alongside inputs with model-specific suffixes"                            | Each revision writes `r{n}/<name>` in run storage, and nothing reaches the workspace until accepted (`texra/src/shared/constants/revisionLayout.ts:1-10`, `AcceptRunFilesTool.ts:1-9`)                                         |
| 2   | `orchestrator.yaml:58`, `plugins/lean4/agents/leanOrchestrator.yaml:30`                                  | "Output files must be a subset of the input files … list those specific files in outputFiles"  | A list that names only inputs is dropped (`texra/src/agent/output/documentRecipe.ts:105-110`), so "critique only the introduction" rewrote every input. Now: pass only those files as inputs and the rest as contextFiles      |
| 3   | `orchestrator.yaml:46`                                                                                   | Document tasks "have multi-revision reasoning with reflection"                                 | `reflect` is an opt-in launch option (`texra/src/shared/plugins/documents.ts:208`; `documentRecipe.ts:57`)                                                                                                                     |
| 4   | `orchestrator.yaml:62-64`                                                                                | The delivery has "path, lines added/removed"; read outputs via `/executions/{id}/files/{path}` | The delivery carries `read-path`, `diff`, `large-change` and `<compile-failures … log>` (`texra/src/tools/documents/documentResult.ts:79-147`)                                                                                 |
| 5   | `orchestrator.yaml:36-42`                                                                                | BAD/GOOD examples treat `agent` as if it took reference files                                  | `agent` takes no context files (`AgentTool.ts:92-114`); only `document_task` has `contextFiles`                                                                                                                                |
| 6   | `orchestrator.yaml:52`                                                                                   | "(derive agent)", and `correct` "polished"                                                     | No `derive` agent exists (now `devise`). `correct` is proofreading only, by the prompt's own rule at :70                                                                                                                       |
| 7   | `orchestrator.yaml:76`                                                                                   | "; here the appendix is short enough…"                                                         | Refers to a case that is not in the prompt                                                                                                                                                                                     |
| 8   | `orchestrator.yaml:85`, `leanOrchestrator.yaml:42`                                                       | `action=wait` "to check intermediate progress"                                                 | `wait` blocks until a status change; the tool says to use it only when you cannot proceed (`ExecutionsTool.ts:737`)                                                                                                            |
| 9   | `orchestrator.yaml:89`, `leanOrchestrator.yaml:28`                                                       | Always end with `progressCheck`; fall back to `research`/`assistant`                           | Several teams list none of them (`texra/src/shared/agentTeams.ts:77-110`), so the call fails with "Unknown agent". Now conditional on `<delegation_targets>`, in engineer's wording                                            |
| 10  | `plugins/multi-agent/.../SKILL.md:38-45`                                                                 | `document_task()` resolves to `{ documents: { outputs } }`; scripts have "no imports"          | `{ response, changes, runId, outcome, cost }` (`DocumentTaskTool.ts:118-123`); `await import('builtIn:…')` works (script tool description). `agent()` also returns `spent`                                                     |
| 11  | `SKILL.md:15-16`                                                                                         | "Launch independent calls in the same turn"                                                    | Non-Anthropic models are told to call tools one at a time (`PromptBuilder.ts:46-49`). A direct `agent` call returns at once (`AgentTool.ts:560`), so calls made one after another still run together                           |
| 12  | `agents/engineer.yaml:71-72`                                                                             | "inspect the diff via the `executions` tool"                                                   | A tool-use child has no diff route (`ExecutionsTool.ts:287-300`); its delivery lists `<touched-files>` (`subagentResults.ts:85-91`)                                                                                            |
| 13  | `agents/presenter.yaml:29`                                                                               | read_file "renders pages as images … read specific page ranges"                                | PDFs come back as one attachment with no range (`harness/src/tools/ReadTool.ts:89-94`)                                                                                                                                         |
| 14  | `plugins/lean4/agents/leanSimplifier.yaml:66`                                                            | `exact?`/`apply?` "via lean_inspect"                                                           | lean_inspect takes only `goal`, `term_goal` or `hover` (`texra/src/tools/lean/LspTools.ts:98`)                                                                                                                                 |
| 15  | `agents/search.yaml:48`                                                                                  | `download_arxiv_source` writes to "a designated downloads area"                                | It writes `References/{paper_id}` in the workspace, or the root (`texra/src/tools/arxiv/ArxivDownloadTool.ts:136`)                                                                                                             |
| 16  | `agents/progressCheck.yaml:23`                                                                           | "any live plan on `/executions/P`"                                                             | The run summary has no plan (`executionFormatters.ts:115-135`); plans are `plan` tool calls, now read with a `tool_calls` query                                                                                                |
| 17  | `progressCheck.yaml:21`                                                                                  | Diffs at `/executions/{id}/files/diffs/<name>.diff`                                            | The path is under `diff/r{n}` (`revisionLayout.ts:58`); it now follows the delivery's `diff` attribute                                                                                                                         |
| 18  | `progressCheck.yaml:38`                                                                                  | `inquiry` for "a referenced issue body, a paper abstract"                                      | `inquiry` is a question the user relays to an outside model, answered later (`texra/src/tools/inquiry/ExternalInquiryTool.ts:209-216`); progressCheck has `gh` and `web_fetch` for those                                       |
| 19  | `progressCheck.yaml:21,29`                                                                               | "workflow files/outputs"                                                                       | Document task outputs                                                                                                                                                                                                          |
| 20  | `agents/numerics.yaml:30`                                                                                | "prefer an agent with Mathematica/Wolfram access"                                              | numerics has no `agent` tool                                                                                                                                                                                                   |
| 21  | `agents/review.yaml:41`                                                                                  | "If … no editing tool is available"                                                            | review has `write_file` and `edit_file`                                                                                                                                                                                        |
| 22  | `agents/setup.yaml:42-44,183`                                                                            | Document tasks "run once"; `ocr` "(PDF → LaTeX)"; "GPT-5/4o"                                   | Tasks run fixed revisions; ocr converts handwriting images (`ocr.yaml:2`); there is no 4o chat model                                                                                                                           |
| 23  | `setup.yaml:268-273`                                                                                     | Default delegation is `polish`, `correct` or `orchestrator`                                    | The software-engineer and Lean teams list none of them (`agentTeams.ts:102-197`)                                                                                                                                               |
| 24  | `templates/agentTemplate-chat.yaml:13-15`, `agentTemplate-documentTask.yaml:6`, `agents/creator.yaml:13` | TeXRA is "a VS Code extension"; the chat template "fetch[es] web content"                      | TeXRA ships three hosts; the template's `tools:` has no web tool                                                                                                                                                               |
| 25  | `agents/ocr.yaml:26`                                                                                     | "The specific location where the OCR content should be inserted"                               | The task writes a standalone `ocr_result.tex` (:21, :40)                                                                                                                                                                       |
| 26  | `agents/merge.yaml:9-50`                                                                                 | A multi-pair branch on `INPUT_FILES[1]` with `ALL_EDITEDS`                                     | `EDITED` is one `config.editedFile` (`harness/src/agent/prompt/templateInputs.ts:220`), and the only launcher passes one pair. The branch was deleted, and the description now says `document_task` cannot pass an edited file |
| 27  | `agents/transcribe_audio.yaml:5,12`                                                                      | Asks for a summary                                                                             | No request asked for one; request 1 now does                                                                                                                                                                                   |

## 2. Contradictions, drift and redundancy (fixed)

### Output format restated in seven tasks

`correct.yaml:53`, `devise.yaml:69`, `enhance.yaml:105`, `logic.yaml:103`, `notation.yaml:95`, `polish.yaml:52` and `generic.yaml:63-65` each say "Output one updated \LaTeX document for each input file, using the matching input filename as the document name."

`documentState.ts:245-259` owns the reply format ("written here so no task restates it"). It names `OUTPUT_FILES` when the launch names outputs, so the copy contradicted the block that followed it. Deleted. `firstread.yaml:113`'s `<document name>` wording also went.

### Harness instructions against persona instructions

- **Scope.** `PromptBuilder.ts:30` says "Do only what the task requires." `orchestrator.yaml:24` said "Every change should improve the project's structure, not just fulfill the immediate request." Cleanup outside the request is now proposed, not done.
- **Permission in chat.** `PromptBuilder.ts:28` says "Do not ask for permission in chat". `setup.yaml:63-65,212-213` asked a yes/no question before `update_config`, `invoke_command`, `install_vscode_extension` and `unset_api_key`. All four are `requiresApproval: true` (`texra/src/tools/setup/*.ts`), so the user was asked twice. Chat questions now precede only `apply_team` and `send_to_terminal`, which no dialog gates.
- **Tool names.** `PromptBuilder.ts:33` says "Never mention tool names". `leanSearch.yaml:142` said "Show … which tools you tried". It now says sources and queries.
- **Duplicate of the harness.** `agentTemplate-chat.yaml:20-22` restated `PromptBuilder.ts:30` word for word. Removed.

### "Prefer a document task" said four times

The rule appeared at `orchestrator.yaml:46,48,70`; it now appears once, at :46. Deleted with the repeats:

- the `accept_run_files` and `plan` repeats at :85;
- the claim that document tasks produce "version-controlled output files".

### Drifted copies across the document tasks

All now use one wording.

- **LaTeX comments.** The rule appeared as "`%'", "`\%'" (a literal percent in LaTeX, not a comment) and `"%"` (straight quotes, which the template's own next rule forbids). The sites were `correct`, `polish`, `generic`, `enhance`, `devise`, `logic`, `notation`, `apply` and the template.
- **Macro files.** Prompts named "command.tex, commands.tex, or preamble.tex", although context files can have any name. The sites were `correct:20`, `polish:20`, `generic:21`, `apply:57`, `devise:30` and the template. All now say: use the macros the context documents and the preamble define.
- **Equation references.** `devise.yaml:31` required "always \cref". `correct`, `polish` and `generic` require `Eq.~\ref`. `\cref` fails without cleveref, and running the tasks in turn flips the style each time. Now the agent uses the command the document already uses.
- **`\tr`, `\bra`, `\ket`.** These need the physics or braket packages, and `correct.yaml:49` says not to normalize style for preference. They are now used only when the document defines or loads them.

### Self-contradictions inside one agent

- **logic.** "Removing clearly disconnected or unused paragraphs" (`logic.yaml:58,240`) is listed as a change to make, against "Deleting entire paragraphs" left for a human (:64,245). Sentences are now removed; paragraphs are flagged.
- **notation.** The example at :167 introduced `$w_i$`, a second symbol for one quantity, which the agent's own rules flag. The example at :175 "standardize[d] … across documents", against :38's minimal-change rule.
- **polish.** With no instruction, polish rewrites the whole paper, then "revert[s]" every change "NOT required by the instruction" (:5,63,66).
- **devise.** Phase 1's "show every single step" ignored the instruction's scope (:63-71). "The original level of detail" at :117 was ambiguous.

### The critic against the tasks it reviews

The critic's corrections are applied by the next revision ("Apply the corrections that hold", `documentTools.ts:239`). For annotate-only tasks this fought "Do not modify any prose outside the inserted \criticize macros" (`firstread.yaml:140`; `criticize`).

`critic.yaml` now says to state corrections on such tasks as annotations, and to state them as facts about the document. It also names the two kinds of evidence it was not told about:

- the `<missing>` note (`DocumentReviewTool.ts:40-47`);
- the whole-file diff of a newly created document.

### The severity scale per agent

- `firstread` uses its own scale, but its prefix introduced `criticize.tex`'s scale as "its scale". It now says the pass uses the scale in its instructions.
- `apply` reads argument 2 as severity, but an `enhance` annotation puts impact there. It now tells them apart by the `Suggestion:` or `Implemented:` prefix.

### firstread preamble

- It re-adds xcolor after the `\criticize` definition, which already loads it (`criticize.tex:5`). That is a double load and can clash on options. Each package now loads once.
- "Place the input content between \maketitle/abstract and \end{document}" was ambiguous for an input with its own preamble. It now places the input's body.

### Rule breaches and invented citations

- **A named person.** `enhance.yaml:250` cited a named living author and a specific work. The repo's prompt rule forbids this. Removed.
- **Invented citation keys.**
  - `enhance.yaml:63` told the model to cite with invented keys (`\cite{Kubo1966Fluctuation}`, `\cite{Ward1950Identity}`), and the same keys appear in examples at :224, :341 and :367.
  - `write/paper2slide.yaml:17` had `\cite{Smith2020Analysis}`.

  These keys are in no user's `.bib`, so they render as `??`. The prompts now cite only keys in the provided bibliography.

- **Real name as a style label.** `prover.yaml:17`, "posed in the Erdős style". It now reads "from problem collections and open-problem lists".

### Undefined macros and wrong examples in prompts

- `\dd` in `criticize.yaml:211` and `enhance.yaml:360-373`, and `\eE` in `criticize.yaml:310`, are not defined in user documents. They are now spelled out.
- Verified-correct examples at `criticize.yaml:210-211` carried confidence 1 and 2. Now 4 and 5.
- `enhance.yaml:75` gave `\\` as a paragraph break. Paragraphs now separate with a blank line.

### Terminology

- `setup.yaml:155,236` "Bringing a paper into the workspace" is now "project".
- `generic.yaml:2` "research papers" is now "research documents".

### Descriptions shown in `<delegation_targets>`

The descriptions of `enhance`, `logic`, `notation`, `merge`, `firstread`, `paper2poster` and `paper2slide` now say what each agent does:

- enhance implements results; logic and notation leave comments.
- firstread outputs one document per input.
- The paper2* templates are bundled.

### Skills

- `skills/inline-paper-critic/SKILL.md:3` showed `\\criticize` in a plain YAML scalar, so the catalog line displayed both backslashes.
- `plugins/lean4/skills/lean-tactic-improver/SKILL.md:14` said consumers must not restate the protocol. They carry its standalone fallback by design, and it is word for word the same in all four copies. The rule now says so.

## 3. Code items for F (not edited: TS strings or behaviour)

| #   | Where                                                                                               | Problem                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `texra/src/tools/documents/DocumentTaskTool.ts:44-45` vs `documentRecipe.ts:105-110`                | The `outputFiles` description says "a subset of `inputFiles`", which is the one case the recipe ignores. :121 "proposes one revised document each" is wrong for ocr, transcribe and paper2*. Pick one rule.                                                                                                        |
| C2  | `documentTools.ts:550`, `harness/src/tools/codemode/declarations.ts:124,177-202`                    | `document_propose(args: unknown)` in the script's TypeScript. `Schema.Struct({})` misses the object-root normalization that `toolSchema.ts:349-362` applies on the wire.                                                                                                                                           |
| C3  | `PromptBuilder.ts:60-84`, `texra/src/tools/registry.ts:215,236-241`                                 | Text-only runs (document revisers, the critic) still get the `tool-call` section and the `core` TeX section. The latter says to wrap `align` in `$$…$$`, a compile error inside a `.tex` document. Gate both on offered tools.                                                                                     |
| C4  | `PromptBuilder.ts:45-49`, `step.ts:432`, `llm/src/api/openaiResponsesRequest.ts:145`                | OpenAI models are told to "Call tools sequentially" while the request sends `parallel_tool_calls: true`. The script tool says to use `Promise.all`. The markdown-files line sits only in the Anthropic branch.                                                                                                     |
| C5  | `PromptBuilder.ts:91-103`                                                                           | Context updates name sections by internal key ("memory-workflow plugin") that the model never saw, and append a reworded section without withdrawing the old one: after a provider switch, both tool-call blocks stand. Tool add/remove lines come from `offered`, which includes `self` and other tools not sent. |
| C6  | `harness/src/tools/codemode/SelfTool.ts:198`, `plan/goalScript.ts:35,64`                            | Every `self()` round is told not to start `agent()` runs, so a goal on an orchestrator persona loses its main tool.                                                                                                                                                                                                |
| C7  | `delegationAvailability.ts:119`, `delegation/inputFields.ts:63`                                     | The worktree toggle is said to be under "Settings > General > Git". It is under Agents > Advanced (`settingsView/frontend/tabs/AgentsTab.ts:174,259`).                                                                                                                                                             |
| C8  | `ExecutionsTool.ts:274,280,737`; `inputFields.ts:314,329`; `agent/storage/childRunOutput.ts:98,123` | "workflows only" and "workflow results/output" mean document tasks or launch files. A mechanical `workflow`→`script` rename would make them wrong too.                                                                                                                                                             |
| C9  | `memory/MemoryTool.ts:541`, `memoryPromptSection.ts:13,15`                                          | "Pinned memories are always loaded", but nothing loads them; the section then has the model view them itself. The git-history sentence is off-topic and conflicts with `<workspace_info>`'s "avoid git history" line (`workspaceInfo.ts:141`).                                                                     |
| C10 | `harness/src/tools/bash.ts:122-131,282,331,407`                                                     | Background commands keep the 2-minute foreground timeout, while the description offers `run_in_background` as the fix for long commands. "project root" and `$PROJECT_DIR` are the working directory in a worktree.                                                                                                |
| C11 | `web/WebFetchTool.ts:42,305,320`                                                                    | The `prompt` field "describ[es] what to extract", but it is only echoed above the whole page.                                                                                                                                                                                                                      |
| C12 | `agentCli/codex.ts:427-428`, `claudeAgent.ts:482`                                                   | Worktree advice neither tool can follow: both run in the caller's working directory.                                                                                                                                                                                                                               |
| C13 | `DocumentTaskTool.ts:119,123`, `AgentTool.ts:274-281,558,562`                                       | The script result shape drifts between description, `scriptReturns` and the value (`files`, `spent`). `agent` names fewer rejections than it raises (`DuplicateCall`, `ModelUnavailable`). "It returns the agent's final reply" contradicts the background receipt.                                                |
| C14 | `texra/src/tools/registry.ts:312-313`                                                               | The documents section names `compile/<name>.log`; the path is `compile/r{n}_<name>.log`. It sends the model to list files though the delivery carries `<compile-failures … log>`.                                                                                                                                  |
| C15 | `delegationAvailability.ts:133`                                                                     | `(task)` is marked whenever `agent` is offered, but explained only when `document_task` is (see the golden_parent blob).                                                                                                                                                                                           |
| C16 | `PromptBuilder.ts:24`, `workspaceInfo.ts:149`                                                       | Name bash, glob, grep and the file tools for runs that have none (golden_child has only `executions`).                                                                                                                                                                                                             |
| C17 | `DiagnosticsTool.ts:77,170,200`                                                                     | Wrong setting name ("the experimental texra.inlineCriticism.enabled"), and the severity scale differs from `criticize.tex`.                                                                                                                                                                                        |
| C18 | `paper2poster`: `compileCheck.ts:299-311`, `documentState.ts:385-399`                               | The bundled theme `.sty` files never reach the compile directory, so the poster cannot compile unless the user has them.                                                                                                                                                                                           |
| C19 | `documentTools.ts:238-240`                                                                          | The critique is appended after the output-format block, so the format instruction is no longer last. The critic never sees the next request (`DocumentReviewTool.ts:87-89`).                                                                                                                                       |
| C20 | `PromptBuilder.ts:31`, `plan/PlanTool.ts:179`                                                       | "When an approved plan … is active, work toward it end to end" contradicts the run-as-goal reply "end this turn".                                                                                                                                                                                                  |
| C21 | `PromptBuilder.ts:74`                                                                               | The skills header says "imported" (bundled skills are listed too) and omits that a skill's relative links resolve against its directory (`skills/runtimeSkills.ts:353`).                                                                                                                                           |
| C22 | `web/WebSearchTool.ts:22`                                                                           | `max_results` is `Schema.Finite`, and a count should be `Schema.Int`.                                                                                                                                                                                                                                              |

## 4. Considered and left

- **Owner question: firstread's "preview" document.** `firstread` has no `outputs`, so its documents take the input names, and Accept writes the preview (article class, `palatino`, a "Critique preview" title) over the user's paper. Either give it an output name or keep the input's preamble. The second is a product change, so it is left.
- **The `\criticize` add-definition reminder in the request** (`criticize.yaml:288`, `logic.yaml:219`, `notation.yaml:176`). It repeats the prefix, but it sits next to the output instruction, far from the prefix in a long prompt. Kept.
- **The duplicated "inside \criticize must compile" blocks** (criticize, enhance, logic, notation). Moving them into `criticize.tex` changes the shared file every task renders, and their drift is cosmetic. Left for a follow-up.
- **The Voice and File Output paragraphs** in seven chat agents. They drift in their last sentence only, and each variant suits its agent. A shared section would be a code change.
- **Context and input documents share one `<documents>` bundle** in every prefix. Whether an echoed context document is extracted is unverified, so the structure is left.
- **`docs/guide/multiple-output.md:103`** shows "Output one updated document for each input file." in a user example. It is a public guide, not a bundled prompt.
