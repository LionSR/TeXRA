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

Taken on 2026-11-16: the merge program reads `editedFile` from its `args`,
`document_context` takes it as input, and `run.config` is at v9 without it.

## 5. The run list is built twice

Taken on 2026-11-17: `runListSections` (`packages/texra/src/ui/copy/runStatus.ts`)
groups and `runExpanded` (`packages/texra/src/shared/session/surface.ts`)
decides expansion for the web tab strip and the TUI tree.

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

Checked on 2026-11-16 and left: translating in `buildClaudeToolUseLog`
changes more than the classifier. `Read`, `Write` and `Bash` rows would gain
the harness's file and shell treatments, the row header would read the
harness name (`edit_file`) where it reads Claude's (`Edit`), and the
translation (`CLAUDE_TOOLS`' `back` in `hookConfig.ts`) would become a
public export of the plugins entry. The `claude-agent` plugin still
registers an icon for `str_replace_editor`, so that branch's producer is a
question for the plugin, not dead code yet. Needs the decision on how a
delegated Claude Code call is labelled.

## 10. The terminal title restates `sessionActivity` (found 2026-11-17)

`packages/cli/src/chat/tui/terminalTitle.ts` computes approval over
`attentionRequests` (this terminal's runs, plugin requests dropped) and
running over `rootRunIds` plus a launch in flight, where
`sessionActivity` (`packages/harness/src/shared/session/sessionView.ts`)
reads the whole view. A detached child working in the background leaves the
terminal title idle. Folding it into `sessionActivity` needs that function to
take a run scope and a pending-launch fact, or the TUI to bind a narrowed
view; and a plugin request the TUI cannot show would turn its title to
approval. Needs the decision on scope.

## 11. The status bar's task cost is a bare amount (found 2026-11-17)

`taskCostSegment` (`packages/cli/src/chat/tui/panes/statusBarDisplay.ts`)
prints `formatCostUsd`, while `/status` reads `usageCostLabel` ("$x via
…"). The bar shows the access mode in its own segment, so whether the cost
segment should carry the route too is a narrow-terminal layout decision.

## 12. Two tone drifts between web and terminal (found 2026-11-17)

- A run grant: the terminal paints `superYolo` in its error colour
  (`statusBarDisplay.ts`), the web's `runGrantChips.ts` every grant as a
  warning.
- A user-feedback rejection: the terminal's `toolRenderers.tsx` paints any
  `isError` row `danger`; the web's `toolFormatters.ts` excludes
  `isUserFeedback`. The row model (`toolRowModel`) could carry the tone.

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
