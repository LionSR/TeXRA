# Host-layer collapse: two UIs, one controller layer, three transports

Date: 2026-09-20
Status: implemented — steps 1–7 landed in #12903, #12922, #12839, #12910, #13057, #12938 and #12935, with a `ConfigProvider` swap refused as EFF-ADOPT-config-provider; the remaining shutdown order (#13179) and desktop handlers-as-programs (#13168) are open PRs, not open design.
Archived: 2026-09-25
Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../../proposed/architecture/2026-09-20-post-refactor-architecture-survey.md).
Continues the 2026-09-09
[host-shared controllers](../../proposed/architecture/2026-09-09-host-shared-controllers-on-effect.md)
note, of whose 19 steps 3 have landed; this note re-costs the open ones and
adds the two it excluded (auth and the settings registries).

### Dispatcher decision update — 2026-09-22

The owner's [#13009 clarification](https://github.com/LionSR/TeXRA/pull/13009#issuecomment-5779248081)
revises the shared-contract ruling: one backend Effect registry, executed at
each native host message entry, may replace the old Promise dispatcher and
per-arm runners together. The shared browser dispatcher continues to apply
synchronous state updates. The
[ruling's consumer and failure audit](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md#settings-dispatch-has-one-native-execution-boundary-revised-2026-09-22)
is part of this decision.

This supersedes #12880's instruction to preserve each Promise registry arm
and #12884's instruction to remove the controller-local settings-dispatch
slice unless re-ruled. The explicit re-ruling is now recorded; #13009 still
owes its implementation checks. This does not mark catalog-derived settings
registries, unrelated host-collapse work, or either tracker complete.

## 1. Finding

The three hosts total 117k lines, but 29k of the extension is the webview UI
library the desktop imports, so there are two UI implementations, not three.
Below them, product logic is written more than once:

| Concern                                                      | Written                                                                                                                                                                               | Lines overlapping |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `host.request` dispatch                                      | the same 42-arm switch in `extensionHostRequests.ts` and `desktopHostRequests.ts`, same case order; `sharedHostRequests.ts` covers 13 arms                                            | ~700              |
| Supabase sign-in                                             | three PKCE, pending-state and nonce state machines (`SupabaseAuthProvider.ts` 949, `desktopSupabaseAuth.ts` 569, CLI loopback + device code 915); only the callback transport differs | ~1 500            |
| Settings registries                                          | ~40 rows of `runtime.runPromise(sharedController.x())` in each of two hosts, although `stateSettings.ts` already declares `hosts`, `slots`, `honoredBy` and `onWrite`                 | ~1 400            |
| Bootstrap                                                    | three bodies making the same nine post-`initPlatform` calls in three orders, each commented as mirroring another                                                                      | ~250              |
| Credential-change fan-out, provider-key entry, API-key retry | four copies, a CLI-only `providerApiKey.ts`, a CLI-only queue in `subscribeApprovals.ts`                                                                                              | ~350              |
| Onboarding funnel                                            | two identical five-step loops plus a CLI variant                                                                                                                                      | ~70               |

The load-bearing fact: `src/hosts/uiHosts.ts` has no CLI implementation at
all, which is why 10 of 13 controllers in `src/controllers/` serve only two
hosts and why the CLI re-implements chat submit, credential switching and the
retry queue.

Hop counts for one setting write: 3 in the CLI, 9 in the extension, 11 on
the desktop; 4 of 9 and 5 of 11 are pure pass-through. The desktop's inbound
IPC is a chain of seven handlers each `safeParse`ing the full message.

Five ports have exactly one implementation (`TerminalRunner`,
`ToolMissingHandler`, `ConfigProvider`, `LifecycleHost`, `WorkspaceRoots`).

## 2. Changes, in unlock order

1. **Give the CLI the five `uiHosts` ports** (an Ink `MessageHost`,
   `PromptHost`, `ExternalOpener`, `DiffViewHost` no-op, ~200 lines). Turns
   `src/controllers/` into a three-host layer; deletes `providerApiKey.ts`,
   the credential-switch half of `subscribeApprovals.ts`, the fourth
   `invalidateApiKeyCache` fan-out. Keep the TUI's one-modal-at-a-time
   promotion and its per-request wording.
2. **One Supabase sign-in coordinator over a three-member
   `AuthCallbackTransport`**, modelled on `SubscriptionSignInPresenter`, which
   already collapsed the ChatGPT and Grok flow across all three hosts. Keep
   `vscode.AuthenticationProvider` registration, the Electron protocol
   handler with its single-instance queue, and the CLI loopback and
   device-code fallback.
3. **One `host.request` body with two binding tables.** Extend
   `sharedHostRequests.ts` to ~35 arms; each host keeps only the arms it
   truly performs (file pickers, tab pop-out, Copilot access, inline
   criticism).
4. **Derive the settings registries from the catalog.** `StateSettingEntry`
   already declares `slots` and `honoredBy` (the old `hosts` field was
   replaced by those and `surfaces`), which is enough to generate the
   setting-row handlers and their per-host `unsupported(...)` arms. The
   non-setting commands (Copilot model access, extension installation) have
   no row at all, so they need an explicit command-capability catalog first,
   or keep their hand-written host bindings. Adopt the desktop's
   `...controller.handlers` spread; the two registries become two short
   tables.
5. **One bootstrap `Effect.fn`** owning the order of the nine post-init
   calls; one `runPromise` per root. Also fixes the live defect that the
   usage log is disposed in a different shutdown phase per host: the shared
   bootstrap disposes the process runtime in one order, and the usage-log
   drain runs as the `UsageLog` layer's finalizer there (candidate P2 of the
   [ownership ledger](./2026-09-20-service-scope-ownership-ledger.md)),
   so no host calls `UsageLogService.dispose()` by hand and no interim
   unified call is built only to be deleted. `initPlatform` itself stays per
   host (ESLint pins composition roots).
6. **Replace the desktop's try-each handler chain with one route table**
   keyed off `desktopCommandSurface.ts`; delete the `WEBVIEW_READY` "return
   false so siblings see it" case.
7. Delete or fold the five one-implementation ports.

## 3. Not re-proposed

Rejected in `.agents/docs/rejected/architecture/`: `ToolEditApprovalController.attach`
owning `interactions.use`; the `cliState` and `Surface` merger; the
`sessionActivity` and `describeRequestRefusal` merges; the runtime-host
decoupling PRD.

## 4. Acceptance

- `src/hosts/uiHosts.ts` has three implementations of every port.
- `extensionHostRequests.ts` and `desktopHostRequests.ts` contain no arm
  whose body also exists in `sharedHostRequests.ts`.
- One PKCE bind, one pending-state store, one nonce check in the tree.
- One shutdown order; the usage-log drain runs in the runtime's finalizer on
  every host and no host calls `UsageLogService.dispose()`.
- Net host lines down by at least 2 500.
