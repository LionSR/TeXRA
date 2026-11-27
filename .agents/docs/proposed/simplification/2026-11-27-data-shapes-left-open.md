# Data shapes the 2026-11-27 audit verified and did not land

Date: 2026-11-27
Status: proposed
Origin: the 2026-11-27 scheduled data-structure audit, read on `main` at
`3bc72f1`, after the document pipeline's deletion (#15229) freed the shapes
earlier notes held back. Its PR lists what landed. The findings below were
checked against their producers and readers and held back, each for the
reason given.

Four audit PRs were open that morning (#15242, #15245, #15247, and #15230
with #15216 beside them); a finding whose producers or readers they touch
waits for them. #15245 is the 2026-11-26 data-structure audit: its own
left-open note travels with it.

## 1. A model verdict restates the plan its route carries

`ModelAvailabilityStatus.usageRoute`
(`packages/harness/src/model/computeModelOptions.ts`) is `route.plan` when
the verdict is an available kind and absent otherwise, copied through
`routeVerdict` and the key read before `optionOf` spreads it into the public
`ModelVerdict`. `optionOf` holds the route beside the verdict.

Proposed: the verdict is the kind alone, and `optionOf` reads the plan off
the route.

Held back: `ModelRoute` (`packages/llm/src/models/modelRoute.ts`) is in an
open PR, and only a session and a key route carry `plan`, so the read is an
`in` test unless the route's cases are narrowed first. About twenty lines,
one file.

## 2. The desktop's remembered projects are re-copied field by field

`readRememberedDesktopProjects`
(`packages/desktop/src/main/desktopProjects.ts`) returns three of the four
fields `partitionFolders` answered, under a second interface. Returning the
partition would expose `kept`, which only the write-back reads, so the copy
is what keeps that off the caller. Not taken: no line is saved without
widening the result.

## 3. `TexraDiffView.fill` is set by every producer

`packages/desktop/src/renderer/TexraDiffView.ts`: the Review pane and one
E2E spec both set `fill`, so the non-fill CSS (a 42vh height, a 640px cap, a
border) styles no element.

Held back: the element is imported by `packages/desktop/src/renderer/main.ts`,
which three open PRs touch, and the cut edits an E2E spec. About 25 lines.

## 4. Checked and refused

- `ModelChoice` (`packages/texra/src/ui/progress/components/ModelPicker.ts`)
  copies `value` and `label` from the row it carries, but `disabled` is
  computed, not a row field, and the unlisted model has no row: making a
  choice the row itself needs a union and the computation at two readers.
- `ToolStatus` in `packages/texra/src/tools/setup/ProbeEnvironmentTool.ts`
  has the fields of the LaTeX probe's status, but its `name` is any binary
  the user asks about, where the probe's is a catalog name; one type for
  both loosens the owner's.
- `CredentialStore<E>` (`packages/texra/src/common/secrets/storeCredential.ts`)
  has one instantiation, and removing it imports the platform port into a
  module that is written against none.
- `readDesktopLogSnapshot`'s optional `workspaceRoot`
  (`packages/desktop/src/main/desktopAppLog.ts`): four lines, and a test
  restates the signature by hand.
- `staticTranscriptRowBudget`'s `undefined`
  (`packages/cli/src/chat/tui/appLayout.ts`) is the "no cap" a scoped
  transcript needs, so its caller's `?? 0` for the middle allocation stays.

## Still open from earlier notes

`2026-11-25-data-shapes-left-open.md` items 1 and 3 (each needs the owner's
word) and the retry decision's `'configured'` literal; `RunRows.grants` and
the `toolUse` log payload (`2026-11-23-data-shapes-left-open.md`);
`WorkbenchTab` as a union on `kind` and `ExecResult.success`
(`2026-11-20-data-shapes-left-open.md`); `ToolFileAttachment`'s three
payload fields (`2026-11-18-data-shapes-left-open.md`).
