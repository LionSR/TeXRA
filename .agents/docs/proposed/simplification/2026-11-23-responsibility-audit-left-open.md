# Responsibility audit: what the 2026-11-23 run left open

Date: 2026-11-23
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `6b29e26`. It started from item 2 of the 2026-11-22 note (the
set-key verb bound twice) and a read-only comparison of the two GUI hosts'
halves (`packages/extension/src`, `packages/desktop/src/main`) for rules
each decides that the shared app code should decide once.

The PR that adds this note lands five findings:

- **A notice's buttons.** Each GUI host bound "ask for a provider API key"
  and "open a guide page" a second time for `windowNotices`. The window
  body (`openGuiWindow.ts`) now builds the notices from its own binding
  table; a host supplies its message with buttons (`ask`) and how it shows
  a file a run opens. `setApiKey`'s type names the one service it reads,
  the key store, which the body hands to the notice's fiber.
- **What a config file's open found wrong.** `openProjectRoots` returned
  the warnings and each caller logged and showed them its own way; the
  desktop never showed the global file's. `openProjectRoots` and
  `openGlobalConfig` (`openProjectSession.ts`) take the host's `warn` and
  do both.
- **The tool-edit notices' log.** Only the extension logged them. The
  controller (`ToolEditApprovalController.ts`) logs each and the host port
  is a plain `notify`.
- **A settings file that will not open** was reported by the settings body
  and again by the desktop's binding.
- **`docsPage`** on `Rejected` and on the error notice had three readers
  and, since the merge program went, no writer. Removed.

## Open

1. **Which finished run each GUI host announces** (item 1 of
   `2026-11-19-responsibility-audit-left-open.md`) has a second half: the
   `chime` surface action (`packages/texra/src/shared/session/sessionFrames.ts`)
   is sent only by the extension
   (`packages/extension/src/progressView/ProgressViewProvider.ts`), so the
   desktop renderer holds the code that plays it and never does. Both
   hosts start from `attentionOf` and filter `finished` themselves. Once
   the rule is decided, the window body, which holds `bridge.surfaceAction`,
   sends the chime and each host keeps only its own presentation (badge,
   OS notification).
2. **The subscription device-code prompt is written three times**
   (`packages/extension/src/frontend/auth/subscriptionSignIn.ts`,
   `packages/desktop/src/main/desktopSignInPresenters.ts`,
   `packages/cli/src/runtime/models/subscriptionLogin.ts`). The two GUI
   copies share the copy-then-log step and its log sentence word for word,
   and have drifted: the desktop always leads with
   `SIGN_IN_PROMPT.deviceCodeFallback`, which is wrong when a device code
   was asked for and missing from the extension when its loopback ports
   were taken; whether it applies is a fact only `signIn`
   (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`)
   holds. A failed presentation aborts the extension's browser sign-in and
   never the desktop's (`reportPresentation` in `desktopSettingsIpc.ts`).
   Proposed: `signIn` composes the device-code message and applies "a
   failed presentation never aborts the sign-in"; a presenter is a
   clipboard write and an ask with one button. It changes the presenter
   port for all three hosts, so it is a change of its own.
3. **The Overleaf clone's outcome is mapped twice**
   (`packages/extension/src/commands/git/gitCommands.ts`,
   `packages/cli/src/commands/clone.ts`). Both switch over
   `OverleafCloneOutcome` with `CLONE_COPY` and disagree: an invalid token
   offers the token guide only with a `tokenHint` in the extension and
   always in the terminal, and an authentication failure keeps the
   `authFailed` headline only in the terminal. Proposed: the clone module
   answers each outcome as a message and its links, which a host renders
   as buttons or as lines.
