/**
 * `host.request` (PRD one-fold-three-renderers, section 8.3): a capability
 * the host performs on the surface's behalf, mapped onto the process
 * services and the `@hosts/*` ports. Components dispatch one arm as the detail of a
 * `host-request` event (`uiEvents.ts`); the root forwards it over the
 * bridge under a `session` and a `requestId`, answered by 8.4.
 *
 * Only the arms the shell components dispatch are declared; each new
 * component adds its arm here with its first dispatch.
 */
import { Schema } from 'effect';

import { CredentialSwitchSchema, RunIdSchema } from '@texra-ai/harness/schemas';
import {
  CurrentFileTypeSchema,
  DocumentFileTypeSchema,
} from '@texra/shared/launcher/fileTypes';
import { SettingsTargetSchema } from '@texra/shared/settingsView/settingsTarget';

import { LaunchSurfaceSchema } from './surface';

const GettingStartedActionSchema = Schema.Literals([
  'createSampleProject',
  'cloneOverleaf',
  'downloadArxiv',
]);
export type GettingStartedAction = typeof GettingStartedActionSchema.Type;

const runScoped = { runId: RunIdSchema };

export const HostRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('openFile'),
    path: Schema.String.check(Schema.isMinLength(1)),
    line: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal('openLabel'), label: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('openRunStorage'), ...runScoped }),
  Schema.Struct({ kind: Schema.Literal('exportTranscript'), ...runScoped }),
  /** Relaunch a settled run: a workflow through the host's launcher with
   *  its run id, a tool-use run through the resume port. */
  Schema.Struct({ kind: Schema.Literal('resume'), ...runScoped }),
  /** The launch form, opened on a settled run's setup (Run again…). */
  Schema.Struct({ kind: Schema.Literal('runAgain'), ...runScoped }),
  /**
   * Fork: a new task holding this conversation up to `at` (its latest
   * settled point when absent), continued and shown; with `draft` (Fork
   * from here), the message it was cut before waits in its composer, with
   * the files it attached (`mediaFiles`).
   */
  Schema.Struct({
    kind: Schema.Literal('fork'),
    ...runScoped,
    at: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ),
    draft: Schema.optional(Schema.NullOr(Schema.String)),
    mediaFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  /** The latexFixer follow-up over a workflow run's compile failures. */
  Schema.Struct({ kind: Schema.Literal('runCompileFixer'), ...runScoped }),
  /** A retry on the user's own API key: the host stores one, then settles
   *  the pending retry on personal credentials. `credentialSwitch` is the
   *  move the retry request carried, as the run decided it. */
  Schema.Struct({
    kind: Schema.Literal('useOwnApiKey'),
    ...runScoped,
    requestId: Schema.String.check(Schema.isMinLength(1)),
    credentialSwitch: CredentialSwitchSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('latexdiff'), ...runScoped }),
  Schema.Struct({ kind: Schema.Literal('pack'), ...runScoped }),
  Schema.Struct({ kind: Schema.Literal('clean'), ...runScoped }),
  /** The Tools sheet's LaTeXDiffs verbs over the launcher's base and
   *  edited files and its commit, as the sheet's surface holds them. */
  Schema.Struct({
    kind: Schema.Literal('latexdiffs'),
    baseFile: Schema.optional(Schema.NullOr(Schema.String)),
    editedFile: Schema.optional(Schema.NullOr(Schema.String)),
    commit: Schema.optional(Schema.NullOr(Schema.String)),
    action: Schema.Literals([
      'latexdiff',
      'latexdiffvc',
      'packLatexdiffvc',
      'cleanLatexdiffvc',
      'merge',
      'compare',
      'accept',
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal('record'),
    action: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('start'),
        target: Schema.Union([RunIdSchema, Schema.Literal('launch')]),
      }),
      Schema.Struct({ kind: Schema.Literal('stop') }),
    ]),
  }),
  Schema.Struct({ kind: Schema.Literal('popOut') }),
  Schema.Struct({ kind: Schema.Literal('popBack') }),
  Schema.Struct({ kind: Schema.Literal('refreshCommits') }),
  Schema.Struct({ kind: Schema.Literal('refreshFiles') }),
  /** Settings at a target, or where it last was when `target` is absent
   *  (the header's gear). */
  Schema.Struct({
    kind: Schema.Literal('openSettings'),
    target: Schema.optional(Schema.NullOr(SettingsTargetSchema)),
  }),
  /** The launcher's pickers: `fileType` chooses the dialog and names the
   *  `Surface.launch` field the paths return to. */
  Schema.Struct({
    kind: Schema.Literal('pickFiles'),
    fileType: CurrentFileTypeSchema,
  }),
  /** The current editor file into a launcher field. */
  Schema.Struct({
    kind: Schema.Literal('useCurrentFile'),
    fileType: CurrentFileTypeSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('addOpenedFiles'),
    fileType: DocumentFileTypeSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('attachDroppedFiles'),
    paths: Schema.Array(Schema.String),
    category: DocumentFileTypeSchema,
  }),
  /** The launcher's Send: the surface's selections and the instruction the
   *  composer holds; the host validates them and runs. */
  Schema.Struct({
    kind: Schema.Literal('launch'),
    launch: LaunchSurfaceSchema,
    instruction: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('polish'), text: Schema.String }),
  /** A pasted image, stored host-side; the outcome names the file the
   *  follow-up's `mediaFiles` then carries. */
  Schema.Struct({
    kind: Schema.Literal('savePastedImage'),
    fileName: Schema.String.check(Schema.isMinLength(1)),
    base64: Schema.String.check(Schema.isMinLength(1)),
  }),
  /** The desktop editor pane's file I/O on the session's workspace: a
   *  directory's entries, a file's contents, or a write. */
  Schema.Struct({
    kind: Schema.Literal('workspaceFile'),
    action: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('list'), directory: Schema.String }),
      Schema.Struct({ kind: Schema.Literal('read'), path: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal('write'),
        path: Schema.String,
        contents: Schema.String,
        /** What the editor last read from the file: the write lands only
         *  while the file still holds it (else `changedOnDisk`). Null
         *  overwrites whatever is there. */
        base: Schema.NullOr(Schema.String),
      }),
    ]),
  }),
  /** A tool-edit prompt's verbs over the preview the host staged: the
   *  approval applies the proposed file as the user left it, so the host
   *  reads the edit back and sends the `request.decide` itself; the others
   *  open editors and leave the approval pending. A reject reads nothing off
   *  the preview, so it is a plain `request.decide` on every host. */
  Schema.Struct({
    kind: Schema.Literal('toolEdit'),
    requestId: Schema.String.check(Schema.isMinLength(1)),
    action: Schema.Literals([
      'approve',
      'openDiff',
      'previewProposed',
      'showLatexdiff',
    ]),
  }),
  /** An output file's verbs on a workflow run's file list. */
  Schema.Struct({
    kind: Schema.Literal('fileAction'),
    ...runScoped,
    action: Schema.Literals([
      'compareOriginal',
      'comparePrevious',
      'latexdiff',
      'accept',
      'merge',
    ]),
    file: Schema.String.check(Schema.isMinLength(1)),
    base: Schema.optional(Schema.NullOr(Schema.String)),
    prev: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  // The New-task state's banners and onboarding cards (host-owned state,
  // HostSnapshot.banners and .onboarding).
  Schema.Struct({
    kind: Schema.Literal('apiKeyBanner'),
    action: Schema.Literals(['set', 'guide']),
  }),
  Schema.Struct({
    kind: Schema.Literal('agentConfigBanner'),
    action: Schema.Literals(['edit', 'dir', 'docs']),
    customDirSet: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
  Schema.Struct({ kind: Schema.Literal('recheckDependencies') }),
  Schema.Struct({
    kind: Schema.Literal('openInstallGuide'),
    tool: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('dismissBanner'),
    banner: Schema.Literals(['gettingStarted', 'dependency']),
  }),
  Schema.Struct({
    kind: Schema.Literal('gettingStarted'),
    action: GettingStartedActionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('onboarding'),
    action: Schema.Literals([
      'signInChatGpt',
      'setApiKey',
      'skip',
      'runSetup',
      'skipSetup',
      'openGettingStarted',
    ]),
  }),
]);
export type HostRequest = typeof HostRequestSchema.Type;

/** What a `pack` or `clean` did, as the host presents it. */
export type FileOpResult =
  | {
      readonly status: 'success';
      /** The packed copy's folder. */
      readonly outputFolder?: string;
    }
  | { readonly status: 'noFiles' }
  | { readonly status: 'missingParams' }
  | { readonly status: 'error'; readonly error: string };
