# U. Duplication that crosses packages

Read-only audit, round 3, area U (`BRIEF.md`). Read on `main` at
`4e32bb921018ccb4626c0fb47b25a2c2d365b5f4`. The only open pull requests are
14773 (docs, set aside) and 14741 (the store's blob links); neither touches a
file cited here. Packages A–E of the order note have no open PR yet; where a
finding sits in a package's files, the finding says which.

The question for every overlap: is it **one fact in two homes** (a finding,
with the owner it moves to) or **two facts that share words** (fine)? Every
pair `check:fact-spread` prints is answered in the table below, and so is
every predicate it counts.

## Numbers

Production source lines (`.ts`/`.tsx`, tests excluded): harness 80,188,
texra 85,027, cli 45,856, extension 17,135, desktop 15,033, llm 12,025,
trace-viewer 418.

`node scripts/check-fact-spread.mjs --report` at this commit:

| Predicate             | Files | harness | texra | cli | extension | desktop | llm |
| --------------------- | ----- | ------- | ----- | --- | --------- | ------- | --- |
| `toErrorMessage`      | 187   | 56      | 57    | 36  | 19        | 12      | 5   |
| `Cause.squash`        | 77    | 22      | 18    | 19  | 14        | 4       | 0   |
| `Cause.hasInterrupts` | 52    | 18      | 18    | 8   | 5         | 3       | 0   |
| `parentId`            | 45    | 22      | 9     | 12  | 1         | 1       | 0   |
| `withPerKeyLane`      | 21    | 12      | 4     | 1   | 1         | 3       | 0   |
| `readOnly`            | 10    | 1       | 7     | 0   | 0         | 2       | 0   |
| `ownedHere`           | 0     |         |       |     |           |         |     |

(trace-viewer holds 2 of the `toErrorMessage` files.) Vocabulary overlap: 18
pairs, 9 of them within one package.

The ratchet sees two forms only, `Schema.Literals([...])` and
`[...] as const` (`scripts/check-fact-spread.mjs:95-124`). A scan of every
form (type-alias unions, `as const` arrays, string-valued object literals;
scratch script, not committed) finds **52 cross-package pairs** whose sets
share at least three members and three quarters of the smaller set (the
103-name icon list left out). The forms the ratchet misses are where hosts
restate a vocabulary: three of U3's five restatements are
`type X = 'secret' | 'env' | 'none'`, invisible to the check.

`toErrorMessage` shapes over its 337 call sites: 70 build a new error's
`message` from another error, 33 of them as bare
`message: toErrorMessage(cause)` with the cause passed beside it (cli 8,
texra 11, desktop 6, extension 6, harness 5, llm 1). No site tests the text
it returns (`toErrorMessage(…).includes|startsWith|match`: 0).

Comment share of the files the findings centre on: `rootLaunch.ts` 30%
(154 lines), `delegationApproval.ts` 30% (78), `apiProviders.ts` 32% (137),
`request.ts` 27% (280), `latexToolchain.ts` 27% (722), `surfaceDecision.ts`
26% (206), `cliContext.ts` 23% (568).

## The 18 pairs and the seven predicates: one fact or two

| #   | Pair (shared members)                                                                                                          | Verdict                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `desktop/renderer/dockControls.ts:19-25` ~ `workbenchController.ts:396` (agent, files, terminal)                               | **Two facts.** Two menus each choose a subset of `WORKBENCH_KIND_META` (the group menu five, the empty group three), both typed `WorkbenchKind`. Fine.                                                                                                                           |
| 2   | `harness/common/plugins/hookProtocol.ts:140` ~ `shared/schemas/hookOutcome.ts:50` (allow, ask, deny)                           | **Two facts.** The external hook protocol (with `defer`, and `approve`/`block` read as allow/deny, `:135,:197`) against the recorded decision (`defer` → null). Normalized once at the boundary, as AGENTS.md asks. Fine.                                                        |
| 3   | `harness/shared/approvalBypassKind.ts:13` ~ `texra/ui/copy/delegationApproval.ts:12` (bash, superYolo, toolEdit)               | **One fact.** `RUN_GRANT_ORDER` restates the kinds with a check that cannot see a missing one. U4.                                                                                                                                                                               |
| 4   | `harness/shared/approvalPolicy.ts:3` ~ `texra/ui/copy/approvalPolicy.ts:31` (ask, never, yolo)                                 | **One fact.** `APPROVAL_POLICY_DISPLAY_ORDER`, "must stay a permutation" in a comment. U4.                                                                                                                                                                                       |
| 5   | `shared/schemas/contextManagement.ts:58` ~ `followUp.ts:133` (cancelled, completed, failed)                                    | **Two facts** (a compaction's state; a receipt's reason), but the receipt's three members are `RUN_OUTCOME` restated. U4.                                                                                                                                                        |
| 6   | `contextManagement.ts:58` ~ `shared/transcript/workflowCall.ts:27` (cancelled, failed, skipped)                                | **Two facts** (compaction state; script tally), but `TALLY_OUTCOMES` restates `ScriptTally`'s keys. U4.                                                                                                                                                                          |
| 7   | `contextManagement.ts:58` ~ `llm/api/openaiResponsesWire.ts:91`                                                                | **Two facts.** A compaction's state against OpenAI's response status. Fine.                                                                                                                                                                                                      |
| 8   | `contextManagement.ts:58` ~ `llm/turn.ts:284`                                                                                  | **Two facts**, as 7. Fine.                                                                                                                                                                                                                                                       |
| 9   | `followUp.ts:133` ~ `openaiResponsesWire.ts:91`                                                                                | **Two facts**; the receipt side leaves with U4.                                                                                                                                                                                                                                  |
| 10  | `followUp.ts:133` ~ `turn.ts:284`                                                                                              | **Two facts**; as 9.                                                                                                                                                                                                                                                             |
| 11  | `harness/shared/schemas/run.ts:64` ~ `texra/controllers/session/openGuiWindow.ts:110` (fork, openRunStorage, resume, runAgain) | **Two facts.** The actions the view offers against the host request kinds that carry some of them out (`export` is `exportTranscript`, `files` is `fileAction`/`pack`/`clean`). The one-fact note dropped this pair for that reason (§G); agreed. The kinds list itself is G4's. |
| 12  | `harness/shared/schemas/storedTurn.ts:75` ~ `llm/message.ts:33` (audio, document, video)                                       | **One fact in two homes by ruling** (storage owns the stored shape, `storedTurn.ts:1-15`). The ruling's compile-time gate is missing. U5.                                                                                                                                        |
| 13  | `storedTurn.ts:125` ~ `turn.ts:264` (the five finish reasons)                                                                  | As 12. U5.                                                                                                                                                                                                                                                                       |
| 14  | `llm/api/anthropicMessagesWire.ts:16` ~ `turn.ts:304` (the five refusal categories)                                            | **One fact, inside llm.** Anthropic's own category words, copied from the wire schema into the turn's refusal evidence. U7(b).                                                                                                                                                   |
| 15  | `openaiResponsesWire.ts:91` ~ `turn.ts:284` (six statuses)                                                                     | **One fact, inside llm**, as 14 (and `incomplete_details.reason`, `:109` ~ `turn.ts:294`). U7(b).                                                                                                                                                                                |
| 16  | `llm/message.ts:27` ~ `turn.ts:60` (high, low, medium)                                                                         | **Two facts.** An image's detail against a reasoning effort. Fine.                                                                                                                                                                                                               |
| 17  | `texra/shared/session/hostRequest.ts:194` ~ `ui/progress/components/FileList.ts:54` (five file verbs)                          | **One fact.** `FILE_VERBS` restates the request's literal set so a DOM `data-command` string can be read back. U4.                                                                                                                                                               |
| 18  | `texra/shared/settingsView/settingsTarget.ts:15` ~ `settingsViewMessages.ts:81` (agents, latex, memory)                        | **Two facts.** Settings pages against settings snapshot payloads; J5 (lane 3.4) folds the snapshots into one record anyway. Fine.                                                                                                                                                |

Seven pairs carry one fact (3, 4, 12, 13, 14, 15, 17), and three more lose a
restated side with U4 (5, 6, and 9–10 through the receipt). U4 and U7(b)
take the count from 18 to 9; U5 keeps its pairs by ruling and adds the gate.

| Predicate                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toErrorMessage` 187     | **A formatter, not a decision.** It renders a cause chain (`utils/errors/errorMessage.ts:41-63`); no site reads its text back. The 33 bare `message: toErrorMessage(cause)` constructions store a message derived from the `cause` beside it. Most of them are host-port failures (`desktopDialogs.ts:65,198`, `dialogs.ts:37,110,150`, `VscodeUiHost.ts:171`, `desktopHostRequests.ts:244,270`), which is G10's one `HostFailed` (lane 8.3). One site does decide by text, `cli/commands/models.ts:49`: U7(c). |
| `Cause.squash` 77        | Paired with the interrupt test to report a cause (`desktopWindowHost.ts:91`); fine. The invoker and loop squashes are the one-fact note's "Defects" row.                                                                                                                                                                                                                                                                                                                                                        |
| `Cause.hasInterrupts` 52 | The 34 files outside the harness hold `hasInterruptsOnly(cause) ? <answer> : report` on a host fiber, and each gives its own fiber's answer: `Effect.void` (`extension.ts:601`), re-raise (`settingsHostBindings.ts:112`), a `CANCELLED` value (`ui/progress/sessionTransport.ts:263`), fail the window's call (`server/windowHost.ts:207`). None decides the run-stop fact R2 owns. Fine.                                                                                                                      |
| `parentId` 45            | The CLI's 12 render a tree from the view; O9 keeps the writing jobs on `facts.parent`. Fine.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `withPerKeyLane` 21      | `EFF-ADOPT-per-key-lane-semaphore` (refuted). Fine.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `readOnly` 10            | One-fact slice 3 deletes it with the claims. Not here.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ownedHere` 0            | Gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## U1. Which run grant a request offers is decided in nine places across three packages, and they disagree

**Red flags:** two (nine) representations of one fact; information leakage
(an overloaded wire boolean that every surface reads its own way); special
and general code mixed (a bash-only branch in the general decision mapper).

**Evidence.** The question: "does this prompt offer 'approve all X in this
task', and which grant does it turn on?"

- Harness, the grant of a kind: `GRANT_OF` (`harness/src/shared/schemas/request.ts:212-216`,
  `{ bash: 'bash', toolEdit: 'toolEdit', proposal: 'superYolo' }`), read by
  `grantAnswering`/`bypassCovers` (`:234-246`) and by `answerMismatch`
  (`:277`).
- App, the same table again: `BYPASS_OF_KIND` (`texra/src/shared/session/surfaceDecision.ts:116-122`,
  same keys, same values, same type), read at `:149`.
- The request's own say, `allowBypass: Schema.Boolean`
  (`harness/src/shared/schemas/prompts.ts:17`, `:180`), has five writers with
  two meanings. For bash, "the grant this prompt names is the shell's":
  `allowBypass: ask.grant === 'bash'` (`agent/runtime/loop/commandApproval.ts:50`),
  false both for a hook's ask (`grant: null`) and for another tool's call
  (`grant: 'superYolo'`). For the others, "no hook asked":
  `hook !== 'ask'` (`tools/approval/toolEditApproval.ts:118`,
  `delegation/proposalFlow.ts:191`, `delegation/AgentTool.ts:224`);
  `UserQuestionTool.ts:54` (texra) writes `false`.
- Its readers: the harness twice, as "only a person answers"
  (`agent/runtime/requests.ts:132`, `runApprovalQueue.ts:94-95`); the app's
  mapper for bash only, `permission.kind === 'bash' && !permission.data.allowBypass`
  (`surfaceDecision.ts:155`); the web bash panel
  (`ui/progress/components/BashRequestPanel.ts:32-36`) and the CLI bash card
  (`cli/src/chat/tui/modals/BashApproval.tsx:55-59`).
- The other four surfaces offer the grant unconditionally:
  `ToolEditRequestPanel.ts:39-41`, `ProposalRequestPanel.ts:97-106`,
  `EditApproval.tsx:69`, `AgentProposal.tsx:245`.
- The decision is checked once more where it lands: `answerMismatch`
  (`request.ts:268-279`, called at `controllers/session/SessionRequests.ts:213`)
  tests the kind against the grant and never `allowBypass`.

So a `PreToolUse` hook that asks about a command hides "approve commands"
on both hosts, while a hook that asks about an edit or an agent proposal
still offers "Approve all edits/agent work in this task". The app sends the
grant (`surfaceDecision.ts:148-170`), and the harness records it
(`decideUnderGrant`, `runApprovalQueue.ts:350-379`). Which reading is right
is for the owner to say; what is wrong is that each panel decides it.

The words differ as well. The web surfaces say "Approve all commands in this
task" (`RUN_GRANT_LABEL`, `ui/copy/delegationApproval.ts:25-29`). The CLI
says "approve commands for session" and "approve edits for session"
(`BashApproval.tsx:58`, `EditApproval.tsx:69`), but "approve agent work for
this task" (`delegationApproval.ts:48`). Yet the module's comment (`:7-9`)
says every surface names the grant "with the same noun".

**The design decision behind it.** "What this prompt may turn on" is a fact
the opener knows (its `ask.grant`, its hook), but the opener stores a boolean
whose meaning depends on the kind. Each surface then rebuilds the grant from
the kind (`BYPASS_OF_KIND`) and the boolean (or ignores it).

**The better design.** The opener writes the grant the prompt offers, or
none, once, on the request row. R7 designed this field (`answeredBy:
'person' | ApprovalBypassKind`, root note §R7; E2) and it did not land:
`allowBypass` is still the field. One reading,
`offeredGrant(payload): ApprovalBypassKind | null`, is exported beside
`GRANT_OF` from `@texra-ai/harness/schemas`. `BaseRequestPanel`'s `grant`
getter and `ConfirmCard`'s `a` row each render from it with
`RUN_GRANT_LABEL[grant]`. `approvalDecisionArm` sends that grant, and
`answerMismatch` refuses a decision whose grant differs from it.
`surfaceDecision.ts`'s header promise ("one answer means one thing on all of
them") then holds for the `a` key too.

Deleted: `BYPASS_OF_KIND` (1 file), the bash-only branch at
`surfaceDecision.ts:155`, the three web `grant` overrides
(`BashRequestPanel`, `ToolEditRequestPanel`, `ProposalRequestPanel`) and the
three CLI `alwaysAllowLabel` decisions in favour of one each, `personOnly`
(`runApprovalQueue.ts:94`) and the inline twin at `requests.ts:132` (both
read the one field), and the CLI's two "for session" strings.

**What we give up.** One of today's two behaviours under a hook's ask. Also
a row-shape change if the field is renamed: a `request.opened` version bump
and regenerated golden store, no reader for the old shape.

**Change amplification.** "A new request kind that offers a run grant (a
web-fetch approval)": today `GRANT_OF`, `BYPASS_OF_KIND`, the opener's
`allowBypass` expression, a web panel's `grant` getter, a CLI modal's
`alwaysAllowLabel`, and the copy, which is 6 files in 3 packages; after, the
opener and the copy table (a compile error), 2.

**Depends on:** none for the shared reading (`offeredGrant` over today's
`allowBypass` plus the kind can land alone). The field itself is R7's
unlanded half. Files: `texra/shared` and `ui/progress` are package B's, the
CLI modals package D's.

## U2. An Auto-approve launch is said three ways, and the policy it runs under is computed in three packages

**Red flags:** two fields for one decision (no option for a special case);
a schema value nothing reads; repetition of a harness rule in the CLI and the
UI.

**Evidence.**

- The start input takes `approval: { policy?: ApprovalPolicy; delegated?: boolean }`
  (`harness/src/shared/session/runtimeRequest.ts:354-361`), documented as "a
  stricter approval policy for this run (it only narrows the project's)". It
  admits `'yolo'`, which is not stricter. `rootLaunch` drops it:
  `approval?.policy === 'yolo' ? undefined : approval?.policy`
  (`agent/runtime/rootLaunch.ts:128-129`). The meaning is carried by
  `delegated` instead (`:122-124`). The narrowed set already exists as
  `APPROVAL_POLICY_LIMITS = ['never', 'ask']`
  (`shared/approvalBypassKind.ts:24`).
- The producers say it differently. The CLI sends `{ policy: 'yolo', delegated: true }`
  (`launchApproval`, `cli/src/runtime/cliContext.ts:500-507`; 3 callers:
  `executeCli.ts:156`, `chatSessionController.ts:493`, `commands/tasks.ts:249`).
  The GUIs send `{ delegated: true }` (`launchApprovalOptions`,
  `texra/src/controllers/mainView/backend/MainViewRunLaunchController.ts:150-155`)
  from the surface's own vocabulary, `Schema.Literals(['policy', 'autoApprove'])`
  (`texra/src/shared/session/surface.ts:93`).
- The rule "a launch only narrows; Auto-approve widens its own task, never
  over Block" is decided by the harness: `decideApproval` checks `never`
  first (`shared/approvalPolicy.ts:65-73`), `runPolicy` narrows by the limit
  (`approvalBypassKind.ts:67-74`), and `delegated` turns every bypass on. It is
  decided again in the CLI: `effectiveApprovalPolicy`
  (`cliContext.ts:518-527`, 5 call sites: `cliContext.ts:442`,
  `runChatTui.tsx:260,325,582`, `launchApprovalNotice` at `cliContext.ts:537`)
  with its notice wording (`:531-544`). It is decided a third time in the
  composer: `overridden = launch.approval === 'autoApprove' && policy !== 'never'`
  (`texra/src/ui/progress/components/composerChipMenus.ts:258`).
- The CLI acts on its own result, not only displays it. `texra team`
  refuses a headless run on `context.approvalPolicy === 'ask'` and warns on
  `'never'` (`cli/src/commands/team.ts:136,179`).

**The design decision behind it.** A launch's approval was added as a
policy field and then a boolean beside it. Each host then had to know how
the harness combines them with the project's policy to say what a task will
do.

**The better design.** One field, one rule, both owned by the harness. The
field is `approval: Schema.optional(Schema.Union([Schema.Literal('autoApprove'), Schema.Literals(APPROVAL_POLICY_LIMITS)]))`,
so `'yolo'` can no longer be said where it is ignored. The rule is one pure
function in `shared/approvalPolicy.ts`, exported from `/schemas`:
`launchPolicy(project, approval): ApprovalPolicy`. `rootLaunch` switches on
the field once. `effectiveApprovalPolicy`, `launchApprovalNotice`'s test and
the composer's `overridden` call `launchPolicy`. The surface's
`'policy' | 'autoApprove'` becomes the same literal (absent for "use the
project's").

Deleted: `approval.policy`/`approval.delegated` as two fields (2 readers,
`rootLaunch.ts:122,129`), `launchApproval` (3 callers) and
`launchApprovalOptions` (1) as translations, `effectiveApprovalPolicy`'s
body, the composer's inline rule, and `'policy'` as a stored-in-surface
word.

**What we give up.** `--approval-policy yolo` as a value that reaches the
wire unchanged: the CLI maps its flag to `'autoApprove'` at its boundary.
The service protocol's start shape changes (one version bump).

**Change amplification.** "A launch choice 'auto-approve edits only'":
today the start schema, `rootLaunch`, `launchApproval`,
`effectiveApprovalPolicy` with its notice, the surface literal,
`launchApprovalOptions` and the composer, which is 6 files in 3 packages;
after, the literal, `rootLaunch`'s switch, `launchPolicy` and the copy, 3.

**Depends on:** none. The CLI files border package A's (`cli/src/`'s run
reads) and the composer package B's.

## U3. A credential's origin is llm's `CredentialOrigin`, re-spelled five times in four packages, in two vocabularies, with four sets of labels

**Red flags:** two representations of one fact; information leakage (llm's
secret-name grammar spelled in the app); repetition of copy across hosts.

**Evidence.**

- The owner: `CredentialOrigin = 'secret' | 'env' | 'none'`
  (`llm/src/providers/credentials.ts:52`), produced by the one ladder
  `resolveCredential`, which "API keys and the GitHub token both read
  through" (`:63-72`). The GitHub token's origin is it exactly:
  `resolveGitHubTokenSource(): Effect<CredentialOrigin, …>`
  (`texra/src/tools/github/githubAuth.ts:70-72`).
- Restated four times for the GitHub token:
  `Schema.Literals(['secret', 'env', 'none'])` on the settings wire
  (`texra/src/shared/settingsView/settingsViewMessages.ts:358-363`, whose
  comment calls `'secret'` "stored in SecretStorage", one host's store);
  `trackedSignal<'secret' | 'env' | 'none'>`
  (`extension/src/settingsView/frontend/settingsState.ts:218`); the
  `githubTokenStatus` property (`tabs/GitTab.ts:178`); and
  `type GitHubTokenStatus = 'secret' | 'env' | 'none'` with "the vocabulary
  lives beside the view that labels it" (`cli/src/chat/tui/forms/GitHubTokenForm.tsx:17-21`).
- The API key's origin is re-spelled as a status, `ApiKeyStatus = 'set' | 'env' | 'not-set'`
  through `STATUS_BY_ORIGIN` (`llm/src/providers/apiProviders.ts:44,95-99`;
  that half is O8). It is then restated on the wire,
  `Schema.Literals(['set', 'env', 'not-set'])`
  (`texra/src/shared/settingsView/profileViewMessages.ts:33`), which O8 did
  not list.
- The labels are written per host: "Key set / Env / Not set" in the webview
  (`texra/src/ui/wa/statusIcons.ts:110-124`) and again in the CLI
  (`ProviderApiKeyForm.tsx:29-38`); "not set / key set" in the VS Code quick
  pick (`extension/src/commands/api/apiKeyCommands.ts:110`, `env` folded into
  "key set"); "Token set / From GH_TOKEN / GITHUB_TOKEN / Not set" in the CLI
  (`GitHubTokenForm.tsx:31-35`). The actions "Set token / Replace token /
  Remove token / Create on GitHub…" appear twice (`GitTab.ts:244-262`,
  `GitHubTokenForm.tsx:44-65`).
- The secret-name grammar `apiKey.<provider>` is llm's (`apiKeySecretName`,
  `apiProviderOfSecretName`, `apiProviders.ts:26-41`), but
  `ProbeEnvironmentTool.ts:260,270` tests `key.startsWith('apiKey.')` twice.
  llm's inverse folds "an `apiKey.` entry for no known provider" and "not an
  API-key entry" into one `undefined`.

**The design decision behind it.** llm exported the origin as a type alias,
not a schema, and the wire schemas and frontends, which need a runtime
value, spelled their own. The copy has no owner in `ui/copy/`, which the CLI
already imports (`delegationApproval.ts`).

**The better design.** llm exports `CredentialOriginSchema = Schema.Literals(['secret', 'env', 'none'])`,
whose `Type` is `CredentialOrigin`. Both wire schemas use it (O8 deletes
`ApiKeyStatus`, so the profile wire carries the origin too), and the two
frontends and the CLI form type against it. One `ui/copy/credentials.ts`
holds `CREDENTIAL_ORIGIN_COPY: Record<CredentialOrigin, { label }>` and the
token action labels, read by `statusIcons.ts`, `GitTab`, both CLI forms and
the quick pick. llm's inverse answers three ways
(`apiKeyEntry(key): ApiKeyProviderId | 'unknown' | undefined`), so the probe
tool's two prefix tests go.

Deleted: the four `'secret' | 'env' | 'none'` spellings, the profile
wire's literal set, four label tables (`STATUS_LABELS`,
`providerApiKeyStatusLabel`, `renderKeyStatusIcon`'s fallbacks, the quick
pick's ternary), and two `startsWith('apiKey.')`.

**What we give up.** The quick pick's two-word "key set" for an environment
key, which becomes "Env" like everywhere else.

**Change amplification.** "A fourth origin (the OS keychain)": today
`CredentialOrigin`, `ApiKeyStatus` with its table, two wire schemas, two
extension types, the CLI type, and four label sites, which is 10 files in 4
packages; after, the schema and the copy table (compile errors at the
exhaustive records), 2.

**Depends on:** O8 (lane 7.3, package E) for the API-key half. The GitHub
half can land alone.

## U4. Display orders and subsets restate a vocabulary with a check that cannot see a missing member

**Red flags:** two representations of one fact; a comment substituting for
design ("must stay a permutation"); a renderer compensating for the data
model (a typed verb serialized into the DOM and parsed back).

**Evidence.** Each list is typed `satisfies readonly K[]`, which refuses a
foreign member but accepts a missing one:

- `RUN_GRANT_ORDER = ['toolEdit', 'bash', 'superYolo'] as const satisfies readonly ApprovalBypassKind[]`
  (`texra/src/ui/copy/delegationApproval.ts:12-16`), beside
  `RUN_GRANT_NOUN` (`:18-22`), which is `satisfies Record<ApprovalBypassKind, string>`
  (exhaustive) and declares its keys in the same order. Three readers:
  the run header's chips (`ui/progress/components/runGrantChips.ts:52`), the
  CLI's `/status` (`cli/src/chat/tui/sessionStatus.ts:113`) and `/approval`
  (`commands/registerBuiltins.tsx:222`). A fourth bypass kind compiles and
  is missing from all three.
- `APPROVAL_POLICY_DISPLAY_ORDER` ("must stay a permutation of
  `APPROVAL_POLICIES`", `texra/src/ui/copy/approvalPolicy.ts:30-35`) beside
  the exhaustive `APPROVAL_POLICY_COPY` in the same order (`:9-28`); one
  reader (`:37-44`).
- `FILE_VERBS` (`ui/progress/components/FileList.ts:54-63`) restates
  `hostRequest.ts:194-200`. It exists to read a verb back from
  `data-command` (`:418-441`), with `console.warn('Unknown file action')` for
  a string the component itself wrote.
- `TALLY_OUTCOMES` (`harness/src/shared/transcript/workflowCall.ts:27-32`)
  restates `ScriptTallySchema`'s keys minus `total`
  (`shared/schemas/scriptDelivery.ts:6-13`).
- `FollowUpReceipt`'s `unanswered.reason` restates `RUN_OUTCOME`'s three
  values (`shared/schemas/followUp.ts:133-140` against `run.ts:12-16`). It is
  filled by `reason: end?.outcome ?? 'ended'`
  (`shared/session/runRowReads.ts:316-324`).
- Cross-package, with a false comment: `ToolDependencyStatusSchema`
  (`texra/src/shared/tools/toolPlugin.ts:8-14`) says "the availability probes
  … read it". The probes are the harness's, and they type the same union
  inline (`harness/src/tools/toolAvailabilityService.ts:19`, produced at
  `toolAvailability.ts:335`). The texra schema is a second home of the
  harness's fact, read by the settings wire (`settingsViewMessages.ts:301`)
  and the labels (`toolDependencyStatusLabels.ts`).

**The design decision behind it.** An order or subset was written as a list
beside the vocabulary instead of derived from the exhaustive record that
already holds it, because a plain list reads simpler than a derivation.

**The better design.** Derive each from its owner.

- `RUN_GRANT_ORDER = Record.keys(RUN_GRANT_NOUN)`, and likewise
  `APPROVAL_POLICY_OPTIONS` over `Record.keys(APPROVAL_POLICY_COPY)`. The
  record's declaration order is the display order, said once in its doc.
- `hostRequest.ts` exports `FileActionSchema`. `FileList` closes over the
  typed verb in each button's handler, so the DOM round trip, `FILE_VERBS`
  and the warning go (or, if the keyboard delegation must stay,
  `Schema.is(FileActionSchema)`).
- `TALLY_OUTCOMES` is a `Record<Exclude<keyof ScriptTally, 'total'>, true>`
  read through `Record.keys`.
- The receipt's reason is
  `Schema.Union([RunOutcomeSchema, Schema.Literals(['noop', 'ended', 'closed'])])`.
- `ToolDependencyStatusSchema` moves to the harness's browser-safe
  `/schemas` entry, `ExternalToolCheckResult.status` is its `Type`, and
  texra's `toolPlugin.ts` goes.

Deleted: 5 hand lists (3 + 1 + 2 + 1 + 1 readers), 1 schema module, 1
warning, and the false comment. The fact-spread count falls from 18 pairs to
11 (pairs 3, 4, 5, 6, 9, 10, 17).

Also, `check-fact-spread.mjs` should count `type X = 'a' | 'b' | 'c'` unions
too, or it cannot hold U3's shape (area S's file).

**What we give up.** An order that differs from the copy record's key
order; none of today's lists needs one.

**Change amplification.** "A fourth bypass kind": today
`APPROVAL_BYPASS_KINDS`, `RUN_GRANT_NOUN` and `RUN_GRANT_LABEL` fail to
compile, and `RUN_GRANT_ORDER` silently drops the kind from three surfaces;
after, the compile errors are the whole list.

**Depends on:** none. `ui/copy/` is package A's (R6 rewrites it), and
`FileList` is J9's (lane 4.3).

## U5. Storage owns its copy of llm's turn vocabulary by ruling, but the compile-time gate the ruling relies on is missing for the turn

**Red flags:** two representations of one fact without the check that
keeps them equal; an error the design could define out of existence (a
defect after a billed call).

**Evidence.**

- The ruling: "the stored shape of a model turn … owned by storage rather
  than by `@texra-ai/llm`. A provider SDK or enum change in the package is
  then no stored format change" (`harness/src/shared/schemas/storedTurn.ts:1-15`).
  The one-fact note (§G) states the same for the provider enums, "each
  covered against the catalog by a compile-time check": `AssertNever<Exclude<BackendProviderId, ModelBackend>>`
  (`model/reasoningLevel.ts:65-68`) and the endpoint and region rows
  (`model/modelSettings.ts:42-60`).
- The turn's restated sets have no such check: the five finish reasons
  (`storedTurn.ts:125-131` against `llm/src/turn.ts:264-270`), the three
  media kinds (`:75` against `llm/src/message.ts:33`), the content part kinds
  (`:84-111`) and the tool-result status (`:166` against `message.ts:211`).
  `grep finishReason packages/harness/src` returns the schema and one reader
  (`loop/rows.ts:43`).
- The conversion is untyped. `storedDraft` decodes
  `Schema.decodeUnknownSync(ModelMessagePayloadSchema)(stored(payload))`
  over `unknown` (`agent/runtime/storedTurn.ts:106-124`). An llm that adds a
  finish reason compiles in this repo, and the first turn that ends with it
  throws a defect while the `model.message` row is written, after the
  provider billed the call.

**The design decision behind it.** The ruling was applied to the provider
enums with their gate and to the turn without one.

**The better design.** In `agent/runtime/storedTurn.ts`, where both shapes
are already imported, three `AssertNever<Exclude<llm member, stored member>>`
lines cover the finish reason, the media kind and the content part kind,
written as `reasoningLevel.ts` writes its own. The stored lists stay
storage's. For an embedder running a newer llm against a published harness,
`storedDraft` fails with a typed `RunHistoryInconsistent` naming the value
(the type it already imports), not a defect.

Deleted: nothing. Added: three type lines and one typed failure.

**What we give up.** Nothing. An llm bump that adds a reason then fails
`npm run typecheck`, which is the ruling's intent.

**Change amplification.** "llm adds a finish reason": today 0 files fail
to compile and one fails at run time; after, the typecheck names
`storedTurn.ts:125`.

**Depends on:** none (package E's files; the R9 driver holds
`agent/runtime/`).

## U6. The host's OS as one of three values: two types, a wire literal set, and three narrowings

**Red flags:** repetition; information leakage (each caller narrows
`process.platform` "at their own boundary", by its own comment).

**Evidence.** `OSPlatform = 'darwin' | 'win32' | 'linux'` and
`normalizePlatform` live in the LaTeX constants
(`texra/src/shared/constants/latexToolchain.ts:56-57,709-714`; readers
`:721`, `LatexToolingController.ts:57`, `extension/.../tabs/LaTeXTab.ts:39,72`).
`DesktopPlatform` is the same union (`desktop/src/shared/accelerators.ts:14-20`:
"callers on the Node side narrow `process.platform` into this union at
their own boundary"). Its main-process narrowing restates `normalizePlatform`
line for line (`desktop/src/main/desktopMenuTemplate.ts:26-30`), and the
renderer derives it from `navigator` (`renderer/main.ts:236-241`). The
settings wire spells `Schema.Literals(['darwin', 'win32', 'linux'])`
(`settingsViewMessages.ts:407`). The CLI narrows again, or refuses
(`cli/src/runtime/clipboardImage.ts:236-239`).

**The better design.** One browser-safe `texra/src/shared/osPlatform.ts`
with `OsPlatformSchema` (its `Type` is the union), `osPlatformOf(raw)` for
Node callers and `osPlatformOfNavigator()` for the renderer. The desktop
already imports `@texra/*`. Deleted: `DesktopPlatform`, `HOST_PLATFORM`'s
body, the wire's literal list, and `normalizePlatform` from a LaTeX file.

**What we give up.** Nothing. **Amplification.** "Support a fourth OS":
6 sites in 3 packages today, 1 after. **Depends on:** none. The file is
package C's (`latexToolchain.ts`, I10); land it with or after step 4.4.

## U7. Smaller items (batched)

- **(a) Effect's log severity, mapped four times over an untyped level.**
  `LogEntry` is `ReturnType<typeof Logger.formatStructured.log>`, whose
  `level` is `string` (`harness/src/logger/logSink.ts:30-36`;
  `Logger.d.ts:471-479`), so each sink switches with a `default`: the
  console sink (`logSink.ts:121-141`), VS Code (`extension/src/frontend/vscode/vscodeLogSink.ts:46-62`),
  the view runtime's ERROR/FATAL rewrite (`platform/processRuntime.ts:182-186`),
  and the desktop viewer's `LEVEL_PRESENTATION_KEY` with `?? 'unknown'`
  (`desktop/src/renderer/logsPane.ts:104-111,160`), whose inverse is
  `ENTRY_LEVEL` (`desktop/src/main/desktopAppLog.ts:128-134`). "No
  adaptation" is documented (`logSink.ts:30-35`). Typing the field as
  `Uppercase<LogLevel.Severity>` (`LogLevel.d.ts:85`) would make the four
  switches exhaustive. Thin; it matters at a fifth sink.
- **(b) Provider words copied into the turn's evidence, inside llm.**
  `turn.ts:282-296` restates `openaiResponsesWire.ts:91-112` (status,
  incomplete reason), and `turn.ts:298-313` restates
  `anthropicMessagesWire.ts:13-25` (refusal category). The evidence is "bytes
  … only a provider adapter reads back" (`storedTurn.ts:8-11`), so the wire
  module owns the words and `turn.ts` takes `ResponseSchema.fields.status`
  and `RefusalSchema.fields.category`. Pairs 14 and 15; package E.
- **(c) The CLI classifies a network failure by message text**:
  `/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i`
  (`cli/src/commands/models.ts:42-54`). llm's verdict refuses exactly that
  reading: "a coded cause decides, because undici wraps deterministic
  failures … in the same `fetch failed`" (`llm/src/api/verdict.ts:240-258`,
  `NETWORK_CODES` at `:197`). One site. Export llm's `networkFailed` reading
  or drop the branch.
- **(d) The plugins page's roots, typed twice**:
  `Pick<WorkspaceRoots, 'workspace' | 'config' | 'globalState' | 'globalStorage' | 'storageRoot'>`
  in `texra/src/controllers/settingsView/settingsToolCommands.ts:31-34` and
  `cli/src/chat/tui/forms/PluginsListForm.tsx:40-43`. Export it once beside
  `buildPluginRows` (`pluginRows.ts:33-36`).
- **(e) Install advice for a missing system tool, per host.** The extension
  keeps its own git table, brew / winget / apt-get
  (`extension/src/commands/git/gitCommands.ts:129-135`). The LaTeX
  toolchain's package managers are brew / apt / scoop
  (`latexToolchain.ts:59-60`), and the CLI gives a URL only
  (`cli/src/commands/clone.ts:33,70`). `GIT_DOWNLOAD_URL` is spelled twice
  (`clone.ts:33`, `gitCommands.ts:137`). I10's catalog-as-data is the owner.
- **(f) A vague shared name.** Two `HostFrameSchema`s, a session's host
  snapshot frame (`texra/src/shared/session/sessionFrames.ts:82`) and a
  service attachment's call frame (`controllers/server/hostCalls.ts:118`):
  two facts, one name.
- **(g) `DECLINE_RANK`** (`texra/src/tools/AcceptRunFilesTool.ts:86`) ranks
  the harness's refusal actions by `indexOf`, untyped. A fourth refusal
  ranks −1, the highest. Type it `Record<RefusalDecision['action'], number>`.

## Good modules in this area

- `surfaceDecision.ts` `REQUEST_ACTIONS` (`:63-…`): what each key sends, one
  table for the progress view, the TUI and the headless prompt. U1 extends
  it rather than replacing it.
- The exhaustive copy records shared by the webview and the CLI:
  `RUN_GRANT_NOUN`, `RUN_GRANT_LABEL` and `APPROVAL_POLICY_COPY`
  (`satisfies Record<K, …>`). U4 makes the lists beside them derive from
  them.
- `desktopShellState.ts:8-31`: `WORKBENCH_KIND_META` is the table and the
  tab schema's literals come from its keys.
- `GitTab.ts:36-49`: the commit identity's defaults are decoded from the
  catalog row, not restated.
- `harness/src/utils/system/envFlags.ts:17-44`: one set of "off" spellings
  for every host, written after `=0` meant different things in two hosts.
- `texra/src/utils/system/updateCheck.ts`: one semver rule and record shape
  for the CLI and desktop checks.
- The formatters: `formatCompactDuration`, `formatCompactTokenCount`,
  `truncateWithEllipsis` (`utils/text/stringUtils.ts`) and
  `ui/copy/format.ts` have one home per unit. The CLI's `truncateToWidth`
  counts terminal columns, a different fact.
- The `AssertNever` gates `reasoningLevel.ts:65-68` and
  `modelSettings.ts:42-60`: the pattern U5 copies.
- llm's `resolveCredential` (`credentials.ts:63-72`): one ladder for API keys
  and the GitHub token. U3 gives its answer one runtime spelling.

## Already settled, left alone

- Pair 11 (`run.ts` ~ `openGuiWindow.ts`): two facts, as the one-fact note
  (§G) ruled. The kinds list's duplication is G4.
- `ApiKeyStatus` ↔ `CredentialOrigin` inside llm: O8. U3 adds only the
  copies outside llm.
- `answeredBy` on the request row: E2 and R7 designed it. U1 adds the app
  and CLI side and the disagreement.
- `toErrorMessage` in `llm/src/oauth/support.ts:4`: listed in the
  storage-errors note (line 158). llm's own `causeChain`: kept by PR 14777.
- Host-port error tags whose `message` is `toErrorMessage(cause)`: G10's one
  `HostFailed` (lane 8.3).
- `stringField`/`numberField` in `llm/src/api/failureReply.ts:33-44` and
  `texra/.../subscriptionUsageParsing.ts:128-140`: two boundaries with
  different contracts (the app's takes alias lists and loose numbers), not
  one helper.
- `detectImageTool` (harness) beside `findCommand` (texra): the split is
  stated (`utils/system/toolUtils.ts:1-5`); the module caches are M7's.
- The CLI's `FORCE_COLOR` parsing (`cliContext.ts:155-160`): an external
  convention, not a TeXRA env flag.
- `withPerKeyLane`'s spread: `EFF-ADOPT-per-key-lane-semaphore`.
- The child-environment builders (`inheritedEnv`, `serverEnv`, the git
  helper): `RT-child-environment-one-owner`.
- The settings snapshot names (pair 18): J5, lane 3.4.
- The provider endpoint and console URLs keyed by region
  (`providerPlugins.ts:103-133`, `providerPresentation.ts:46-59`,
  `glmCodingPlanUsageAdapter.ts:17-19`): different URLs for one region
  toggle, and "add a provider" is O9's count.

## Effect-native mapping

Checked against `node_modules/effect` 4.1.2 (`package.json` `"version": "4.1.2"`).

| Finding | What answers it                                                                                                                                          | Declaration checked                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1      | one row field, `Schema.NullOr(Schema.Literals(APPROVAL_BYPASS_KINDS))` (or R7's `answeredBy` union); one pure `offeredGrant` reading                     | `Schema.d.ts:4210` (`NullOr`), `:4188` (`Literals`), `:4147` (`Union`)                                                                                                      |
| U2      | one start field, `Schema.optional(Schema.Union([Schema.Literal('autoApprove'), Schema.Literals(APPROVAL_POLICY_LIMITS)]))`; one pure `launchPolicy`      | `Schema.d.ts:2036` (`optional`), `:2241` (`Literal`), `:4147`, `:4188`                                                                                                      |
| U3      | llm exports `CredentialOriginSchema` (`Schema.Literals`); its `Type` replaces the alias; copy as `Record<CredentialOrigin, …>`                           | `Schema.d.ts:4188`; `Literals` carries `.literals` (`:4156`)                                                                                                                |
| U4      | derivations: `Record.keys` of the exhaustive copy record; `Schema.Literals(...).pick`; `Schema.Union([RunOutcomeSchema, …])`; `Schema.is` for a DOM read | `Record.d.ts:1310` (`keys` returns `Array<K & string>`); `Schema.d.ts:4164` (`pick`), `:4147`, `:1156` (`is`); `RunOutcomeSchema` is `Schema.Enum` (`:2431-2434`, `.enums`) |
| U5      | none: three type-level `AssertNever` lines; `storedDraft` fails with the typed error it already imports instead of `decodeUnknownSync`'s defect          | `Schema.d.ts:1529` (`decodeUnknownSync` throws on failure); `decodeUnknownResult` for the typed path, as `reasoningLevel.ts:79` uses it                                     |
| U6      | `Schema.Literals(['darwin','win32','linux'])` and two pure narrowings                                                                                    | `Schema.d.ts:4188`                                                                                                                                                          |
| U7(a)   | `LogEntry.level` typed from the logger's `options.logLevel`, not the formatter's string                                                                  | `Logger.d.ts:81-87` (`Options.logLevel: LogLevel.LogLevel`), `:350` (`Logger.make`), `:471-479` (`formatStructured`'s `level: string`); `LogLevel.d.ts:85` (`Severity`)     |
| U7(b)   | the turn's evidence takes the wire struct's field schemas                                                                                                | a `Schema.Struct`'s `.fields` (used today at `llm/src/turn.ts:261`, `IdentitySchema.fields.providerResponseId`)                                                             |
| U7(c–g) | none: plain TypeScript (an exported reading, a type alias, a catalog row, a rename, a typed record)                                                      | —                                                                                                                                                                           |
