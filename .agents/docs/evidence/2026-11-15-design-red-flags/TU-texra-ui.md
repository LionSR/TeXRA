Read on `main` at `cb22acd`; covered `packages/texra/src/ui/` (`progress/`, `progress/components/`, `progress/formatters/`, `wa/`, `litControllers/`, `copy/`, `styles/`, `markdown/`, `highlighting/`, `formatting/`, `monaco/`). Open PRs #14950 and #14955 change files here; their versions were read where a finding touches them (#14954 changes no file under `ui/`).

### TU-1: The run header's menu holds six kinds of item, each with its own value encoding and its own branch in one decode chain

- **Package:** texra
- **Flags:** special and general code mixed; repetition (one fact with two owners); an export with no consumer; a declarative table with a derivable column
- **Evidence:**
  - `packages/texra/src/ui/progress/components/RunHeader.ts:55-60` already declares the general item: `HeaderMenuItem { value, icon, label, activate }`. Only the shell's window items use it (`ProgressApp.ts:122-151`).
  - The same menu then carries five special forms, decoded by string in one `@wa-select` handler (`RunHeader.ts:420-457`): `RENAME_TASK`, `FORK_TASK`, `DELETE_SESSION` (`:62-68`), a prefix grammar `OPEN_FORK = 'openFork:'` matched by rebuilding `` `${OPEN_FORK}${candidate.id}` `` for every fork (`:437-443`), and `actions.find((candidate) => candidate.id === value)` (`:454`), with `menuItems.find(...)?.activate()` as the last `else`.
  - `RunMenuAction` (`progress/constants.ts:8-33`) has three columns for one identity: `id` (an `ELEMENT_IDS.*_BTN` string), `action` (the `RunAction` that licenses it) and `arm` (what it sends). `arm` is unique per row (8 rows, 8 arms), so `id` is derivable; it is read only as the `wa-dropdown-item` value (`RunHeader.ts:454,502,505`).
  - `ELEMENT_IDS` (`constants.ts:38-53`): 8 of its 14 members (`RUN_AGAIN_BTN`, `EXPORT_TRANSCRIPT_BTN`, `DIFF_STREAM_BTN`, `CLEAN_STREAM_BTN`, `PACK_STREAM_BTN`, `OPEN_RUN_STORAGE_BTN`, `COPY_DIAGNOSTICS_BTN`, `COMPACT_RESPONSE_BTN`) have 0 references outside `constants.ts` in `packages/*/src`, 0 in tests, and their string values appear in no other file. They are menu values named as button ids.
  - `dispatchAction` (`RunHeader.ts:252-264`) is a second three-way branch on `arm` (`copyDiagnostics` / `run.compact` / a host command).
  - `ProgressApp.renderOverflow` (`ProgressApp.ts:304-337`) writes the same `<wa-dropdown>` + ellipsis trigger + `repeat(items)` + `items.find(...)?.activate()` a second time for the New-task state.
  - J-b ("DOM id grammar", landed #14818) removed `GROUP_DOM_IDS`; the `openFork:` prefix and the `*_BTN` values are the same species, still here.
- **Better design:** one list of `HeaderMenuItem`s. `RunHeader` builds `[rename?, fork?, ...forks, ...runActions, ...this.menuItems, delete?]`, each item closing over what it does; the handler is `items.find((item) => item.value === value)?.activate()`. `RunMenuAction` keeps `{ action, icon, label, send }` where `send(run)` returns the event (or the header maps `arm`, used as the value). A small `renderItemsMenu(items, trigger)` in `@ui/wa` serves the header and the shell's overflow.
- **Deleted:** `RunMenuAction.id`; 8 `ELEMENT_IDS` members; `OPEN_FORK` and its prefix match; the five-branch decode chain; `ProgressApp.renderOverflow`'s body (about 30 lines); one of the two `arm` branches.
- **Size:** about 140 changed lines, 3 files (`RunHeader.ts`, `constants.ts`, `ProgressApp.ts`), plus a helper in `ui/wa/`.
- **Risk / owner decision:** none. #14955 and #14950 touch `RunHeader.ts` (labels and the fact separator only); rebase after them.

### TU-2: `BANNER_CONFIG` has three columns no code path reads for the one row where they differ, and they keep a dead option alive in `buildDetailsSummary`

- **Package:** texra
- **Flags:** an option for a special case (a table column that is constant across the rows that read it); special and general code mixed; non-obvious code
- **Evidence:**
  - `packages/texra/src/ui/progress/formatters/logFormatters/bannerFormatters.ts:28-70`: `BannerConfig` has `iconName`, `labelText`, `copyTitle`, `contentClass`, `levelClass`, `showTimestamp`, `defaultOpen`. `thinking` and `scratchpad` set the last three `false`; only `assistant` sets them `true`.
  - `assistant` returns from its own branch at `:108-121`, which hard-codes `open`, `waIcon('wand-magic-sparkles')` and `<span>Assistant</span>` and formats its own `time`. So for `assistant`, `iconName`, `labelText`, `showTimestamp` and `defaultOpen` are never read; for the other two rows `showTimestamp` and `defaultOpen` are always `false`.
  - Consequences: `timestampInfo` (`:84-87`) is always `undefined` on the only path that uses it (`:127-130`); `shouldOpen = isRunning || config.defaultOpen` (`:95`) is `isRunning`.
  - `buildDetailsSummary`'s `timestamp` option (`progress/formatters/htmlBuilders.ts:133,163-166`) has 5 callers (`bannerFormatters.ts:124`, `dataFormatters.ts:24`, `toolCard.ts:47`, `components/LatexdiffResults.ts:163`, `components/ContextManagement.ts:70`); only `bannerFormatters.ts:127` passes it, and always `undefined`. `copyButton` is passed by that one caller only.
- **Better design:** the assistant row is a message header (`messageHeaderStyles`), the other two are a quiet disclosure: two painters. The table shrinks to `{ iconName, labelText, copyTitle, contentClass }` for `thinking` and `scratchpad`; the assistant painter holds its own words. `levelClass` becomes the assistant painter's `message-${level}`.
- **Deleted:** `BannerConfig.levelClass`, `.showTimestamp`, `.defaultOpen`, the `assistant` row, `timestampInfo`, `shouldOpen`; `DetailsSummaryOptions.timestamp` and its template.
- **Size:** about 50 changed lines, 2 files.
- **Risk / owner decision:** none; no rendered output changes (verbose thinking rows already show no timestamp).

### TU-3: A document task's planned pass count is looked up from the agent catalog by label at paint time and passed through three files

- **Package:** texra
- **Flags:** a UI renderer repairing a data-model problem; pass-through variable; shallow module; non-obvious code
- **Evidence:**
  - `packages/texra/src/ui/progress/ProgressApp.ts:58-71`: `plannedPassesOf(run, host)` finds `host.agentOptions` by `option.value === id || (agentName(id) === id && option.label === id)` and reads `rounds`. The comment explains a matching rule ("a same-named agent from another source never lends it its count") that belongs to whoever launched the run.
  - It is passed as `<run-header .plannedPasses=...>` (`ProgressApp.ts:288`), stored as a property (`RunHeader.ts:244`), and handed to `progressBadgeLabel(run, this.plannedPasses)` (`RunHeader.ts:347`), a 21-line module with that one consumer (`progress/formatters/progressBadgeFormatter.ts`), which forwards it to `passLabel` (`@ui/copy/taskDiagnostics`).
  - The catalog is live state: an agent edited or hidden after the launch changes or removes the total of a run that already started. The run's own facts already hold the passes done (`documentRoundsOf(run)`).
  - 0 other readers of a planned count for a started run in `packages/*/src` (the CLI's `AgentListForm.tsx:77` reads `rounds` for the catalog list only).
- **Better design:** the documents plugin records the planned pass count with the task's facts when the run starts (it owns `task:` and the round records), and `documentRoundsOf`'s neighbour returns `{ done, planned }`. `RunHeader` calls `passLabel` from the run alone.
- **Deleted:** `plannedPassesOf`, `RunHeader.plannedPasses`, the `.plannedPasses` binding, `progressBadgeFormatter.ts` (its two lines move into the header or `copy/taskDiagnostics.ts`), the label-matching rule.
- **Size:** about 60 changed lines in `ui/` (3 files) plus the plugin's fact.
- **Risk / owner decision:** **owner decision**: a new field on the documents plugin's stored run fact (a stored-format change), and a behavior change (the total stops following later catalog edits).

### TU-4: The run header overrides the run's status word, tone and Stop from its own conditions (J7's remainder)

- **Package:** texra
- **Flags:** repetition (a rule with two owners); a false comment; a UI renderer repairing a data-model problem
- **Evidence:**
  - J7 (catalogue: landed #14789) gave every renderer one reading, `runStatus(run)` (`packages/texra/src/ui/copy/runStatus.ts:142-147`). `RunHeader.ts:338-342` still computes `canContinue = status.section !== 'running' && status.section !== 'waiting' && acceptsFollowUp(run)` and paints `'Ready'` (a literal, beside `RUN_STATUS.ready.word` at `runStatus.ts:78`) with `tone-neutral` (`:360`) in place of `status.word` and `status.tone`. The header's menu repeats it (`:478`).
  - The same run's row in the task list paints `status.word`, `status.tone` and `status.glyph` (`RunTab.ts:156-163`), and the TUI reads `runStatus` too. So an ended chat reads "Ready", grey, in the header and "Completed" or "Error", coloured, in the list beside it; an interrupted root chat reads "Ready" in the header and "Interrupted" in the list.
  - `:343-345`: "The header offers exactly what the session view's `actions` licenses", then `idle = status.key === 'waiting' && run.approval === 'none'` and Stop is drawn only when `canStop && !idle` (`:379`). The comment is false: the header withholds an action the view licenses. (`status.key === 'waiting'` already implies `approval !== 'own'`, `shared/session/runStatusKey.ts:48`.)
- **Better design:** the reading has one owner. Either `runStatusKey` gains the reading the header wants (an ended run that takes a follow-up reads `ready`, in the list as well), or the header paints `runStatus(run)` as the list does and says "Send a message to continue" in its tooltip only. Whether an idle run offers Stop is decided where `actions` is built (the session view), not in the header.
- **Deleted:** `canContinue`, `idle`, the `'Ready'` literal, the tone override, the false comment.
- **Size:** about 25 changed lines in `RunHeader.ts`; a few in `runStatusKey.ts` or the view's `actions` if the rule moves down.
- **Risk / owner decision:** **owner decision**: user-visible (which word an ended chat shows, and whether an idle run has Stop). Earlier id: J7 / R6.

### TU-5: Rename and Delete are each implemented twice, in the header and in the list row, with different rules; the row's delete has a dead path and a private in-flight set

- **Package:** texra
- **Flags:** repetition (one action, two implementations that disagree); special and general code mixed; a hand-written second mechanism; dead code
- **Evidence:**
  - Rename. `RunHeader.finishRename` (`RunHeader.ts:277-286`) skips an unchanged title with `title === run.title`. `RunTab.finishRename` (`RunTab.ts:121-135`) seeds its field with `run.title` (`:219`, `runTitle`) and skips with `title !== (this.run.description || this.run.label)`: a second spelling of what `RunView.title` already is ("the user's rename, else the AI one-liner", `packages/harness/src/shared/session/sessionView.ts:82-85`). Both own a `renaming` flag, an `inlineRenameField` and the `run.rename` dispatch.
  - Delete. `RunHeader.ts:447-452` dispatches `run.delete` directly. `RunTab.ts:321-329` raises a private `run-row-delete` event; `RunTabs.ts:233-237` re-checks `this.removable && tab.run.actions.includes('delete')` (the condition that already decided the row's `removable`, `:183`, and whether the item is drawn, `RunTab.ts:343`), then `deleteRun` (`RunTabs.ts:118-128`) guards with a component-level `deleting` set (`:92-95`) that `willUpdate` (`:100-110`) empties by watching the view and `surface.runs.get(id)?.rejected`.
  - The in-flight guard already has an owner: `busyWhile` in `progress/sessionSurfaces.ts:321-338` marks a key in `Surface.sending` / `.polishing` "so a second click finds it so" and clears it however the request ends. It is applied to `followUp.send`, `launch` and `polish` only (`:362-374,386-390,426-431`), so the header's Delete has no guard and the row's has its own.
  - `RunTabs.handleTabClick` has `case 'delete'` (`RunTabs.ts:274-276`); no template emits `data-action="delete"` (grep over `packages/*/src`: 0 hits; the row's delete is the dropdown item). Dead branch.
  - The row's menu decodes `event.detail.item.value` through a hand-typed `CustomEvent<{ item: { value: string } }>` (`RunTab.ts:313-316`) where the kit has `selectedItemValue` (`ui/wa/selectTemplates.ts:26-29`).
- **Better design:** the row sends `SessionUiEvents.runtime({ kind: 'run.delete' })` and `run.rename` itself, as the header does, and `sessionSurfaces.runtimeRequestFor` keeps every run-scoped request busy under its run and kind, dropping a second one (the general form of the `followUp.send` special case). `RunTabs` keeps only the focus hand-off, keyed on the run leaving the view. One `renameTitle(run, value)` in `ui/wa/inlineRename.ts` or `copy/` returns the title to send or `null`.
- **Deleted:** `RunTabs.deleting` and its `willUpdate`, the `run-row-delete` event and its listener, the `case 'delete'` branch, the second unchanged-title rule, the hand-typed select event.
- **Size:** about 90 changed lines, 4 files (`RunTab.ts`, `RunTabs.ts`, `RunHeader.ts`, `sessionSurfaces.ts`).
- **Risk / owner decision:** none. #14955 changes `RunTab.ts`'s labels only (read: `git show origin/claude/clever-pascal-h5a0xm:packages/texra/src/ui/progress/components/RunTab.ts`); it does not touch these paths.
