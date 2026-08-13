# Slash-command output redesign: busy-forms + transientNotice + archival outcome lines

Winner of a 4-proposal / 3-judge design tournament (2026-07-18) on making texra CLI
slash-command output ephemeral. Base: the "archival-first" proposal (unanimous winner,
aggregate 22/23/21), with judge grafts folded in and robustness failure modes resolved.
Scope: `packages/cli/src/chat/tui/` only. Headless (`texra run`, `--print`) untouched
by construction.

## Contract

Three surfaces, one job each:

- **Scrollback** (root `<Static>`) persists only rows with archaeology value: one
  outcome line per real state change, and full dumps only when the user explicitly
  asked to record a snapshot (`/status`, `/auth`).
- **Foreground surface** (`App.tsx` `renderForegroundSurface`) hosts progress and
  reference text: forms gain a submit-side busy phase; help-style dumps get a
  hard-capped InfoPane.
- **Status bar** carries regenerable hints via a `transientNotice` TTL slot
  generalized from the exit-hint pipe.

## 1. Primitives (each with the existing code it extends, verified)

### 1.1 `transientNotice` status-bar slot

`{text: string, resumeId?: string, expiresAt: number} | undefined`, single-slot,
last-writer-wins, producer-armed `setTimeout` TTL.

- **Extends:** `state/cliState.ts:447-453` (`PENDING_EXIT_HINT`/`PENDING_EXIT_RESUME_ID`
  fold into it). Caveat (verified): `pendingExitHint` is a **boolean** with the hint text
  living in `panes/statusBarDisplay.ts:699/759/849`, so this is a small rewrite of that
  path, not a field rename.
- **Consumer pipe unchanged:** `panes/StatusBar.tsx:61-62` reads the signal;
  `statusBarDisplay.ts` keeps its special resume-id layout by reading the structured
  `resumeId?` field (do not fold resume-id into free text).
- **Producer precedent:** `runChatTui.tsx:957-963` `armExit()` TTL pattern; the
  exit-clear at `runChatTui.tsx:879-883` retargets to the new slot.
- **Reset:** cleared in `resetCliState` exactly where `pendingExitHint.set(false)` sits
  today (`cliState.ts:533-534`).
- **Truncation:** notice text truncates against available StatusBar width via the
  existing fitted-segment logic (`statusBarDisplay.ts:849` already implements
  hint-preempts-fitted-left).
- **Policy:** nothing load-bearing routes here. Only regenerable chatter: usage strings
  on parse-fail, unknown-command suggestion, guard refusals ("agent is fixed for this
  session", `handleSlashCommand.ts:118`), the `/key` no-arg safety notice (`:141`),
  picker cancels.

### 1.2 Submit-side busy phase (`completion: 'busy'`) in `formSelectionHandler`

Form stays mounted while the selected action runs; FormFrame renders spinner + a
progress-line slot; input is hard-disabled (no re-submit, no navigation) except Esc.

- **Extends:** `commands/registerBuiltins.tsx:58-86` (`formSelectionHandler`, today
  `'afterAction' | 'beforeAction'`). `'beforeAction'` on Login/Logout/ModelAccess
  adapters exists only because progress had nowhere to render but scrollback; those
  three flip to `'busy'`. `'beforeAction'` stays for Memory/Resume/Skills/Approval
  (instant actions).
- **Chrome:** mirrors `forms/_shared/FormFrame.tsx:67` `renderAsyncListFormTransient`
  (the load-side spinner, wired in `ListForm.tsx:253`), reused for the submit side.
- **Progress feed:** new `formProgress` signal in `cliState.ts` (registered via
  `registerCliStateResetHook`). The three `writeProgress` injection sites retarget to
  it: `handlers/loginCommands.ts:61` (`signInCliChatGpt`), the device-code/auth-url
  callbacks at `loginCommands.ts:83-99`, and `handlers/apiModeCommands.ts:121`
  (`selectCliModelAccessRoute`). `runtime/chatgptLogin.ts` / `supabaseAuth.ts` keep
  their injected-callback contracts, so headless `texra login` stdout is untouched.
- **Copyability:** while a device code or manual URL is displayed, the spinner freezes
  (no repaint churn under mouse selection — selection over a repainting live region
  tears).
- **Hold-open:** if a device code or manual URL was shown, the success/error frame
  stays open until an explicit keypress; otherwise it closes on settle.
- **Generation gating** (mechanism verified at `cliState.ts:507`): the handler captures
  `getCliStateGeneration()` at submit; every progress write, outcome append, and notice
  set is dropped if the generation changed (a `/clear` mid-login can never stamp a
  stale row into the fresh session).
- **Cancellation:** Esc during busy calls an optional `abort()` the action may provide
  (AbortSignal threading into `signInCliSupabase`/`signInCliChatGpt` is a follow-up;
  v1 fallback: detach — close the form, set
  `transientNotice('Sign-in abandoned; the browser flow may still complete')`, and gate
  the orphaned settle on generation + a per-submit token so it writes nothing).

### 1.3 InfoPane foreground kind

Fourth `renderForegroundSurface` case (alongside `form`/`approval`/`taskDetail`,
verified at `App.tsx:416-448` and `appInteractionPolicy.ts:143-156`). Stateless
`{title, lines, availableRows}` renderer; active pane in a `cliState.ts` signal
registered in the reset-hook set.

- **Hard caps (the anti-pager rule):** Esc-only dismiss, viewport-budgeted; if content
  exceeds `availableRows`, fall back to the scrollback dump. No scroll keys, no
  search — the terminal owns those.
- **Hosts:** `/help` (`handleSlashCommand.ts:100`), `/goal` help (`:228`),
  `/memory list`/`preview` (`handlers/memoryCommands.ts`). Content builders
  (`formatSlashCommandHelp`, `GOAL_MODE_HELP`) are reused as-is.
- **3 callers** on day one; clears the abstraction-cost guardrail.

### 1.4 Registry-declared dispatch `{argHandler?, formName?, echo}`

Registry entries (`commands/slashRegistry.ts` shape, registered in
`registerBuiltins.tsx:320-463`) gain `argHandler` and `echo: 'ifPersists' | 'never'`.
`handleSlashCommand.ts` collapses its 7 hand-rolled
`if (!rest) openCanonicalSlashForm else handler(rest)` arms (agent :116-126,
model :127, api :130-138, login :150-156, logout :157-163, approval :164-170,
resume :230-241, memory :243-253) into one generic loop, and the hardcoded echo
skip-list (:91-97) dies.

- **Error sink:** `runGuardedSlashCommand` (`handleSlashCommand.ts:52-60`) becomes the
  sole error sink and lazily emits the typed-line echo immediately before persisting
  any error row, so failures are never context-free even for `echo:'never'` commands.
  Only the guard and the outcome writer emit echoes, both centralized.
- Hand-rolled catch tails in `agentModelCommands.ts` and `loginCommands.ts:139-141`
  route through it and are deleted.

## 2. Per-command behavior

| Command                      | Ephemeral behavior                                                                                                                                                                                                             | Persists in scrollback                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`                     | LoginForm stays mounted (busy); "Opening browser...", select-account warning, device code, manual URL render in the form's progress slot; spinner frozen while code/URL shown; frame held open on settle if code/URL was shown | Echo + one line: `Signed in with ChatGPT as X (Codex models enabled)` or the TeXRA equivalent. **Failure row includes the manual sign-in URL** so it stays copyable/searchable |
| `/logout`                    | Busy form via logout picker                                                                                                                                                                                                    | Echo + one line: `Signed out of ChatGPT (X)`; relay-token caveat folded into the line when applicable                                                                          |
| `/auth`                      | None (explicit snapshot request)                                                                                                                                                                                               | Echo + full dump via the one shared status assembly (see DRY 3)                                                                                                                |
| `/api` (bare or `status`)    | None                                                                                                                                                                                                                           | Echo + the same shared dump as `/auth` (the `apiModeCommands.ts:101-113` assembly folds into `/auth`'s)                                                                        |
| `/api <route>`               | Route picker/arg path runs busy with `writeProgress` retargeted from `:121`                                                                                                                                                    | Echo + one outcome line (`Model access via API keys`), incl. model-reconcile notice                                                                                            |
| `/key`                       | Masked form unchanged; no-arg safety notice (`:141`) becomes transientNotice                                                                                                                                                   | One line `Saved the X API key` (keeps the `registerBuiltins.tsx:200-209` precedent); typed input never echoed                                                                  |
| `/model`                     | Picker unchanged; bad-arg usage → transientNotice; cancel → nothing                                                                                                                                                            | Echo + `Root model set to X`                                                                                                                                                   |
| `/agent`                     | Picker unchanged; fixed-session guard (`:118`) → transientNotice                                                                                                                                                               | Echo + `Root agent set to X`                                                                                                                                                   |
| `/approval`                  | Picker unchanged; usage → transientNotice                                                                                                                                                                                      | Echo + one-line mode confirmation                                                                                                                                              |
| `/yolo`                      | Direct toggle                                                                                                                                                                                                                  | Echo + one-line confirmation                                                                                                                                                   |
| `/help`                      | InfoPane; overflow falls back to scrollback dump                                                                                                                                                                               | Nothing (echo:'never')                                                                                                                                                         |
| `/status`                    | None (point-in-time snapshot is the archaeology)                                                                                                                                                                               | Echo + full dump, unchanged                                                                                                                                                    |
| `/goal`                      | Help text in InfoPane                                                                                                                                                                                                          | Goal set/clear: echo + one line                                                                                                                                                |
| `/memory`                    | list/preview in InfoPane; mutations direct                                                                                                                                                                                     | Mutations: echo + one outcome line. list/preview: nothing                                                                                                                      |
| `/resume`                    | Picker unchanged; invalid-id (`:237`) persists as error via guard                                                                                                                                                              | Echo + resume outcome (session switch is archaeology)                                                                                                                          |
| `/config` `/tools` `/skills` | Pure overlays, unchanged                                                                                                                                                                                                       | Nothing at all (echo:'never'; kills orphan `> /config` rows)                                                                                                                   |
| `/compact`                   | `appendTranscript` injection (`:260`) stays scrollback — compaction is a run-affecting fact                                                                                                                                    | Echo + compaction notice, unchanged                                                                                                                                            |
| unknown / unavailable        | Suggestion → transientNotice; hard failures persist via guard (with lazy echo)                                                                                                                                                 | Error row only on real failure                                                                                                                                                 |

## 3. DRY deletions

1. **7 picker-vs-arg switch arms** in `handleSlashCommand.ts` → one registry dispatch loop (~70 LOC).
2. **Echo skip-list** (`:91-97`) → registry `echo` field + guard's lazy error-echo (~10).
3. **Three hand-built `lines.push + join('\n') + append` status assemblies**
   (`loginCommands.ts:151-194` logout tail, `apiModeCommands.ts:101-113` and `:132-137`)
   → one shared status-lines helper over `loadCliApiStatusLines`/`loadCliModelAccessOverview`,
   serving `/auth`, `/api`, `/status`, and the logout outcome (~40).
4. **Hand-rolled catch tails** (`agentModelCommands.ts`, `loginCommands.ts:139-141`)
   → `runGuardedSlashCommand` sole sink (~25).
5. **Login progress chatter** (`loginStartMessage` at `loginCommands.ts:46-55` +
   `:79/84/97/131` appends) → formProgress retarget; `loginStartMessage` becomes the
   busy frame's title (~30).
6. **`'beforeAction'` on Login/Logout/ModelAccess adapters** — its only reason to exist
   (progress had nowhere to go) disappears; mode retained for the instant-action forms.
7. **`pendingExitHint`/`pendingExitResumeId`** fold into `transientNotice{resumeId?}`
   incl. the `runChatTui.tsx:870-883` timer bookkeeping (~20, partially offset by the
   statusBarDisplay rewrite).
8. **Usage-constant append-on-parse-fail triplet** (`CHAT_LOGIN_USAGE`,
   `CHAT_LOGOUT_USAGE`, `MODEL_ACCESS_USAGE`) → transientNotice via one guard-level
   path (~10).

## 4. Honest net-LOC estimate

Added: busy phase + formProgress signal + FormFrame submit slot + generation/token
gating ~90; InfoPane ~70; transientNotice slice + StatusBar/statusBarDisplay rewrite
~45; registry fields + dispatch loop ~30. **~235 added.**
Deleted: items above ~205. **Net ≈ +30 LOC**, worse (up to +60) if AbortSignal
threading lands in the same change. The payoff is behavioral (login chatter gone,
orphan echoes gone, clean command→outcome pairs) plus real 3-caller dedup; every new
primitive has 3+ callers on day one.

## 5. Edge cases

- **Headless parity.** All primitives are tui-scoped signals + Ink components.
  `chatgptLogin.ts`/`supabaseAuth.ts` keep injected callbacks; headless `texra login`
  still passes its own stdout writer. No change to `texra run`/`--print` byte output.
- **/clear mid-flight.** `resetCliState` bumps `CLI_STATE_GENERATION`
  (`cliState.ts:518`) and clears `activeForm`; `formProgress` + InfoPane +
  `transientNotice` register reset hooks. Every busy-phase settle/progress/outcome
  write checks captured generation and no-ops when stale. Nothing ghosts into the new
  session.
- **Resize.** Busy forms, InfoPane, and the notice are ordinary live-region JSX
  recomputed from `availableRows`/columns; the vendored-ink full repaint handles them
  free. Nothing finalized is parked in the live region: busy progress is in-flight by
  definition, InfoPane is a view, the notice is TTL'd.
- **Approval vs busy form.** Verified: `appInteractionPolicy.ts:152-154` currently
  ranks `form` above `approval`, so a long-lived busy login would starve an approval.
  Rule: `foregroundSurfaceKind` gains a `formBusy` input; when
  `pendingApproval && formBusy`, approval wins and the busy form restores after the
  decision (its state lives in signals, remount is free). Short-lived pickers keep
  today's ordering.
- **Ctrl-C mid-login.** First Ctrl-C behaves like Esc-during-busy: abort if available,
  else detach + notice; the busy form never swallows the existing armExit
  double-Ctrl-C exit path (`runChatTui.tsx:957`), which now writes the exit hint
  through `transientNotice{resumeId}`. Sync teardown on exit is unaffected (no new
  terminal modes).
- **Notice overwrite.** Last-writer-wins is accepted and documented (exit-hint
  precedent); nothing load-bearing routes there, so a lost hint is regenerable.

## 6. Ordered PR plan

1. **PR1 — transientNotice.** Add the slot; rewrite exit-hint path (`cliState.ts`,
   `runChatTui.tsx:870-963`, `StatusBar.tsx`, `statusBarDisplay.ts`) onto it with
   structured `resumeId`; move guard refusals/usage/unknown-suggestion to notices.
   Self-contained, deletes the bespoke fields.
2. **PR2 — registry dispatch + guard echo.** `{argHandler, echo}` fields, collapse the
   7 switch arms, guard becomes sole error sink with lazy error-echo, delete catch
   tails and the echo skip-list. Behavior-preserving except orphan-echo removal for
   overlays.
3. **PR3 — shared status assembly.** One helper over
   `loadCliApiStatusLines`/`loadCliModelAccessOverview`; `/auth`, `/api` status,
   logout tail converge; `/status` unchanged.
4. **PR4 — busy phase.** `'busy'` completion mode + `formProgress` + FormFrame submit
   slot + generation/token gating + spinner-freeze + hold-open + failure-row URL;
   retarget the two login/api `writeProgress` sites; flip Login/Logout/ModelAccess off
   `'beforeAction'`. Includes the `foregroundSurfaceKind` `formBusy` preemption rule.
5. **PR5 — InfoPane.** New foreground kind; move `/help`, `/goal` help,
   `/memory list|preview` into it with overflow fallback.
6. **PR6 (optional follow-up) — AbortSignal threading** into
   `signInCliSupabase`/`signInCliChatGpt` to upgrade Esc from detach to true cancel
   (touches `runtime/`, so isolated deliberately).

Each PR is independently shippable; PR4 depends on PR1 (notices for detach fallback)
and PR2 (guard sink); PR5 depends on PR2 (echo policy). Changelog note in the PR4/PR5
release: `/help` and login progress no longer persist to scrollback.

Key verified files: `packages/cli/src/chat/tui/commands/handleSlashCommand.ts`,
`commands/registerBuiltins.tsx`, `commands/handlers/loginCommands.ts`,
`commands/handlers/apiModeCommands.ts`, `state/cliState.ts`, `App.tsx`,
`appInteractionPolicy.ts`, `panes/StatusBar.tsx`, `panes/statusBarDisplay.ts`,
`forms/_shared/FormFrame.tsx`, `forms/_shared/ListForm.tsx`, `runChatTui.tsx`.
