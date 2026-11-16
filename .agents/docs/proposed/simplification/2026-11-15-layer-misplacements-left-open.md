# Logic in the wrong layer: what the 2026-11-15 audit left open

Date: 2026-11-15
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`1dd278b`. Three read-only passes covered rules written per host, domain logic
in renderers, and misplacement between `packages/llm`, the harness and the app.
Each candidate was checked against `.agents/docs/refuted-candidates.json` and
the other notes in this directory.

The same PR implements the findings that fit a reviewable diff: the window's
opening answers the missing-agent notice and selects the setup agent, the
file-actions controller words its accept confirmation, a model-access write
announces itself, a team that cannot launch carries one message, one function
names a run on screen, and the terminal paints tones from `TONE_PAINT`. What
follows is what it left, in the order worth taking. Every item needs a
decision or changes a public or stored shape, which is why it is a note and
not a commit.

## 1. Audio transcription calls the OpenAI SDK from the app

`packages/texra/src/controllers/session/audio.ts` imports `openai`, builds its own
client and names the model (`gpt-4o-transcribe`). To get a key,
`packages/texra/src/controllers/session/hostDraftRequests.ts` asks for the
route of a pinned chat model it never calls. It is the only provider SDK
import outside `packages/llm`, and the app package carries the `openai`
dependency for it.

```
before  app: ownKeyCredential(roots, MODEL_CONFIGS['openai/gpt-4o-…'])
        app: new OpenAI({ apiKey, baseURL }).audio.transcriptions.create(…)
after   llm: transcribe(audio, credential)      // beside the other OpenAI wire code
        app: transcribe(recording)              // no SDK, no model id, no chat-model lookup
```

Decision needed: what the harness exposes as "the credential for
transcription" (a route of its own, or the OpenAI own-key route by provider).

## 2. The harness asks "is this Anthropic?" to choose prompt text

`packages/harness/src/agent/runtime/loop/step.ts` and `executeAgent.ts` compare
`model.config.provider` with `ModelProvider.ANTHROPIC`;
`packages/harness/src/agent/prompt/PromptBuilder.ts` picks the tool-call
paragraph from it, `templateInputs.ts` sets `IS_ANTHROPIC_MODEL`, and the
public `PromptSection` context in `packages/harness/src/tools/toolTable.ts`
carries `isAnthropic`. The fact the prompt depends on is whether the model
issues parallel tool calls, which is a capability `packages/llm` should
state. No plugin in `packages/texra` reads `ctx.isAnthropic` and no bundled
agent uses the template variable; the agent-creation docs advertise it.

```
before  isAnthropic: model.config.provider === ModelProvider.ANTHROPIC
after   parallelToolCalls: model.config.capabilities.parallelToolCalls
```

Decision needed: the capability's name on the model config, and whether
`IS_ANTHROPIC_MODEL` is dropped (it breaks a user agent that reads it) or
kept as a derived value for one release. It changes the plugins API report.

## 3. Provider usage endpoints live in app controllers

`packages/texra/src/controllers/modelAccess/subscriptionUsage/` calls the Kimi
and GLM quota endpoints and picks the GLM host by region, which
`packages/llm/src/providers/providerPlugins.ts` already does for the same
plans. The endpoint, the region choice and the response parsing belong beside
the plan routes in `packages/llm`; the app keeps the cache
(`SubscriptionUsageService.ts`) and the presentation. About 470 lines move.
The refuted `G11g-usage-region-out-of-cache-key` is about the cache key, not
this.

## 4. The merge feature's edited file is a harness launch field

`editedFile` on the harness's `AgentConfig`
(`packages/harness/src/shared/schemas/fileFields.ts`) and the `EDITED_*`
template variables (`packages/harness/src/agent/prompt/templateInputs.ts`)
serve one app agent (`packages/extension/resources/agents/merge.yaml`, launched
from `packages/texra/src/controllers/session/hostRunActions.ts`). A plugin may
already render its own variables beside the harness's, so the documents
plugin can own it. `AgentConfig` is stored in run rows, so this is a row
version change.

## 5. The run list is built twice

`packages/texra/src/ui/progress/components/RunTabs.ts` and
`packages/cli/src/chat/tui/state/cliState.ts` each group top-level runs by
`runStatus(run).section` in `RUN_SECTION_ORDER`, apply "expanded when it needs
the user or the surface chose it", and recurse into children. One pure
`runListRows(view, surface, filters)` beside `Surface` in
`packages/texra/src/shared/session/surface.ts` would leave both painting rows.
The copies differ in scope (the terminal lists one session's runs and appends
detached children; the web has search and an active-only filter), so the
function takes those as arguments. About 40 lines.

## 6. Web components replace the status word `runStatus` decides

`RunHeader.ts` shows "Ready" for a finished run that accepts a follow-up and
`RunTab.ts` shows "Needs approval" when a descendant waits; the terminal
paints `runStatus(run).word`. The same run reads "Ready" in the web header
and "Completed" in the web tab and the terminal. Either the two readings
become keys in `packages/texra/src/shared/session/runStatusKey.ts`, or the
overrides go. Decision needed: which word is right.

## 7. A tool call's time limit and its interrupted reading are decided in the web renderer

- `getToolTimeoutMs` in
  `packages/texra/src/ui/progress/formatters/logFormatters/toolFormatters/toolCard.ts`
  keys on tool names and re-reads `timeout`, `run_in_background` and
  `action === 'wait'` from raw input. `toolRowModel`
  (`packages/harness/src/shared/transcript/toolRowModel.ts`) already parses
  the same input into sections and can expose `timeoutMs`.
- "An open call on an interrupted run is not running" is computed in
  `StageList.ts` and `toolFormatters.ts`; the terminal's
  `toolRenderers.tsx` has no such case and keeps painting the call as
  running. The row model can carry it beside `cutByRunEnd`.

Both change the transcript entry's API report.

## 8. Child counts call every descendant an agent

`rollup.total` counts commands and scripts as well as agents, and
`nestedRollupLabel`, `RunTab.ts` and the terminal status bar label the total
"agents"; the dispatch card counts per kind through `NESTED_NOUNS`. A task
that ran three background commands reads "3 agents" in the tab and "3
commands in the background" on the card. The rollup needs a count per
identity kind (it is computed once in the session view update), which is a
view shape change.

## 9. The harness classifies the Claude Code plugin's raw tool names

`packages/harness/src/shared/tools/toolKind.ts` and
`shared/transcript/toolRowSections.ts` special-case `edit`, `multiedit`,
`old_string` and `edits[]`, which only the app's `claude-agent` plugin emits
(`packages/texra/src/tools/agentCli/claudeAgentShared.ts`). The harness holds
the Claude-to-harness tool mapping already
(`packages/harness/src/common/plugins/hookConfig.ts`), unexported. The plugin
should translate when it builds the log, and the classifier keep only the
canonical names. The `str_replace` / `text_editor` branch has no producer in
the repo.

## Checked and left alone

- What a setup launch's outcomes do per GUI host, the settings view's run
  verbs and the rejected-GitHub-token notice were verified here too. #14952's
  note (`2026-11-15-host-rules-and-app-facts-with-two-owners.md`, same
  directory once it merges) records them with the decision each needs, so
  they are not repeated.
- `recoverLogged` (`packages/texra/src/utils/diagnostics/recoverLogged.ts`) is
  generic, but moving it to the harness pays only if harness call sites adopt
  it.
- The CLI's `setModelEnabled` paths (`runtime/models/enabledModels.ts`) emit no
  `modelAccessChanged`. The writer is the harness's
  `packages/harness/src/model/computeModelOptions.ts`; announcing there is the
  same fix as this PR's, one layer down, and changes that function's
  requirements for every caller.
