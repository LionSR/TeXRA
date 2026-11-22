# Logic in the wrong layer: what the 2026-11-22 audit left open

Date: 2026-11-22
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`0d72e15`. It took the open items of
[the 2026-11-21 layer note](2026-11-21-layer-audit-left-open.md) first, then
one read-only sweep of the hosts and renderers for provider facts, app rules
and run facts decided outside their owner. Each candidate was checked against
the code, `.agents/docs/refuted-candidates.json`, the open PRs (#15163,
#15165) and the other notes in this directory.

The PR that adds this note lands six findings:

- llm states each key provider's key shapes (`API_KEY_SHAPES`,
  `API_KEY_PATTERN_SOURCE`); the harness log redactor, the TUI's
  concatenated-credential check and the live-cassette leak check read them
  (2026-11-21 item 1).
- The TUI follows `credentialChanged` / `modelAccessChanged` to connect a
  waiting chat (`followModelConnection`) instead of an `onAccountChanged`
  callback three forms called by hand; a key saved in `/config` or a
  settings view now connects it too (2026-11-21 item 3).
- "Can the Codex CLI run this model" is llm's `isCodexModel`, over the same
  `codexSubscriptionOf` the ChatGPT route reads (2026-11-21 item 6).
- The terminal's start model (`CLI_CHEAP_START_MODEL`) sits beside the app's
  other pinned model ids (`packages/texra/src/model/curatedModels.ts`), so
  the pinned-model check fails an llm-zoo bump that retires it.
- Each subscription's connect row is worded once (`connect` in
  `CHATGPT_AUTH` / `GROK_AUTH`, `packages/texra/src/ui/copy/accountAuth.ts`);
  the terminal's connect panel no longer writes its own Grok row.
- The sign-in prompts' buttons, the link-copied message and the
  device-code fallback reason are `SIGN_IN_PROMPT` entries; the desktop and
  VS Code no longer label the same button two ways.

What follows is left open, in the order worth taking.

## 1. Each renderer counts a run's children its own way

`rollupOf` (`packages/harness/src/shared/session/sessionViewUpdate.ts`) counts
every descendant, a script's calls included. The web's background-task card
(`packages/texra/src/ui/progress/components/BackgroundTasksPanel.ts`)
rebuilds the tree over `dispatchedChildren`, which leaves a script's calls to
its stage, and computes its own rollup, earliest start and approval. The
terminal's status bar and child list read `run.rollup` and `run.childIds`,
and `/status` lists per-agent cost over `childIds`, so a script's calls show
there as agents. The same run reads two counts. The owner is the session
view: a dispatched-children rollup on `RunView` built with
`dispatchedChildren` (`packages/harness/src/shared/transcript/scriptStage.ts`).
Decision needed: whether the terminal should stop counting a script's calls,
which changes what its status bar says.

## 2. A finished-tool-call count only a subscribed run has

`finishedToolCalls` (`packages/cli/src/runtime/headless/runProgressRenderer.ts`)
counts tool cards in a run's transcript, which the view holds only while some
port subscribes the run; the TUI's child list borrows it. The run state
already counts the calls (`RunFacts.toolCalls`,
`packages/harness/src/shared/session/runFacts.ts`), but `RunView` does not
carry it. Carrying it would let both terminal sinks read the count without a
subscription, and word it once ("tools: 5" against "5 tool calls").

## 3. A harness setting title contradicts the app's switch naming

`XAI_PREFER_SUBSCRIPTION_SETTING` (`packages/harness/src/shared/state/stateSettings.ts`)
is titled "Prefer the Grok subscription" and repeats the OAuth-client caveat
the settings section states (`SubscriptionSection.ts`). `accountAuth.ts`
rules that the switch is named by the subscription, never by "Prefer",
because the switch selects a credential and falls back to nothing. The
harness cannot read the app's copy, so the fix is the row's own wording, and
the caveat belongs to one of the two.

## 4. The GitHub Action template lists provider key names by hand

`packages/cli/src/commands/installGithubAction.ts` writes five `*_API_KEY`
secret names and names `DEEPSEEK_API_KEY` again in its PR text; llm owns the
names (`apiKeyEnvName`). Left because the action's accepted inputs are
defined in the action's own repository, which this audit could not check.

## Checked and left alone

- **The CLI's start model value.** Its value differs from the launcher's
  default by an earlier ruling (a cheap first model for the terminal); this
  PR moves where it is declared, not what it is.
- **Each host's sign-in title and waiting line.** A modal title and
  "waiting" wording follow the host's dialog shape, as `SIGN_IN_PROMPT`
  states.
