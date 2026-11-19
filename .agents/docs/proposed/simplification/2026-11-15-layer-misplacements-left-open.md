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

Taken in part on 2026-11-18: `transcribeAudio` in `@texra-ai/llm/node`
(`packages/llm/src/api/openaiTranscription.ts`) owns the client and the
model id, and the app no longer depends on `openai`. Still open: to get a
key, `packages/texra/src/controllers/session/hostDraftRequests.ts` asks for
the own-key route of a pinned chat model it never calls. Decision needed:
what the harness exposes as "the credential for transcription" (a route of
its own, or the OpenAI own-key route by provider).
The transcription credential is open question 3 of
[a subscription is a credential](../feature/2026-11-17-subscriptions-as-credentials.md).

## 2. The harness asks "is this Anthropic?" to choose prompt text

Taken on 2026-11-19: `issuesParallelToolCalls` (`packages/llm/src/models/modelRoute.ts`)
states the fact the step's tool-call paragraph depends on, and the
`IS_ANTHROPIC_MODEL` prompt variable is gone with no alias.

## 3. Provider usage endpoints live in app controllers

Taken on 2026-11-18: `fetchPlanUsage` (`packages/llm/src/providers/planUsage.ts`)
asks the Kimi Code and GLM quota endpoints, the GLM one on its region's host
from `GLM_BASE_URLS`; the app keeps the cache and the snapshot
(`SubscriptionUsageService.ts`).

## 4. The merge feature's edited file is a harness launch field

Taken on 2026-11-16: the merge program reads `editedFile` from its `args`,
`document_context` takes it as input, and `run.config` is at v9 without it.

## 5. The run list is built twice

Taken on 2026-11-17: `runListSections` (`packages/texra/src/ui/copy/runStatus.ts`)
groups and `runExpanded` (`packages/texra/src/shared/session/surface.ts`)
decides expansion for the web tab strip and the TUI tree.

## 6. Web components replace the status word `runStatus` decides

`RunHeader.ts` shows "Ready" for a finished run that accepts a follow-up;
the terminal paints `runStatus(run).word`. The same run reads "Ready" in the
web header and "Completed" in the web tab and the terminal. Either the
reading becomes a key in `packages/texra/src/shared/session/runStatusKey.ts`,
or the override goes. Decision needed: which word is right.

Taken on 2026-11-18 for the tab: a request under the run reads in the status
table's word for that state, "Waiting on you", not a second "Needs approval".

## 7. An open call on an interrupted run reads differently per host

The time limit half is taken (`toolRowModel` carries `timeoutMs`).
"An open call on an interrupted run is not running" is computed in
`StageList.ts` and `toolFormatters.ts`; the terminal's `toolRenderers.tsx`
has no such case and keeps painting the call as running. The row model can
carry it beside `cutByRunEnd`, which changes the transcript entry's API
report.

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
