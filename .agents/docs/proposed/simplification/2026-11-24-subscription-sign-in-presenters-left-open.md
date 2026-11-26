# Subscription sign-in presenters: what the 2026-11-24 run left open

Date: 2026-11-24
Status: proposed

Origin: continuing item 2 of
[`2026-11-23-responsibility-audit-left-open.md`](2026-11-23-responsibility-audit-left-open.md)
(the subscription device-code prompt written three times) and item 4 of
[`2026-11-23-layer-audit-left-open.md`](2026-11-23-layer-audit-left-open.md)
(the loopback error naming a fixed port). Read on `main` at `dda1913`.

## Landed with this note

**The device-code fallback line is the flow's to decide.** The sentence
"Could not open a browser callback — sign in with a one-time code instead"
(`SIGN_IN_PROMPT.deviceCodeFallback`) was decided by each host, and the
hosts had drifted: the desktop always led with it, and the extension never
showed it, so a local VS Code window whose loopback ports were taken dropped
to a device code with no word of why. Only `signIn`
(`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`) knows
whether a device code is a fallback (the loopback browser could not be
reached) or what the host asked for outright. `presentDeviceCode` now takes a
`reason`: the fallback sentence on the fallback path, `undefined` on the
explicit-device path. Each host shows it ahead of the steps. Folded in: the
duplicated "could not copy the sign-in code" warning is one
`SIGN_IN_PROMPT.codeCopyFailed`, and the no-device-code error no longer names
a fixed callback port (llm's `CHATGPT_CALLBACK_PORTS` binds `[1455, 0]`, so an
ephemeral port is possible).

## Open

1. **The device-code dialog is still rendered by each GUI host.** With the
   fallback line and the copy-fail warning now shared, the extension
   (`vscodePresenter.presentDeviceCode`,
   `packages/extension/src/frontend/auth/subscriptionSignIn.ts`) and the
   desktop (`presentSubscriptionDeviceCode`,
   `packages/desktop/src/main/desktopSignInPresenters.ts`) share the same
   shape: copy the code, build the steps, show one dialog with an "open
   verification page" button. They differ only in the dialog primitive
   (`vscodeUi.ask` returning a label vs `choose` returning the chosen value).
   A shared presenter would need a common one-button GUI dialog abstraction
   the two hosts do not have today; the CLI's is a progress-sink write, a
   third render model that does not fit "a clipboard write and an ask with one
   button." Collapsing the two GUI copies is worth doing only alongside a
   shared GUI dialog helper, and is the owner's call on whether that helper
   should exist. The remaining duplication is the dialog scaffolding, not a
   decided fact.

2. **"A failed presentation never aborts the sign-in" is enforced by the port
   type, not stated.** `presentDeviceCode`'s channel is `Effect<void>` (no
   error), so a presentation failure cannot abort; `presentSignInUrl`'s is
   `Effect<void, Cancelled | HostFailed>`, where `Cancelled` is the user
   backing out (an intended abort) and `HostFailed` means the browser could
   not be reached (the flow falls back). The desktop's `reportPresentation`
   (`desktopSettingsIpc.ts`) and the extension's `Effect.catch` both satisfy
   the empty channel. No drift remains here; the rule lives in the port's
   error channels. Recorded so the responsibility note's third sentence is not
   re-mined.
