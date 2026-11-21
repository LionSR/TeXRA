# Host copy left open by the 2026-11-20 hosts pass

Date: 2026-11-20
Status: proposed
Origin: a find-simplification pass over the hosts and the UI
(`packages/texra/src/ui/`, `packages/texra/src/controllers/`,
`packages/extension/src/`, `packages/desktop/src/`, `packages/cli/src/`) on
`main` at `56a555c`. It compared every string literal of four words or more
across the five trees (exact and near matches), exported symbols with no
production reader, one-caller modules under seventy lines, and repeated
six-line windows of code.

The same series lands what had one clear owner: `/resume all` reads the
view itself (the CLI-only `ui/copy/interruptedTasks.ts`, two of whose four
fields had no reader, is gone); two exports read only in their own file
stop being exports; VS Code's API key prompt names
the provider as every other surface does (`PROVIDER_KEY_COPY`); the
terminal's two account panels share one key row; and two one-caller host
modules move into their caller. What follows needs a decision.

## Open

1. **What the API key choice says it reaches.** Taken on 2026-11-21: the
   terminal's key row reads `ONBOARDING_CHOICE_API_KEY.description`, which
   names the providers the way the terminal did ("Anthropic, OpenAI, Google,
   DeepSeek, and more"). The extension's walkthrough step and the guide pages
   are static text and still say "Anthropic, OpenAI, Google, and more".
2. **A provider's name by region.** `getProviderDisplayName`
   (`packages/texra/src/model/providerPresentation.ts`) names Qwen "Bailian"
   when its region toggle picks the China platform; the settings key list,
   the key prompts and now VS Code's key commands read it. The terminal's
   key forms (`ApiKeyEntryForm.tsx`, `ProviderApiKeyForm.tsx`), its API
   status (`apiStatus.ts`), its coding-plan warning
   (`modelAccessSelection.ts`) and the web retry card's rejection
   (`ProgressApiKeyRetryController.ts`) call llm's `providerDisplayName`,
   so one key reads "Bailian" in Settings and "Qwen" in the terminal. The
   region-aware read is an Effect over the settings stores; the terminal
   forms render synchronously. Decision: whether the platform name is worth
   an Effect read in each of those sites, or whether "Bailian" should only
   appear beside the region toggle.

## Checked and declined

- **`cliErrorMessage`** (`packages/cli/src/runtime/platform/logSinks.ts`)
  only returns `toErrorMessage(error)`, but inlining its seven calls adds
  four files to `toErrorMessage`'s count in `npm run check:fact-spread`.
  The alias is the CLI's one owner of how a caught failure prints; the
  CLI files that call `toErrorMessage` directly are the ones to move onto
  it, not the other way round.
- **`textDisplayWidth`** (`packages/cli/src/runtime/terminal/terminalText.ts`)
  only calls `string-width`, but it is the CLI's one import of that package
  across eleven files, beside the module's other width helpers over
  `slice-ansi` and `cli-truncate`; inlining it would spread the dependency.
- **`renderIconActionButton` and its three siblings**
  (`packages/texra/src/ui/wa/actionButtons.ts`) each forward to one base
  function, but each narrows the options type (icon-only versus labelled),
  so the four names are the type check, not pass-throughs.
- **The task-file rejection wording.** `TaskFilesRejected.message`
  (`packages/texra/src/controllers/session/taskFiles.ts`) and the headless
  `usageMessage` (`packages/cli/src/runtime/headless/documentTaskInputs.ts`)
  word the same reasons, but the CLI names the flag (`--input: file not
  found`) where a window names the role; one decision, two vocabularies.
- **`runGuardedLatexCommand`'s `saveDocument`** varies (two commands save
  first, two read the file on disk), so it is a real option.
