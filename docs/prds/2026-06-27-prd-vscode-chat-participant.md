---
created: 2026-06-27
updated: 2026-06-27
---

# PRD: @texra VS Code Chat Participant

## Problem Statement

TeXRA's current UX requires users to navigate to a dedicated webview panel, explicitly select input files through a file-picker dialog, choose an agent from a dropdown, type an instruction, and then watch progress in a separate progress board. This multi-step flow is well-suited for complex, multi-file LaTeX workflows where the user needs fine-grained control. However, it creates unnecessary friction for lightweight, single-file tasks that arise naturally during document editing: a researcher drafts a paragraph, wants it proofread for clarity, and has to leave their editor context entirely to open TeXRA's panel. The cognitive overhead of context-switching undermines the tool's value for ad-hoc queries.

VS Code's Copilot Chat panel is increasingly the surface where developers and researchers keep a persistent dialogue with AI assistants. Academic users who already have GitHub Copilot active expect to ask their AI assistant questions about the file they are currently editing without launching a separate panel. A `@texra` chat participant would make TeXRA's most commonly used Workflow agents (proofread, summarize, reformulate, check grammar) accessible directly from the chat panel by mentioning `@texra` and attaching a file reference — matching the interaction model users already have with Copilot for code.

This feature complements, not replaces, the existing webview. The full TeXRA panel remains the canonical surface for complex workflows: multi-file LaTeX projects, ToolUse agents that write code or execute commands, multi-round reflection flows, approval-gated plan execution, and the rich progress board with TodoLists and inline diffs. The chat participant is a lightweight entry point for single-file, `rounds: 1` Workflow agents that can complete without interactive approval. The two surfaces share the same underlying agent execution engine (`runAgent()` in `src/agent/runtime/runAgent.ts`) so there is no duplication of business logic.

---

## Dependencies

### VS Code Version

- **Minimum required:** `^1.105.0` (the `engines.vscode` field in `packages/extension/package.json` is currently at `^1.105.0`, which already satisfies this requirement — no version bump needed)
- The `vscode.chat.createChatParticipant()` API and `ChatResponseStream` type were stabilised in VS Code 1.90. The `disambiguation` field used for Copilot auto-routing was added in 1.99. Using `^1.105.0` covers all required surface area.

### GitHub Copilot

- **Required for the `@texra` mention surface.** The `vscode.chat` namespace is populated only when the GitHub Copilot Chat extension (`github.copilot-chat`) is installed and the user has an active Copilot subscription (Individual, Business, or Enterprise).
- **Not required for the AI computation.** The participant calls TeXRA's own `runAgent()` pipeline with TeXRA-configured API keys (Anthropic, OpenAI, Google, or OpenRouter). `request.model` is never used.
- Users without Copilot access the same functionality through the `texra.runFromChatPrompt` command palette command (see Fallback section).

### TeXRA Version

- This feature targets TeXRA v0.39.0 and above.
- Depends on `AgentRuntimeHost` interface (`src/agent/runtime/AgentRuntimeHost.ts`), `runAgent()` (`src/agent/runtime/runAgent.ts`), and `ValidatedExecutionRequest` / `validateExecutionRequest` (`src/agent/core/execution/executionRequests.ts`) — all present in the current codebase.
- The `approvalPromptsUnavailable` flag in `RunAgentOptions` is confirmed to be wired through `executeAgent.ts` into `RunContext` and used in tool resolution; passing it suppresses ToolUse categories at resolution time.

---

## Goals and Non-Goals

### Goals

- Register a `@texra` VS Code chat participant so users can invoke single-file, `rounds: 1` Workflow agents directly from the Copilot Chat panel.
- Accept file context via `#file:` references in the chat prompt, resolving `ChatPromptReference` values whose `.value` is a `vscode.Uri` or `vscode.Location` to absolute workspace paths that populate `AgentConfig.inputFiles[0]`.
- Let users specify an agent by name in the chat prompt (e.g., `@texra /proofread #file:intro.tex`) using declared chat commands that map to TeXRA agent YAML identifiers.
- Execute agents through TeXRA's own model pipeline (`runAgent()`, `runReflectionFlow()`) using the user's existing TeXRA API keys. `request.model` (the Copilot language model) is never used.
- Stream progress updates back through `ChatResponseStream.progress()` during the agent run, translated from `AgentRuntimeHost.emit()` lifecycle events.
- Write output files to disk via the existing agent pipeline (`XmlOutputManager`, `AgentOutputHandler`). After completion, surface a clickable file link via `ChatResponseStream.anchor()` and a "View LaTeX diff" button via `ChatResponseStream.button()` that invokes `texra.latexdiff`.
- Stream a markdown summary of the agent's output derived from `OutputFileSummary.added` and `OutputFileSummary.removed` line counts (when available; fields are `z.int().nonnegative().nullable()` — always present but may be `null`, hence `?? '?'` as the fallback).
- Provide follow-up suggestions via `ChatFollowupProvider` pointing to related agents, re-attaching the file reference from the previous turn.
- Gracefully handle the case where the user does not have Copilot Chat active by offering `texra.runFromChatPrompt`, a command palette command that opens a QuickPick + InputBox flow and calls the same underlying `buildChatAgentConfig()` and `runAgent()` path.
- Gate the feature behind a `texra.chatParticipant.enabled` setting that defaults to `true`, allowing administrators to disable it globally without uninstalling the extension.
- Comply with Microsoft AI tools guidelines and GitHub Copilot extensibility policy before Marketplace submission.

### Non-Goals (v1)

- **ToolUse agents** (`agentCategory: 'ToolUse'`). The approval loop (`showToolEditPermission`, `showBashPermission`, `showPlanApproval`) cannot be fulfilled inside a single `ChatRequestHandler` invocation; `ChatResponseStream` has no mechanism to pause and await mid-stream user input.
- **Multi-file workflows.** `AgentConfig.outputFiles.length` must not exceed `AgentConfig.inputFiles.length` (enforced by `AgentConfigSchema.superRefine`). Only a single `#file:` reference is processed in v1.
- **Multi-round Workflow agents (`rounds > 1`).** The default `rounds` value in `AgentDataclass` is `2`; agents exposed in the chat participant must explicitly set `rounds: 1` in their YAML. Agents without an explicit `rounds: 1` are excluded from the `CHAT_COMMAND_TO_AGENT` map.
- **Displaying the TeXRA progress board inside the chat stream.** `ChatResponseStream` has no webview embedding. Users can open the progress board via the "View live progress" `stream.button()` call.
- **Using `request.model` or `vscode.lm.selectChatModels()` for the AI call.** The participant is fully decoupled from Copilot's AI infrastructure.
- **Registering VS Code Language Model Tools via `vscode.lm.registerTool()`.** Tool-use integration is deferred to v2.
- **Resuming interrupted agent sessions via `ChatResult.metadata`.** TeXRA's ToolUse resume path (`resumeToolUseFromSnapshot()`) requires a binary-serialised `ToolUseSessionSnapshot` that cannot be stored in `ChatResult.metadata` and reconstructed reliably.
- **The `#selection` reference as implicit input.** Users must attach a file explicitly via `#file:`.
- **Writing output to locations outside the workspace.** The agent YAML's `defaultOutputFiles` governs output paths; the participant does not override them.
- **Server-side relay key pathway (Supabase-gated).** Assumed to work transparently through the existing `platform().secrets` path, not explicitly tested in v1.
- **Disambiguation auto-routing by Copilot** (present in manifest, best-effort only — Copilot's routing is non-contractual and may not fire).
- **Internationalization** of participant description strings and command descriptions.
- **Publishing compliance review** with Microsoft AI guidelines — required before Marketplace submission but not a code deliverable.
- **A "default model" setting.** There is no `texra.model.default` config key in the current codebase. The participant reads the model ID from the persisted main view state via `platform().globalState` (same store used by the main webview; exact key confirmed when Open Question 2 is resolved), or falls back to `DEFAULT_AGENT_MODEL` (`'gemini35f'`) from `src/shared/constants/providers.ts` if no model has been selected yet. It does not prompt the user to pick a model.

---

## User Stories

### US-1: Quick proofread from the chat panel

**As** an academic researcher editing `intro.tex`, **I want** to type `@texra /proofread #file:intro.tex` in the Copilot Chat panel and receive an edited version of the file **so that** I can stay in my editor context without opening the TeXRA webview.

**Acceptance criteria:**

- The agent runs and writes the revised file to the same path as the input file. `correct` is an edit agent with no `defaultOutputFiles` declaration — it rewrites the input in place. The output path therefore always equals the input path for `/proofread` in Phase 1.
- A "View LaTeX diff" button appears in the chat response invoking `texra.latexdiff` with three arguments `[inputPath, inputPath, outputPath]` (`handleLatexdiff(inputFile, baseFile, editedFile)` — `inputPath` doubles as both first and second argument; `outputPath` is the revised file). The button is omitted when the agent writes in place (`outputPath === inputPath`), since comparing a file against itself yields an empty diff. For `/proofread` specifically, this means the diff button is never shown in Phase 1 — the chat response includes only the markdown summary and a file anchor pointing to the (now-revised) input path.
- The chat response includes a markdown summary showing the line delta: "Added N lines, removed M lines" derived from `WorkflowFlowResult.outputs[0].added` and `.removed`.
- The total elapsed time from `ChatRequest` receipt to `ChatResult` return does not exceed the runtime of an equivalent run in the TeXRA webview by more than 2 seconds.

### US-2: Grammar check with model selection

**As** a researcher with an Anthropic API key configured in TeXRA, **I want** to type `@texra /grammar #file:methods.tex` and have the agent run using my configured TeXRA model **so that** I do not need a GitHub Copilot subscription for the AI computation itself.

**Acceptance criteria:**

- The agent uses the model ID read from the persisted main view state (via `platform().globalState`), falling back to `DEFAULT_AGENT_MODEL` if no model has been saved. `request.model` is never consulted.
- If no TeXRA API key is configured for the resolved model provider, the chat response emits an error message with a "Configure API key" button that invokes `texra.setApiKey` to open the API key QuickPick.
- GitHub Copilot is required only for the `@texra` mention surface to appear; the AI call goes through TeXRA's own infrastructure.

### US-3: Agent selection via `/command`

**As** a user in the chat panel, **I want** to see a list of available TeXRA agents when I type `@texra /` **so that** I can discover agents without opening the TeXRA webview.

**Acceptance criteria:**

- Chat commands declared in `packages/extension/package.json` under `contributes.chatParticipants[0].commands` correspond only to agents that have `agentCategory: workflow` and `rounds: 1` explicitly set in their YAML.
- Each command's `description` string is manually authored for VS Code command-completion UX (the agent YAML's `description` field is typically longer prose, unsuitable for the compact completion list).
- Selecting a command from the VS Code completion list populates the command name in the chat input box.
- An unrecognized `/command` causes the handler to respond with: "Unknown command `/name`. Available commands: /proofread." (Phase 1 example — the list is always derived at runtime from `CHAT_COMMAND_TO_AGENT` keys, never hardcoded; in later phases the list grows as more agents are added.)

### US-4: Free-form instruction with `#file:` reference

**As** a researcher, **I want** to type `@texra reformulate the abstract for a broader audience #file:paper.tex` (no `/command` prefix) **so that** I can give a free-form instruction without memorizing command names.

**Acceptance criteria:**

- When no `/command` is present (i.e., `request.command` is `undefined`), the participant uses the `correct` agent (TeXRA's general-purpose Workflow agent) and sets the full stripped prompt text as `AgentConfig.instruction`.
- The `#file:` reference is required; if no `ChatPromptReference` with a `vscode.Uri` or `vscode.Location` value is present, the response emits the missing-file error (see US-8).
- Instruction text is extracted by removing `ChatPromptReference` tokens from `request.prompt` at the offsets provided by `request.references[i].range`, then trimming whitespace.

### US-5: Graceful degradation without Copilot

**As** a TeXRA user without a GitHub Copilot subscription, **I want** to still access the lightweight, single-file agent flow **so that** I am not locked out of this feature.

**Acceptance criteria:**

- `texra.runFromChatPrompt` is registered unconditionally in `packages/extension/src/extension.ts`, regardless of whether `vscode.chat` is defined.
- It opens a `vscode.window.showQuickPick()` for agent selection (populated from `CHAT_COMMAND_TO_AGENT` keys), then a `vscode.window.showInputBox()` for the instruction, then resolves the active editor file (`vscode.window.activeTextEditor?.document.uri.fsPath`) as the default input file with a file-picker fallback if no editor is active.
- The same `buildChatAgentConfig()` function is called as in the participant handler. The same `runAgent()` call path executes.
- The command's VS Code contribution entry has `"title": "Run a TeXRA agent from the command palette (fallback for users without Copilot Chat)"`. (VS Code's `contributes.commands` schema uses `title`, not `description`.)

### US-6: Progress visibility during long-running agents

**As** a user who submitted a `@texra /proofread` request on a 15-page document, **I want** to see progress updates in the chat panel as the agent runs **so that** I know the agent has not stalled.

**Acceptance criteria:**

- `ChatResponseStream.progress()` is called within 500 ms of handler invocation with the text "TeXRA agent started".
- `ChatResponseStream.button()` is called within 500 ms of handler invocation with `{ title: 'View live progress', command: 'texra.showProgressView', arguments: [] }`.
- `ChatResponseStream.progress()` is called again when `AgentRuntimeHost.emit('updateStreamStatus', ...)` fires with `status === 'running'`.
- If `CancellationToken.isCancellationRequested` becomes `true`, the `AbortController` passed via `RunAgentOptions` (if exposed — see Open Question 5) is aborted, and the handler returns `{ errorDetails: { message: 'Run cancelled by user.' } }`.

### US-7: Follow-up suggestions after completion

**As** a user who just ran `@texra /proofread`, **I want** to see suggested follow-up actions in the chat **so that** I can continue improving my document without typing the next command from scratch.

**Acceptance criteria:**

- `ChatFollowupProvider.provideFollowups()` is called after each successful run and returns 2–3 `ChatFollowup` objects, for example: `{ prompt: '@texra /grammar #file:intro.tex', label: 'Check grammar', title: 'Check grammar' }`, `{ prompt: '@texra /summarize #file:intro.tex', label: 'Summarize', title: 'Summarize' }`.
- The file path from the previous turn's `ChatResult.metadata.inputFile` is re-attached in the follow-up `prompt` string.
- `provideFollowups()` returns an empty array when the previous `ChatResult.errorDetails` is set.

### US-8: Error handling for missing file or model

**As** a user who forgot to attach a `#file:` reference, **I want** to receive a clear error message and an example of the correct syntax **so that** I can immediately retry without consulting documentation.

**Acceptance criteria:**

- If no `ChatPromptReference` with a `vscode.Uri` or `vscode.Location` value is found in `request.references`, the handler emits: "Please attach a file using `#file:` — for example: `@texra /proofread #file:intro.tex`". It then returns `{ errorDetails: { message: 'No file reference provided.' } }` and does not call `runAgent()`.
- If a `ChatPromptReference` value is a plain `string` (text reference, not a file URI), the handler emits: "The reference `#mention` was not recognized as a file. Use `#file:intro.tex` to attach a file."
- If the resolved `uri.fsPath` does not exist on the filesystem (checked via `platform().fs`), the handler emits the path and suggests checking the workspace root.
- If `request.command` is set but not in `CHAT_COMMAND_TO_AGENT`, the handler emits the unrecognized command error (see US-3) and returns without calling `runAgent()`.
- All error messages are emitted via `stream.markdown()` before returning `{ errorDetails: { message: '...' } }`.

---

## Proposed Design

### Chat Participant Registration (`packages/extension/package.json`)

Add the following to `contributes` in `packages/extension/package.json`. Commands are restricted to agents that satisfy both the **structural** constraint (`agentCategory: workflow` and `rounds: 1` explicitly set in their YAML) and the **semantic** constraint (single-file input). Among all current agent YAMLs (root-level and subdirectories): `correct.yaml` satisfies both; `merge.yaml` passes the structural constraint (`rounds: 1`, `agentCategory: workflow`) but is excluded on semantic grounds — it is designed for two-document merging and requires two input files, which is incompatible with the single-file `#file:` reference in the chat handler; the remaining YAMLs (`polish.yaml`, `ocr.yaml`, `transcribe_audio.yaml` at root; `write/paper2poster.yaml`, `write/paper2slide.yaml` in the subdirectory) do not declare `rounds: 1` and are excluded from v1.

**Phase 1 manifest (ships in v1):**

```json
"chatParticipants": [
  {
    "id": "texra.agent",
    "name": "texra",
    "fullName": "TeXRA Agent",
    "description": "Run TeXRA AI agents on your LaTeX files. Attach a file with #file: and use /proofread. No Copilot model is used — TeXRA uses your configured API keys. Without Copilot, use the 'TeXRA: Run from Chat Prompt' command instead.",
    "isSticky": false,
    "commands": [
      { "name": "proofread", "description": "Proofread the attached file for clarity and style" }
    ],
    "disambiguation": [
      {
        "category": "texra-latex",
        "description": "The user wants to edit, proofread, summarize, or improve a LaTeX document",
        "examples": [
          "proofread my introduction",
          "fix grammar in my methods section",
          "make this paragraph shorter"
        ]
      }
    ]
  }
]
```

**Full target state (Phase 2+):** Commands are added to the manifest `commands` array and to `CHAT_COMMAND_TO_AGENT` together, one at a time, as each agent YAML is created and audited for `rounds: 1, agentCategory: workflow`. The full target `commands` array (reached incrementally, pending the Open Question 1 audit) is:

```json
[
  {
    "name": "proofread",
    "description": "Proofread the attached file for clarity and style"
  },
  {
    "name": "grammar",
    "description": "Check and correct grammar in the attached file"
  },
  {
    "name": "summarize",
    "description": "Summarize the content of the attached file"
  },
  {
    "name": "reformulate",
    "description": "Reformulate text for a specified audience or style"
  },
  {
    "name": "expand",
    "description": "Expand and elaborate on the content of the attached file"
  },
  { "name": "shorten", "description": "Shorten and condense the attached file" }
]
```

When all six commands are registered, the participant `description` field should also be updated to enumerate them. Never register a command in the manifest without a corresponding entry in `CHAT_COMMAND_TO_AGENT` — a registered command with no map entry will appear in VS Code's completion dropdown but return an "Unknown command" error at runtime.

The `isSticky: false` setting is intentional. Each agent invocation is a self-contained run; keeping `@texra` sticky would suggest a conversational back-and-forth that v1 does not support — each turn independently calls `runAgent()` with no shared session state.

Note: The `disambiguation` block is best-effort. The VS Code Chat API does not guarantee that Copilot will auto-route ambiguous queries to `@texra`; this is treated as a discovery aid, not a functional guarantee.

### Rollout Strategy

**Feature flag.** A `texra.chatParticipant.enabled` boolean configuration entry (default `true`) is added to `packages/extension/package.json` under `contributes.configuration.properties`. The participant registration in `extension.ts` checks this setting before calling `vscode.chat.createChatParticipant()`. Users and administrators can set it to `false` to opt out entirely.

**Copilot guard.** Participant registration is wrapped in a runtime check: `if (typeof vscode.chat !== 'undefined' && typeof vscode.chat.createChatParticipant === 'function')`. When Copilot is absent, the guard fails silently and only the `texra.runFromChatPrompt` command palette fallback is active.

**Fallback command always available.** `texra.runFromChatPrompt` is registered unconditionally. It is the primary entry point for users without Copilot and is documented in the participant's `description` field.

**Phased rollout.** The feature ships behind `texra.chatParticipant.enabled: true` by default starting in the first release that passes the Phase 5 publishing compliance review. If the Marketplace compliance review is pending, the default can be temporarily set to `false` in the published VSIX and flipped to `true` in a follow-up patch release.

**No server-side flag.** There is no relay/feature-flag infrastructure in TeXRA; the setting in `package.json` contributes is the sole gate.

### Chat Command to Agent YAML Mapping

A static map in the new participant module maps `/command` names to TeXRA agent YAML identifiers. Eligible agents must satisfy both the structural constraint (`agentCategory: workflow` and `rounds: 1` explicitly set in their YAML) and the semantic constraint (single-file input). An audit of all current root-level YAMLs in `packages/extension/resources/agents/` finds that `correct.yaml` satisfies both constraints. `merge.yaml` has `rounds: 1` and `agentCategory: workflow` (structural constraint met) but is excluded on semantic grounds — it requires two input documents and is incompatible with the single `#file:` reference model of the chat handler. The remaining root-level YAMLs do not satisfy the structural constraint. The commands below that reference non-`proofread` agents are placeholders for Phase 2+ and are blocked on Open Question 1 and new YAML creation; the pre-Phase-1 audit must populate the final map.

```typescript
// packages/extension/src/commands/chat/agentCommandMap.ts
export const CHAT_COMMAND_TO_AGENT: Record<string, string> = {
  proofread: 'correct', // correct.yaml — agentCategory: workflow, rounds: 1 confirmed
  grammar: 'grammar-check', // must be confirmed in audit
  summarize: 'summarize', // must be confirmed in audit
  reformulate: 'reformulate', // must be confirmed in audit
  expand: 'expand', // must be confirmed in audit
  shorten: 'shorten', // must be confirmed in audit
};

/** Default agent when no /command is given. */
export const DEFAULT_CHAT_AGENT = 'correct';
```

Entries marked "must be confirmed in audit" are blocked on Open Question 1. Until that audit completes, the `CHAT_COMMAND_TO_AGENT` map used in Phase 1 contains only `proofread: 'correct'`.

### How the Handler Parses `ChatRequest`

The handler (`TexraChatParticipant.handle()`) processes a `vscode.ChatRequest` in this order:

<!-- prettier-ignore -->
1. **Extract file references.** Iterate `request.references`. For each entry, inspect `.value`: if it is a `vscode.Uri`, extract `uri.fsPath`; if it is a `vscode.Location`, extract `location.uri.fsPath`. Track any entries whose `.value` is a plain `string` (text references — these are not file URIs) in a `stringRefs` list. Validate that each resolved path is under a workspace folder: if `vscode.workspace.workspaceFolders` is `undefined` or empty, skip the workspace-membership check for this step (the workspace guard in Step 6 will catch and handle this before calling `runAgent()`); if `workspaceFolders` is defined but the resolved path does not lie under any `workspaceFolder.uri.fsPath`, skip that reference silently — it does not qualify as `inputFiles[0]`. The first qualifying URI becomes `AgentConfig.inputFiles[0]`. If additional qualifying URIs were found after the first, emit a markdown warning before proceeding: `"Multi-file workflows require the TeXRA panel — only [first-filename] will be used."` After iterating all references, if no qualifying URI was found: if `stringRefs` is non-empty (the user attached a mention but not a file), emit the specific "not recognized as a file" error from US-8 for each string entry (`"The reference \`#mention\` was not recognized as a file. Use \`#file:intro.tex\` to attach a file."`) and return `{ errorDetails: { message: 'No file reference provided.' } }` without calling `runAgent()`; if `stringRefs` is empty (no references at all), emit the generic missing-file message from US-8 (`"Please attach a file using \`#file:\`..."`) and return.

2. **Resolve agent name.** If `request.command` is set and present in `CHAT_COMMAND_TO_AGENT`, use the mapped YAML identifier. If `request.command` is set but absent from the map, emit the unrecognized-command error and return without calling `runAgent()`. If `request.command` is `undefined`, use `DEFAULT_CHAT_AGENT`.

3. **Extract instruction text.** Note: VS Code strips the `/command` prefix from `request.prompt` before invoking the handler — `request.prompt` contains only the text after the command name, never the `/command` token itself. Remove `ChatPromptReference` tokens from `request.prompt` using the character offsets in `request.references[i].range` (a `[start, end]` number tuple within the prompt string, not a `vscode.Range`). Remove in **descending** start-offset order — removing a span at a lower offset invalidates every subsequent offset, so process from the end of the string backwards. Trim the result. If the result is empty and a `/command` was given, pass an empty instruction string (`''`) to `AgentConfig.instruction` — the agent YAML's own `userPrefix`/`userRequest` template provides the necessary prompting context and the pipeline treats empty instruction as "run the agent's default behavior". If the result is empty and no command was given, return early with: "Please describe what you want TeXRA to do with the file."

4. **Resolve model.** Read the persisted model ID from `platform().globalState` using the same key used by the main webview (exact key confirmed when Open Question 2 is resolved). Fall back to `DEFAULT_AGENT_MODEL` (`'gemini35f'`) from `src/shared/constants/providers.ts` if the state value is absent or unparseable.

5. **Validate resolved agent category and rounds.** Load the agent YAML via `loadAgentSettingAndPrompts(agentName)`. Confirm `agentCategory === AgentCategory.Workflow` and `rounds === 1`. If either check fails, emit: "The agent `[name]` requires the TeXRA panel for interactive approval or multi-round workflows. [Open TeXRA button invoking `texra.showMainView`]" and return.

6. **Guard workspace, then build and validate `AgentConfig`.** First check: if `vscode.workspace.workspaceFolders` is `undefined` or empty, emit "TeXRA requires an open workspace folder. Please open a folder (File > Open Folder) before running `@texra`." and return without calling `runAgent()`. Then call `const chatConfig = buildChatAgentConfig({ filePath: resolvedFilePath, agentName: resolvedAgentName, instruction: extractedInstruction, modelId: resolvedModelId, workspaceRoot: vscode.workspace.workspaceFolders[0].uri.fsPath })`. `buildChatAgentConfig` constructs the `AgentConfigInput` and calls `validateExecutionRequest` internally, returning a `ChatAgentConfigResult` (`{ valid: true; request: ValidatedExecutionRequest } | { valid: false; message: string }`). If `chatConfig.valid` is `false`, surface `chatConfig.message` as a user-facing error and return. The validated request (`chatConfig.request`) is passed directly to `runAgent()` in Step 9.

7. **Emit initial progress and buttons.** Call `stream.progress('TeXRA agent started')` and `stream.button({ title: 'View live progress', command: 'texra.showProgressView', arguments: [] })` before awaiting `runAgent()`. This satisfies the US-6 requirement of a progress signal within 500 ms of handler entry (before any async I/O in the launch path). The `setActiveStream` event emitted at the start of `runAgent()` is a no-op in `ChatStreamAgentRuntimeHost` — it would otherwise produce a duplicate progress message.

8. **Construct `ChatStreamAgentRuntimeHost`.** Create a new instance with `stream`. No `onOutputFiles` callback is needed — Step 10 reads output paths directly from `result.outputs`.

9. **Call `runAgent(chatConfig.request, { runtimeHost, approvalPromptsUnavailable: true })`.** Wire `token.onCancellationRequested` to abort the run (see Open Question 5 regarding `AbortController` in `RunAgentOptions`).

10. **On completion**, first check `token.isCancellationRequested`: if true, return `{ errorDetails: { message: 'Run cancelled by user.' } }` without emitting success content. Otherwise, narrow `result` to the workflow variant (see Output File Handling below), then emit `stream.anchor()` for each output file, a `stream.button()` for the LaTeX diff, and a markdown summary derived from `result.outputs[0].added` / `.removed`. Return `ChatResult` with `metadata: { inputFile, outputFiles, agentName }`.

### Mapping Chat Context to `AgentConfig`

| Chat API field                                                     | `AgentConfig` field | Notes                                                                                                |
| ------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `request.references[i].value` (Uri or Location)                    | `inputFiles[0]`     | First qualifying URI only; others ignored in v1                                                      |
| Stripped instruction text                                          | `instruction`       | After removing reference ranges from `request.prompt`                                                |
| `request.command` → `CHAT_COMMAND_TO_AGENT`                        | `agent`             | Falls back to `DEFAULT_CHAT_AGENT` when no command given                                             |
| `platform().globalState` model key, fallback `DEFAULT_AGENT_MODEL` | `model`             | Never `request.model`                                                                                |
| `vscode.workspace.workspaceFolders[0].uri.fsPath`                  | `workingDirectory`  | Guard: if `workspaceFolders` is `undefined` or empty, return error before accessing index 0 (Step 6) |
| —                                                                  | `outputFiles`       | Empty; agent YAML `defaultOutputFiles` governs output paths                                          |

Conversation history from `context.history` is not forwarded to the agent's LLM call in v1. Each invocation is stateless from TeXRA's perspective. `ChatResult.metadata` stores `{ inputFile, outputFiles, agentName }` for use by `ChatFollowupProvider`.

### Agent YAML and Model Selection

The participant does not construct its own system prompt. It uses the existing agent YAML loaded by `loadAgentSettingAndPrompts()` (called inside `buildAgentLaunchContext()`). The full `systemPrompt`, `userPrefix`, `userRequest`, `documentTag`, `endTag`, `temperature`, and all other YAML fields are respected exactly as in the webview flow.

Model selection follows the same `ModelFactory.createModelHandler()` routing as the webview: Anthropic, OpenAI, Google, or OpenRouter depending on the resolved model ID. The participant never calls `vscode.lm.selectChatModels()`.

### Streaming Response Through `ChatResponseStream`

The `ChatStreamAgentRuntimeHost` translates `AgentRuntimeHost.emit()` events:

| `ProgressEventPayloads` event                           | `ChatResponseStream` call                                                                                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setActiveStream`                                       | no-op — initial progress is emitted in Step 7 before `runAgent()` to satisfy the US-6 500 ms deadline; re-emitting here would produce a duplicate                                                                                            |
| `updateStreamStatus` `status === 'initializing'`        | `stream.progress('Initializing model handler...')`                                                                                                                                                                                           |
| `updateStreamStatus` `status === 'running'`             | `stream.progress('Agent running...')`                                                                                                                                                                                                        |
| `updateStreamStatus` `terminalStatus === 'completed'`   | no-op — post-run anchor/diff-button/summary emission is done by Step 10 in the handler after `runAgent()` resolves, where `result.outputs` (including `.added`/`.removed` line counts) is available                                          |
| `updateStreamStatus` `terminalStatus === 'error'`       | no-op — error already surfaced via `requestShowError` (see row below); payload has no `.error` field                                                                                                                                         |
| `updateStreamStatus` `terminalStatus === 'interrupted'` | `stream.markdown('Agent cancelled.')`                                                                                                                                                                                                        |
| `requestShowError`                                      | `stream.markdown('**Error:** ' + payload.message)` — launch failures and terminal result errors route through this event (`AgentLaunchContext.ts:565`, `terminalResultToast.ts:30`), not through `updateStreamStatus terminalStatus='error'` |
| `addOutputFiles`                                        | no-op — Step 10 reads output paths directly from `result.outputs`; the host does not need to track them                                                                                                                                      |
| `requestEnsureProgressView`                             | `stream.button({ title: 'View live progress', command: 'texra.showProgressView', arguments: [] })`                                                                                                                                           |
| All `show*Permission` / `show*Approval` events          | no-op (blocked upstream by `approvalPromptsUnavailable: true`)                                                                                                                                                                               |
| All frontend-bound ignorable events                     | no-op                                                                                                                                                                                                                                        |

Events in the "frontend-bound, ignorable" group as documented in `AgentRuntimeHost.ts` (`requestOpenFile`, `requestShowInstruction`, `showAgentConfigBanner`, `*SubscriptionsChanged`, `toolAvailabilityChanged`) are silently dropped. Note: `requestShowError` is **not** ignorable — it carries user-facing error messages for launch failures.

### Output File Handling

After `runAgent()` resolves with an `AgentFlowResult`, narrow to the workflow variant before reading `.outputs`:

0. **Guard the category.** If `result.category !== 'workflow'`: emit `stream.markdown('**Error:** Unexpected agent result category.')` and return. (In practice this cannot happen since the participant only dispatches Workflow agents, but the narrowing is required by the type system and protects against future regressions.)

1. For each `OutputFileSummary` in `result.outputs`, call `stream.anchor(vscode.Uri.file(summary.absolutePath), path.basename(summary.absolutePath))`.
2. If `summary.absolutePath !== inputPath` (agent wrote to a separate output file): emit `stream.button({ title: 'View LaTeX diff', command: 'texra.latexdiff', arguments: [inputPath, inputPath, summary.absolutePath] })`. (`handleLatexdiff` takes `inputFile`, `baseFile`, `editedFile` — `inputPath` doubles as both the first and second argument; `summary.absolutePath` is the revised file.) If `summary.absolutePath === inputPath` (in-place overwrite): skip the diff button — comparing the file against itself yields an empty diff; the pre-run UX note below serves as the sole warning.
3. Emit markdown: `**Changes:** +${summary.added ?? '?'} lines, −${summary.removed ?? '?'} lines`.
4. Return `{ metadata: { inputFile: resolvedFilePath, outputFiles: result.outputs.map(o => o.absolutePath), agentName } }`.

Output files are written to disk by the existing agent pipeline (`XmlOutputManager`, `AgentOutputHandler`) — the participant does not call `platform().fs` directly for output.

**UX note on in-place writes.** Some Workflow agents write output back to the same path as the input file. In the TeXRA webview this is explicit because the user selects files through a picker. In chat mode the user may not realize `@texra /proofread #file:intro.tex` will overwrite `intro.tex`. To address this: before calling `runAgent()`, emit `stream.markdown('⚠️ Note: this agent will overwrite the input file in place. The original content will be replaced.')` if the loaded agent YAML has **no `defaultOutputFiles` declaration** (edit agents — including `correct` — fall into this category; they inherit input paths as output paths rather than declaring explicit outputs), or if its `defaultOutputFiles` would resolve to the same path as the input file. Do not key this check off `outputFiles: []` in `AgentConfigInput` — that field is always empty when called from chat, regardless of whether the agent is an edit-type or a new-artifact-type agent. No diff button is shown in the in-place case. A confirmation step via `stream.button()` is out of scope for v1 (the chat API does not support awaiting button clicks mid-stream); this note is the only pre-run warning.

### Fallback for Users Without Copilot Chat

`vscode.chat` is undefined when Copilot is not installed. The registration code in `extension.ts` guards participant creation:

```typescript
if (
  config.get<boolean>('texra.chatParticipant.enabled', true) &&
  typeof vscode.chat !== 'undefined' &&
  typeof vscode.chat.createChatParticipant === 'function'
) {
  const participant = vscode.chat.createChatParticipant(
    'texra.agent',
    handler.handle.bind(handler),
  );
  context.subscriptions.push(participant);
}
```

The `texra.runFromChatPrompt` command is registered unconditionally above this guard and is the primary fallback. It uses `buildChatAgentConfig()` — the same utility as the participant handler — so both paths produce identical `AgentConfig` objects for equivalent user inputs.

---

## Technical Architecture

### New Files to Create

```
packages/extension/src/commands/chat/
  TexraChatParticipant.ts          # Main handler class; implements ChatRequestHandler
  ChatStreamAgentRuntimeHost.ts    # Translates AgentRuntimeHost.emit → ChatResponseStream calls
  agentCommandMap.ts               # /command → agent YAML name map + DEFAULT_CHAT_AGENT
  buildChatAgentConfig.ts          # Shared config construction; calls validateExecutionRequest()
  chatFollowupProvider.ts          # Implements vscode.ChatFollowupProvider
  runFromChatPromptCommand.ts      # texra.runFromChatPrompt command; QuickPick + InputBox flow
```

### Existing Files to Modify

```
packages/extension/src/extension.ts
  — Add guarded participant registration (texra.chatParticipant.enabled + typeof vscode.chat check)
  — Register texra.runFromChatPrompt unconditionally

packages/extension/package.json
  — Add contributes.chatParticipants entry
  — Add texra.chatParticipant.enabled to contributes.configuration.properties
  — Add contributes.commands entry for texra.runFromChatPrompt

packages/extension/src/commands.ts
  — Export runFromChatPromptCommand for registration
```

No files in `src/agent/`, `src/model/`, `src/eventBus/`, `src/latex/`, or other VS Code-free zones are modified. The participant is purely additive to the extension host layer.

### Data Flow Diagram (ASCII)

```
User types: @texra /proofread #file:intro.tex
                |
                v
    VS Code Chat Panel (Copilot Chat host)
                |
                v
    TexraChatParticipant.handle(request, context, stream, token)
                |
                v
    [Guard: texra.chatParticipant.enabled?]
                |
                v (yes)
     +----------+----------+
     |                     |
     v                     v
Parse request.references  Parse request.command
(value: vscode.Uri →      (CHAT_COMMAND_TO_AGENT
 uri.fsPath, validate     lookup → 'correct')
 workspace membership)
     |                     |
     +----------+----------+
                |
                v
     Validate agent YAML: agentCategory === Workflow && rounds === 1
                |
                v
     buildChatAgentConfig() → ChatAgentConfigResult
     (validates internally; if valid: false → emit error and return)
                |
                v
     stream.button('View live progress', 'texra.showProgressView')
     stream.progress('TeXRA agent started')        ← < 500 ms after handler entry
                |
                v
     ChatStreamAgentRuntimeHost (new)
       implements AgentRuntimeHost
         .emit(event, payload)
           → stream.progress(...)    (lifecycle events)
           → stream.button(...)      (requestEnsureProgressView)
                |
                v
     runAgent(validatedRequest, {
       runtimeHost: chatStreamHost,
       approvalPromptsUnavailable: true
     })
       → executeAgent()
         → buildAgentLaunchContext()
           → loadAgentSettingAndPrompts()     (reads YAML from resources/)
           → ModelFactory.createModelHandler()  (TeXRA API keys — not request.model)
         → runFlowWithLifecycle()
           → runReflectionFlow()       (rounds:1 Workflow agents only)
             → IModelHandler.createResponse()
             → IModelHandler.extractResponse()
             → XmlOutputManager writes files to disk
                |
                v
     AgentFlowResult (guard: result.category === 'workflow')
       { outputs: OutputFileSummary[], usage, ... }
                |
                v
     stream.anchor(vscode.Uri.file(output.absolutePath), basename)
     stream.button('View LaTeX diff', 'texra.latexdiff', [inputPath, inputPath, outputPath])  // omitted when outputPath === inputPath
     stream.markdown('+N lines, −M lines')
                |
                v
     return ChatResult {
       metadata: { inputFile, outputFiles: [outputPath], agentName }
     }
                |
                v
     ChatFollowupProvider.provideFollowups(result, context, token)
     → [ { prompt: '@texra /grammar #file:intro.tex', label: 'Check grammar', title: 'Check grammar' }, ... ]
```

### Key Interface: `ChatStreamAgentRuntimeHost`

```typescript
// packages/extension/src/commands/chat/ChatStreamAgentRuntimeHost.ts
import type * as vscode from 'vscode';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventContract';

export class ChatStreamAgentRuntimeHost implements AgentRuntimeHost {
  constructor(private readonly stream: vscode.ChatResponseStream) {}

  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    switch (event) {
      case 'setActiveStream':
        // no-op: stream.progress('TeXRA agent started') was already called in
        // Step 7 before runAgent() to satisfy US-6's 500 ms deadline.
        break;
      case 'updateStreamStatus': {
        const s = payload as ProgressEventPayloads['updateStreamStatus'];
        if (s.status === 'initializing') {
          this.stream.progress('Initializing model handler...');
        } else if (s.status === 'running') {
          this.stream.progress('Agent running...');
        } else if (s.terminalStatus === 'completed') {
          // no-op: Step 10 in the handler emits anchors/diff-buttons/summaries
          // after runAgent() resolves, where result.outputs is available.
        } else if (s.terminalStatus === 'error') {
          // no-op: error already surfaced via requestShowError above
        } else if (s.terminalStatus === 'interrupted') {
          this.stream.markdown('Agent cancelled.');
        }
        break;
      }
      case 'requestShowError': {
        // Launch failures (AgentLaunchContext) and terminal result errors route
        // here, not through updateStreamStatus terminalStatus='error'.
        const e = payload as ProgressEventPayloads['requestShowError'];
        this.stream.markdown(`**Error:** ${e.message}`);
        break;
      }
      case 'addOutputFiles':
        // no-op: Step 10 reads output paths directly from result.outputs.
        break;
      case 'requestEnsureProgressView':
        this.stream.button({
          title: 'View live progress',
          command: 'texra.showProgressView',
          arguments: [],
        });
        break;
      default:
        // All approval events (showToolEditPermission, showBashPermission,
        // showPlanApproval, showAgentProposal, showRetryRequest) are no-ops.
        // approvalPromptsUnavailable: true prevents their emission upstream.
        // Frontend-bound ignorable events (requestOpenFile, requestShowInstruction,
        // showAgentConfigBanner, *SubscriptionsChanged,
        // toolAvailabilityChanged) are also no-ops here.
        break;
    }
  }
}
```

This class lives in `packages/extension/src/commands/chat/` (the VS Code-allowed zone). It may import `vscode` types. It imports `AgentRuntimeHost` from `@agent/runtime/AgentRuntimeHost` and uses `ProgressEventPayloads` from `@eventBus/ProgressEventContract` as a type only — no runtime import of the event bus itself.

### `buildChatAgentConfig` Utility

```typescript
// packages/extension/src/commands/chat/buildChatAgentConfig.ts
import { validateExecutionRequest } from '@agent/core/execution/executionRequests';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfigInput } from '@agent/core/definition/AgentConfig';
import type { ValidatedExecutionRequest } from '@agent/core/execution/executionRequests';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

export interface ChatAgentConfigInput {
  filePath: string; // absolute path from #file: reference
  agentName: string; // resolved from CHAT_COMMAND_TO_AGENT or DEFAULT_CHAT_AGENT
  instruction: string; // stripped prompt text
  modelId: string; // from platform().globalState or DEFAULT_AGENT_MODEL fallback
  workspaceRoot: string; // vscode.workspace.workspaceFolders[0].uri.fsPath
}

export type ChatAgentConfigResult =
  | { valid: true; request: ValidatedExecutionRequest }
  | { valid: false; message: string };

export function buildChatAgentConfig(
  input: ChatAgentConfigInput,
): ChatAgentConfigResult {
  const configInput: AgentConfigInput = {
    inputFiles: [input.filePath],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFiles: [],
    agent: input.agentName,
    model: input.modelId,
    instruction: input.instruction,
    agentCategory: AgentCategory.Workflow,
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: input.workspaceRoot,
  };
  const result = validateExecutionRequest({ config: configInput });
  if (!result.valid) {
    return { valid: false, message: result.message };
  }
  return { valid: true, request: result.request };
}
```

This function is shared between `TexraChatParticipant` and `runFromChatPromptCommand`, ensuring both entry points produce identical `AgentConfig` objects for the same logical request.

---

## API Limitations and Mitigations

### Blocker 1 (CRITICAL): File context assembly via chat text alone

**Problem.** `AgentConfig` requires `inputFiles[]` as absolute workspace paths, and `AgentConfigSchema.superRefine` enforces that `outputFiles.length <= inputFiles.length`. TeXRA's typical usage involves 3–10 LaTeX files. The chat API delivers file references only via `ChatPromptReference.value` typed as `string | vscode.Uri | vscode.Location | unknown`, with no native multi-file picker.

**Mitigation (v1 — implemented).** Restrict to single-file mode. Parse `request.references` for entries whose `.value` is a `vscode.Uri` or `vscode.Location`. Extract `uri.fsPath` and validate it is under a workspace folder. Only the first qualifying file is used as `inputFiles[0]`; if additional qualifying files are present, emit a markdown warning: "Multi-file workflows require the TeXRA panel — only [first-filename] will be used." This covers the primary academic use case of proofreading or reformulating a single `.tex` file.

**v2 path.** Extend to accept multiple `#file:` references, populating `inputFiles[]`. No VS Code API changes needed; only the handler parsing logic changes.

### Blocker 2 (CRITICAL): Approval prompt loop is unresolvable in the chat stream

**Problem.** ToolUse agents emit `showToolEditPermission`, `showBashPermission`, and `showPlanApproval` events managed by `ApprovalRequestHandler` (in `packages/extension/src/progressView/managers/ApprovalRequestHandler.ts`) which holds pending approvals in memory and routes them through the `ProgressViewProvider` webview. `ChatResponseStream` has no mechanism to pause mid-stream and await user input; the handler must return a single `Promise<vscode.ChatResult | void>`.

**Mitigation (v1 — implemented).** Restrict the chat participant exclusively to `agentCategory: 'Workflow'` agents with `rounds: 1`. Set `approvalPromptsUnavailable: true` in `RunAgentOptions` — this flag is confirmed wired through `executeAgent.ts:403` into `RunContext.approvalPromptsUnavailable` (`RunContext.ts:57`) and consumed in tool resolution at `agentToolResolution.ts:134`. At config-build time, validate the resolved agent YAML satisfies both constraints; if not, respond with: "The agent `[name]` requires the TeXRA panel for interactive approval or multi-round workflows." and a "Open TeXRA" button invoking `texra.showMainView`.

**v2 path.** ToolUse agents could map each tool approval event to a new chat turn: the handler suspends after emitting a question, the user replies "approve" or "reject" in the next turn, and a `ChatResult.metadata.pendingApprovalId` is used to resume. This requires significant work in `runToolUseFlow` to accept external signals per-tool-call and is architecturally feasible but not in scope for v1.

### Blocker 3 (CRITICAL): TeXRA model handlers vs. Copilot model

**Problem.** `request.model` is a `vscode.LanguageModelChat` backed by GitHub Copilot. It is unrelated to TeXRA's `IModelHandler` interface. Using it would bypass TeXRA's reflection flow, XML output parsing, LaTeX diff, and usage tracking. Conversely, calling TeXRA's `runAgent()` with TeXRA's own model handlers ignores `request.model` entirely, but still requires Copilot to be installed for the `@texra` mention surface.

**Mitigation (v1 — implemented).** Never call `request.model.sendRequest()` or `vscode.lm.selectChatModels()`. The participant calls `runAgent()` exclusively, which routes to `ModelFactory.createModelHandler()` using TeXRA-configured credentials from `platform().secrets`. The participant uses `vscode.chat.createChatParticipant()` only for the `@mention` surface. This is documented explicitly in the `description` field in `package.json`: "No Copilot model is used — TeXRA uses your configured API keys."

**v2 path.** An `IModelHandler` adapter wrapping `vscode.LanguageModelChat` could allow Copilot models to be used as a TeXRA provider, eliminating the API key requirement for Copilot users. This requires implementing the full `IModelHandler` interface against the `vscode.lm` API and is deferred.

### Blocker 4 (CRITICAL): GitHub Copilot subscription gating

**Problem.** `vscode.chat` is `undefined` when Copilot is absent. TeXRA's primary user base is academic researchers who authenticate via Supabase or bring their own Anthropic/OpenAI keys — no Copilot subscription required. The `@mention` surface is unavailable to these users.

**Mitigation (v1 — implemented).** Two parts: (a) Guard participant registration with `typeof vscode.chat !== 'undefined' && typeof vscode.chat.createChatParticipant === 'function'`; fail silently when Copilot is absent. (b) Register `texra.runFromChatPrompt` unconditionally. This command uses `vscode.window.showQuickPick()` for agent selection, `vscode.window.showInputBox()` for instruction, and `vscode.window.activeTextEditor?.document.uri.fsPath` as the default input file — all standard VS Code APIs with no Copilot dependency. Both paths call the same `buildChatAgentConfig()` and `runAgent()`.

**No future path to eliminate this constraint.** `vscode.chat.createChatParticipant()` is a Copilot extension point. There is no API-key-only fallback for the `@mention` surface itself. `texra.runFromChatPrompt` is the permanent fallback for non-Copilot users.

### Risk (MAJOR): Output model mismatch — LaTeX file writes vs. chat text

**Problem.** TeXRA Workflow agents write LaTeX file edits by parsing structured XML output via `XmlOutputManager`. The output is written to disk. `ChatResponseStream.markdown()` can only stream text into the chat panel; it cannot write files or open diff views directly.

**Mitigation (implemented).** Write files via the existing agent pipeline (unchanged). After completion, emit `stream.anchor(vscode.Uri.file(output.absolutePath), basename)` for each output file; when `outputPath !== inputPath`, also emit `stream.button({ title: 'View LaTeX diff', command: 'texra.latexdiff', arguments: [inputPath, inputPath, outputPath] })` (three-argument form: `inputFile`, `baseFile`, `editedFile`). For in-place writes (`outputPath === inputPath`), the diff button is omitted — a pre-run warning already notifies the user. Emit a line-count summary from `OutputFileSummary.added` / `.removed`. The full diff view requires one user click and uses the existing `texra.latexdiff` command, already registered in `packages/extension/src/commands/latex/latexdiffCommands.ts` (line 145). No new diff infrastructure is needed.

### Risk (MAJOR): Long-running agents exceed chat handler UX expectations

**Problem.** The `rounds: 1` Workflow agents that are eligible for v1 may still take 30–120 seconds on long documents. The chat panel shows a spinner for the entire duration. `CancellationToken.isCancellationRequested` may fire if the user navigates away.

**Mitigation (implemented).** Emit `stream.progress()` and the "View live progress" button within 500 ms of handler entry (before `runAgent()` begins). Wire `token.onCancellationRequested` to abort the agent run (see Open Question 5 for the exact mechanism). Enforce the `rounds: 1` constraint to bound execution time.

### Risk (MAJOR): Progress board cannot be surfaced in chat

**Problem.** TeXRA's `ProgressViewProvider` renders `StreamTabs`, `TodoList`, `PlanView`, `UsagePanel`, `ApprovalPanels`, and `LogList` as a dedicated VS Code webview. `ChatResponseStream` has no webview embedding.

**Mitigation (implemented).** Emit `stream.button({ title: 'View live progress', command: 'texra.showProgressView', arguments: [] })` within 500 ms of handler entry. The user can click it at any time to open the full progress board in a side panel. In-stream output is limited to `stream.progress()` text and the post-run anchor/diff-button/summary. This is a known UX step-down; the user must explicitly click to see the full board.

### Risk (MAJOR): VS Code Chat history model does not map to TeXRA session state

**Problem.** `context.history` contains only serialisable `vscode.ChatResponseMarkdownPart[]` content — no stream IDs, no `executionId`, no `ToolUseSessionSnapshot`. TeXRA's ToolUse resume path (`resumeToolUseFromSnapshot()`) cannot be exercised from chat history.

**Mitigation (v1 — by exclusion).** ToolUse agents and multi-round Workflow agents are excluded from v1. For `rounds: 1` Workflow agents, there is no resume path to expose. `ChatResult.metadata` stores `{ inputFile, outputFiles, agentName }` for `ChatFollowupProvider` use only — not for session resume. This risk is fully mitigated in v1 by the agent scope restriction.

### Risk (MINOR): Manifest / publishing compliance overhead

**Problem.** Extensions using the Chat Participant API must comply with Microsoft AI tools guidelines and GitHub Copilot extensibility policy before Marketplace submission.

**Mitigation.** Phase 5 includes a dedicated non-code compliance review deliverable. VSIX build and Marketplace submission are gated on completion of that review.

### Risk (MINOR): Token budget contention with Copilot models

Not applicable to v1 (TeXRA's own model handlers handle token budgeting). Deferred to any future v2 `IModelHandler` wrapping `vscode.LanguageModelChat`.

---

## Out-of-Scope for v1

- ToolUse agents (`agentCategory: 'ToolUse'`) of any kind.
- Multi-file workflows (more than one `#file:` reference used as input).
- Multi-round Workflow agents (`rounds > 1`). Note: `rounds` defaults to `2` in `AgentDataclass` — agents must explicitly declare `rounds: 1` in their YAML to be eligible.
- Using `request.model`, `vscode.lm.selectChatModels()`, or any `vscode.lm.*` API for the AI call.
- Registering VS Code Language Model Tools via `vscode.lm.registerTool()`.
- Embedding a webview inside the chat stream (not possible with the `ChatResponseStream` API).
- Resuming interrupted agent sessions across chat turns via `ChatResult.metadata`.
- The `#selection` reference as implicit input.
- Server-side relay key (Supabase-gated) API pathway — assumed to work transparently through existing `platform().secrets`, not explicitly tested.
- Disambiguation auto-routing by Copilot — present in manifest but non-contractual.
- Internationalization of participant description strings and command descriptions.
- Publishing compliance review with Microsoft AI guidelines — required before Marketplace submission, not a code deliverable.
- A user-facing model picker in the chat participant. Model is resolved from persisted main view state; if the user has never set a model in TeXRA, `DEFAULT_AGENT_MODEL` is used silently.

---

## Success Metrics

### Adoption

- Number of `@texra` invocations per day (tracked by adding a `chatParticipantInvoked` event via the existing `src/telemetry/` infrastructure).
- Ratio of successful completions (`WorkflowFlowResult.category === 'workflow'`) to total invocations. Target: >80% success rate at steady state.
- Number of "View LaTeX diff" button clicks relative to total completions. Target: >50% click-through.
- `texra.runFromChatPrompt` invocations as a fraction of all chat-style invocations (participant + command palette). Measures Copilot gate impact.

### Performance

- P50 and P95 latency from `ChatRequest` receipt to `ChatResult` return, for `rounds: 1` Workflow agents on files under 10,000 words. Target: P50 < 30 s, P95 < 90 s (bounded by model response time).
- Time from handler invocation to first `stream.progress()` call. Target: < 500 ms.

### Quality

- Rate of "no file attached" errors (US-8) declining over the first month. Target: < 10% of invocations after week 2.
- Follow-up engagement: fraction of sessions where the user clicks a suggested `ChatFollowup`. Target: > 20%.

---

## Implementation Phases

### Phase 1: Foundation and Fallback Command (1 week)

**Deliverables:**

- `packages/extension/src/commands/chat/agentCommandMap.ts` — initial map containing only `proofread: 'correct'` (the only confirmed `rounds: 1` Workflow agent at audit start). Remaining entries added after Open Question 1 audit completes.
- `packages/extension/src/commands/chat/buildChatAgentConfig.ts` — shared config construction calling `validateExecutionRequest()`.
- `packages/extension/src/commands/chat/runFromChatPromptCommand.ts` — `texra.runFromChatPrompt` command using `vscode.window.showQuickPick()` + `vscode.window.showInputBox()`, calling `buildChatAgentConfig()` and `runAgent()`.
- Registration of `texra.runFromChatPrompt` in `packages/extension/src/commands.ts` and `packages/extension/src/extension.ts` (unconditional).
- `package.json`: new command entry for `texra.runFromChatPrompt`; new `texra.chatParticipant.enabled` configuration property.
- Unit tests for `buildChatAgentConfig()` covering: valid inputs, missing file path, unknown agent name, empty instruction, and `validateExecutionRequest` failure (e.g., `outputFiles.length > inputFiles.length`).

**Dependencies:** None. This phase does not touch the chat participant API and works for all users regardless of Copilot status.

### Phase 2: `ChatStreamAgentRuntimeHost` (3 days)

**Deliverables:**

- `packages/extension/src/commands/chat/ChatStreamAgentRuntimeHost.ts` implementing `AgentRuntimeHost`.
- Maps lifecycle events (`setActiveStream`, `updateStreamStatus` `status === 'initializing'`/`'running'` and `terminalStatus === 'completed'`/`'error'`/`'interrupted'`, `addOutputFiles`, `requestEnsureProgressView`) to `vscode.ChatResponseStream` calls per the table in "Streaming Response Through `ChatResponseStream`".
- All approval events and frontend-bound ignorable events are explicit no-op cases in the `switch` statement with comments explaining why.
- Unit tests using a mock `vscode.ChatResponseStream` (interface-compatible stub) verifying the correct `progress()`, `button()`, and `markdown()` calls for each mapped event type.
- Verification that the class satisfies the `AgentRuntimeHost` contract by importing `noopAgentRuntimeHost` from `src/agent/runtime/AgentRuntimeHost.ts` and asserting structural compatibility in a compile-time `satisfies` check.

**Dependencies:** Phase 1 complete. Requires reading `src/agent/runtime/AgentRuntimeHost.ts` (for the interface) and `src/eventBus/ProgressEventContract.ts` (for `ProgressEventPayloads` type map and `addOutputFiles.filesByRound` shape).

### Phase 3: Chat Participant Registration and Handler (1 week)

**Deliverables:**

- `packages/extension/src/commands/chat/TexraChatParticipant.ts` — main handler class implementing the 10-step `ChatRequest` processing described in "How the Handler Parses `ChatRequest`". Includes: `vscode.Uri` / `vscode.Location` reference resolution, workspace null guard (if `workspaceFolders` is `undefined` or empty, return error), agent YAML validation (`agentCategory === AgentCategory.Workflow && rounds === 1`), instruction text extraction using `request.references[i].range`, `stream.button('View live progress')` emission within 500 ms, `ChatStreamAgentRuntimeHost` instantiation, and post-run anchor/button/summary emission.
- `packages/extension/src/commands/chat/chatFollowupProvider.ts` implementing `vscode.ChatFollowupProvider`. Returns an empty array when `result.errorDetails` is set; returns 2–3 follow-up prompts with `inputFile` from `result.metadata` re-attached when successful.
- Guarded participant registration in `packages/extension/src/extension.ts` (feature flag check + `typeof vscode.chat` guard).
- `packages/extension/package.json` manifest update: `contributes.chatParticipants` entry with all fields from "Chat Participant Registration".
- Integration test: instantiate `TexraChatParticipant` with a mock `vscode.ChatRequest` containing a `vscode.Uri` reference, a mock `vscode.ChatResponseStream`, and a stub `runAgent()` that resolves immediately with a minimal `WorkflowFlowResult`. Verify the mock stream receives `progress()` within 500 ms and `button()` with `texra.latexdiff` after `runAgent()` resolves.

**Dependencies:** Phases 1 and 2 complete. VS Code `^1.105.0` already satisfies the `ChatResponseStream.anchor()` requirement (available since 1.95).

### Phase 4: Hardening and Edge Cases (4 days)

**Deliverables:**

- String-typed reference handling: when `ChatPromptReference.value` is a `string`, emit the "not recognized as a file" error and return without calling `runAgent()`.
- Agent validation at config-build time: reject agents where `agentCategory !== AgentCategory.Workflow` (value: `'workflow'`) or `rounds !== 1` with the "requires TeXRA panel" message and "Open TeXRA" button invoking `texra.showMainView` (opens the main agent interaction view, not the progress board).
- Cancellation wiring: `token.onCancellationRequested` wired to the abort mechanism in `RunAgentOptions` (implementation depends on resolution of Open Question 5; if `AbortSignal` is not yet in `RunAgentOptions`, wire to `handle.childStreamId` captured in `RunAgentOptions.onRun`, then call `interruptRegistry.get(handle.childStreamId)?.interrupt()` when the cancellation token fires (`src/agent/runtime/InterruptRegistry.ts`)).
- In-place write warning: if the agent YAML's `defaultOutputFiles` resolves to the same path as `inputFiles[0]`, emit a pre-run markdown note.
- Telemetry: `chatParticipantInvoked`, `chatParticipantCompleted`, `chatParticipantFailed`, `chatParticipantCancelled` events added to `src/telemetry/`.
- CHAT_COMMAND_TO_AGENT map finalized after Open Question 1 audit. `package.json` chat commands updated to match.
- Documentation: add `@texra` participant to the TeXRA README; update the extension's `package.json` `description` field.
- Manual end-to-end test on VS Code with Copilot active: `@texra /proofread #file:<real-.tex-file>` → agent runs → diff button works.

**Dependencies:** Phase 3 complete. Open Question 1 audit must complete before final agent map is added.

### Phase 5: Publishing Compliance and Release (1 week)

**Deliverables:**

- Legal/policy review of Microsoft AI tools guidelines and GitHub Copilot extensibility acceptable development policy. Non-code deliverable requiring human review. VSIX submission is gated on this.
- `CHANGELOG.md` updated with user-facing description of the `@texra` participant.
- VSIX build via `npm run build:fast`, smoke test the packaged extension with and without Copilot installed.
- Verify `texra.runFromChatPrompt` works end-to-end in a VS Code instance with no Copilot extension installed.
- GitHub release and `vsce publish` / `ovsx publish` following the existing release process in `CLAUDE.md`.

**Dependencies:** Phase 4 complete. Compliance review must complete before Marketplace submission.

---

## Open Questions

1. **Which agent YAMLs satisfy the `rounds: 1, agentCategory: workflow` constraint for v1?**
   The `CHAT_COMMAND_TO_AGENT` map in Phase 1 initially contains only `proofread: 'correct'` (the only confirmed eligible agent at the time of writing — `correct.yaml` has both `agentCategory: workflow` and `rounds: 1`). The other root-level agents (`merge.yaml` has `rounds: 1` but its single-file suitability is unclear; `polish.yaml`, `ocr.yaml`, `transcribe_audio.yaml` do not declare `rounds: 1` and default to `rounds: 2`). Before Phase 3, all agent YAMLs in `packages/extension/resources/agents/` (including subdirectories) must be audited. The `package.json` chat commands must reflect only the agents that pass the filter. **Owner: whoever writes the final `agentCommandMap.ts`; action required before Phase 3 is merged.**

2. **What is the exact state key for the persisted model ID?**
   The participant needs a model ID from `platform().globalState`. Automated review identified that the main webview's selected model lives in `MainViewPersistedState.model` (defined in `src/shared/schemas/mainView/state.ts`), which is managed via the webview's pending state store (`packages/extension/src/webview/frontend/store.ts`) — not directly in `platform().globalState`. The specific `globalState` key used to persist this value (if any) was not confirmed during research. **Owner: check whether `MainViewPersistedState` is ever serialized to `platform().globalState`, or whether the participant should read the key differently. If no suitable `globalState` key exists, the participant will hard-code `DEFAULT_AGENT_MODEL` for v1 and document this as a known limitation.**

3. **Should output be written in-place or to a sibling file in chat mode?**
   Edit agents like `correct` (no `defaultOutputFiles`) always overwrite the input file — this is already settled for Phase 1 (`/proofread`). For Phase 2+ agents that declare a different `defaultOutputFiles` path, no in-place overwrite occurs and the question does not apply. The open decision is whether to add a chat-mode override specifically for edit agents (writing to `<basename>-texra.<ext>` instead of overwriting the original). Such an override would need to intercept the output path at the `XmlOutputManager` level rather than via `defaultOutputFiles` (which `correct` does not use). **Owner: UX decision by TeXRA maintainers before Phase 3 is complete.**

4. **How does `runAgent()` behave when `workingDirectory` is `undefined`?**
   If the user runs `texra.runFromChatPrompt` with no workspace folder open, `vscode.workspace.workspaceFolders` is `undefined`. A workspace guard must ship in Phase 1 alongside `runFromChatPrompt` — deferring it to Phase 4 would leave Phase 1 callable without an open workspace, passing `workingDirectory: undefined` to `runAgent()`. However, the behaviour of `runAgent()` with `workingDirectory: undefined` (which `AgentConfigSchema` marks as `z.string().nullish()`) is not explicitly documented. **Owner: test `runAgent()` with `workingDirectory: null` in a unit test and document the result before Phase 4 ships.**

5. **Is cancellation via `AbortController` available in `RunAgentOptions`?**
   The handler needs to wire `token.onCancellationRequested` to abort the in-flight `runAgent()` call. Inspection of `RunAgentOptions` shows no `signal` or `AbortController` field. The interrupt mechanism lives in `InterruptRegistry` (`src/agent/runtime/InterruptRegistry.ts`), keyed by `StreamTabId`. The `RunAgentOptions.onRun` callback receives an `AgentRunHandle` with a `childStreamId`; the handler stores `handle.childStreamId` on receipt and calls `interruptRegistry.get(storedStreamId)?.interrupt()` when the cancellation token fires. Note: `AgentRunHandle` (defined as a `Pick<>` at `ExecutionHandle.ts:144`) has no `interrupt()` method — interruption must go through the registry. **Owner: confirm `interruptRegistry` is accessible from the extension host before Phase 3 is complete.**

6. **Is `merge.yaml` suitable for single-file chat mode?**
   `merge.yaml` has `agentCategory: workflow, rounds: 1` and appears in the root agents directory. However, "merge" semantically implies combining multiple files, which conflicts with the single-file v1 constraint. **Owner: review `merge.yaml` content before adding it to `CHAT_COMMAND_TO_AGENT`. If it requires multiple input files to function, exclude it from v1.**

7. **Should `texra.runFromChatPrompt` pre-fill the input file from the active editor?**
   When the user invokes the command with a `.tex` file open, automatically using `vscode.window.activeTextEditor.document.uri.fsPath` as the default reduces friction but may surprise users who intended to pick a different file. The recommended approach is to offer the active editor file as the first `QuickPick` option with a "(current file)" label, followed by a "Browse..." option. **Owner: UX decision; implement in Phase 1.**
