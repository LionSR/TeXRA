# Responsibility audit: what the 2026-11-25 run left open

Date: 2026-11-25
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `37a22c5`. It started from item 4 of
[`2026-11-23-responsibility-audit-left-open.md`](2026-11-23-responsibility-audit-left-open.md)
(the models a person can enable, listed twice) and three read-only
comparisons: the terminal against the app, the two GUI hosts against each
other, and the harness and llm against themselves. Two open PRs (#15229,
#15230) rewrite about 430 files, so a finding whose fix edits one of them was
left for after they merge.

The PR that adds this note lands eleven findings, one commit each: the
enableable-model catalog, `TEXRA_MODEL`'s spellings, `texra init`'s default
model and its `texra.chat.model` copy, the subscription account's name, the
missing-key sentence, the spend figure a model reads, the JSON parse-error
cleaner, text on one line, the palette category, the supported Node range,
and the log line of a notice that could not be shown.

## Open

1. **A sign-in prompt that cannot be shown is handled by each GUI host.**
   The presenter port
   (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`)
   gives `presentDeviceCode` an empty error channel, so each host reports
   its own failure, and they differ. The extension
   (`packages/extension/src/frontend/auth/subscriptionSignIn.ts`) logs it
   and shows a toast; the desktop (`reportPresentation`,
   `packages/desktop/src/main/desktopSettingsIpc.ts`) shows a dialog and
   logs nothing. A failed copy of the sign-in link is `HostFailed` in the
   extension, so the flow falls back to a device code as the port's comment
   says; the desktop copies on a spawned fiber after the link opened, so the
   flow never sees the failure. Only the extension confirms a copied link
   (`SIGN_IN_PROMPT.linkCopied`). Proposed: the presenters fail with an
   error, `signIn` races a device-code presenter's failure against the poll
   and ends the sign-in with `SubscriptionSignInFailed`, which the settings
   body already logs and shows on both hosts; both host catches go.
   Decision: a prompt that cannot be shown ends the sign-in instead of
   leaving the poll running. Item 2 of
   `2026-11-24-subscription-sign-in-presenters-left-open.md` records the
   empty channel as deliberate, so this reverses it.
2. **Which tools need an editor is listed by name in the terminal.**
   `EDITOR_TOOLS` (`packages/cli/src/runtime/cliEntryAgent.ts`) names six
   tools to strip from a terminal launch; they are exactly the tools that
   declare a `hostCapability`, which the harness already withholds at every
   step when the host does not serve it
   (`packages/harness/src/agent/runtime/agentToolResolution.ts`). The strip
   also changes what the run records: a conversation started in the terminal
   never gets those tools when a GUI window later continues it. Decision:
   delete the strip and rely on the capability, or derive the list from the
   declarations.
3. **Which image types a model takes.** The harness treats any `image/*`
   as an image part (`isImageMimeType`,
   `packages/harness/src/utils/files/mimeUtils.ts`); llm accepts PNG, JPEG,
   WEBP and GIF (`ImageMimeTypeSchema`, `packages/llm/src/api/parts.ts`) and
   fails the turn as `invalid-request` for anything else. A `.bmp` or `.svg`
   attachment passes the harness's check and fails the model call. The
   harness should read llm's set, which needs an export from
   `packages/llm/src/index.ts`, a file #15229 edits.
4. **The terminal words "no model can run" four ways**
   (`packages/cli/src/runtime/models/modelAccess.ts` twice,
   `packages/cli/src/runtime/doctor.ts`,
   `packages/cli/src/runtime/models/launchDefaults.ts`). The last one sends
   a person with an unknown `--model` to `texra models list`, which lists
   only enabled models that can run, while `--model` takes any catalog id
   (`texra models list --all`).
5. **Which finished run each GUI host announces** (item 1 of the
   2026-11-23 note) is still open. The extension's chime filter reads
   `isDocumentTaskRun`, which #15229 deletes; decide the rule after it
   merges.
6. **The OpenAI ambient-header rejection is stated once per Responses
   transport** (`packages/llm/src/api/openaiResponses.ts`,
   `packages/llm/src/api/openaiResponsesWebSocket.ts`): the same
   environment variable and sentence. Low value; state the pair beside
   `openaiClient`.

## Checked and declined

- **`texra models list --all` lists unserved models.** It is an access
  listing that says why each model cannot run, not the list a person
  enables from.
- **A relative plugin source.** Inside the terminal `texra plugin install`
  and `/plugins add` agree, since the CLI's workspace root is its working
  directory. The settings page's home-directory fallback is a GUI fact.
- **The fatal-error sentence** differs between the extension and the
  desktop, but so does what each does next (rethrow to Node, quit the app),
  and both already share `formatFatalErrorDetail`.
- **"File not found" before a build display** is checked by each GUI host;
  the LaTeX branches after it differ for real (LaTeX Workshop against
  `compileForDisplay`), so a shared check would take the non-LaTeX branch
  with it.
