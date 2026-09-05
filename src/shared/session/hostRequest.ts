/**
 * `host.request` (PRD one-fold-three-renderers, section 8.3): a capability
 * the host performs on the surface's behalf, mapped onto `platform()` and
 * the `@hosts/*` ports. Components dispatch one arm as the detail of a
 * `host-request` event (`uiEvents.ts`); the root forwards it over the
 * bridge under a `session` and a `requestId`, answered by 8.4.
 *
 * Only the arms the shell components dispatch are declared; each new
 * component adds its arm here with its first dispatch.
 */
import { z } from 'zod';

import {
  AgentProposalSchema,
  CurrentFileTypeSchema,
  DocumentFileTypeSchema,
  GettingStartedActionSchema,
  SessionTypeSchema,
  StreamTabIdSchema,
} from '@shared/schemas';

import { LaunchSurfaceSchema } from './surface';

const streamScoped = { streamId: StreamTabIdSchema };

export const HostRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('openFile'),
    path: z.string().min(1),
    line: z.int().positive().nullish(),
  }),
  z.object({ kind: z.literal('openSpillArtifact'), spillPath: z.string() }),
  z.object({ kind: z.literal('openLabel'), label: z.string() }),
  z.object({ kind: z.literal('openTaskStorage'), ...streamScoped }),
  z.object({ kind: z.literal('exportTranscript'), ...streamScoped }),
  z.object({ kind: z.literal('restoreIntoLauncher'), ...streamScoped }),
  /** Relaunch a settled run: a workflow through the host's launcher with
   *  its execution id, a tool-use run through the resume port. */
  z.object({ kind: z.literal('resume'), ...streamScoped }),
  /** A fresh run from a settled run's setup. */
  z.object({ kind: z.literal('runNew'), ...streamScoped }),
  /** The latexFixer follow-up over a workflow run's compile failures. */
  z.object({ kind: z.literal('runCompileFixer'), ...streamScoped }),
  /** A retry on the user's own API key: the host stores one, then settles
   *  the pending retry on personal credentials. */
  z.object({
    kind: z.literal('useOwnApiKey'),
    ...streamScoped,
    requestId: z.string().min(1),
    model: z.string().nullish(),
    provider: z.string().nullish(),
    exhaustionReason: z.string().nullish(),
    kimiCodeRoutedOnFailure: z.boolean().nullish(),
  }),
  z.object({ kind: z.literal('latexdiff'), ...streamScoped }),
  z.object({ kind: z.literal('pack'), ...streamScoped }),
  z.object({ kind: z.literal('clean'), ...streamScoped }),
  /** The Tools sheet's LaTeXDiffs verbs over the launcher's base and
   *  edited files and its commit, as the sheet's surface holds them. */
  z.object({
    kind: z.literal('latexdiffs'),
    baseFile: z.string().nullish(),
    editedFile: z.string().nullish(),
    commit: z.string().nullish(),
    action: z.enum([
      'latexdiff',
      'latexdiffvc',
      'packLatexdiffvc',
      'cleanLatexdiffvc',
      'merge',
      'compare',
      'accept',
    ]),
  }),
  z.object({
    kind: z.literal('record'),
    action: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('start'),
        target: z.union([StreamTabIdSchema, z.literal('launch')]),
      }),
      z.object({ kind: z.literal('stop') }),
    ]),
  }),
  z.object({ kind: z.literal('popOut') }),
  z.object({ kind: z.literal('popBack') }),
  z.object({ kind: z.literal('openDashboard') }),
  z.object({ kind: z.literal('refreshCommits') }),
  z.object({ kind: z.literal('refreshFiles') }),
  z.object({
    kind: z.literal('openSettings'),
    section: z.enum(['agents', 'teams', 'models']),
    sessionType: z.enum(['toolUse', 'workflow']).nullish(),
  }),
  /** The launcher's pickers: `fileType` chooses the dialog and names the
   *  `Surface.launch` field the paths return to. */
  z.object({
    kind: z.literal('pickFiles'),
    fileType: CurrentFileTypeSchema,
  }),
  /** The current editor file into a launcher field. */
  z.object({
    kind: z.literal('useCurrentFile'),
    fileType: CurrentFileTypeSchema,
  }),
  z.object({
    kind: z.literal('addOpenedFiles'),
    fileType: DocumentFileTypeSchema,
  }),
  z.object({
    kind: z.literal('attachDroppedFiles'),
    paths: z.array(z.string()),
    category: DocumentFileTypeSchema,
  }),
  /** The launcher's Send: the surface's selections and the instruction the
   *  composer holds; the host validates them and runs. */
  z.object({
    kind: z.literal('launch'),
    launch: LaunchSurfaceSchema,
    instruction: z.string(),
  }),
  z.object({ kind: z.literal('polish'), text: z.string() }),
  /** A pasted image, stored host-side; the outcome names the file the
   *  follow-up's `mediaFiles` then carries. */
  z.object({
    kind: z.literal('savePastedImage'),
    fileName: z.string().min(1),
    base64: z.string().min(1),
    mediaType: z.string().min(1),
  }),
  z.object({ kind: z.literal('compileInputPdf') }),
  z.object({ kind: z.literal('extractFigures') }),
  /** A tool-edit prompt's verbs over the preview the host staged: the
   *  approval applies the proposed file as the user left it, so the host
   *  settles it; the others open editors and leave the approval pending. */
  z.object({
    kind: z.literal('toolEdit'),
    requestId: z.string().min(1),
    action: z.enum([
      'approve',
      'reject',
      'openDiff',
      'previewProposed',
      'showLatexdiff',
    ]),
    feedback: z.string().nullish(),
  }),
  /** The sidebar port reports which state it shows, for the view-title
   *  menus that differ between the New-task state and a conversation. */
  z.object({
    kind: z.literal('setActiveView'),
    view: z.enum(['main', 'progress']),
  }),
  /** An output file's verbs on a workflow run's file list. */
  z.object({
    kind: z.literal('fileAction'),
    ...streamScoped,
    action: z.enum([
      'compareOriginal',
      'comparePrevious',
      'latexdiff',
      'accept',
      'merge',
    ]),
    file: z.string().min(1),
    base: z.string().nullish(),
    prev: z.string().nullish(),
  }),
  /** The "Restore setup" link on a settled proposal row. */
  z.object({
    kind: z.literal('restoreProposalConfig'),
    proposal: AgentProposalSchema,
  }),
  // The New-task state's banners and onboarding cards (host-owned state,
  // HostSnapshot.banners and .onboarding).
  z.object({
    kind: z.literal('apiKeyBanner'),
    action: z.enum(['set', 'guide']),
    provider: z.string().nullish(),
  }),
  z.object({
    kind: z.literal('agentConfigBanner'),
    action: z.enum(['edit', 'dir', 'docs']),
    sessionType: SessionTypeSchema,
    customDirSet: z.boolean().nullish(),
  }),
  z.object({ kind: z.literal('recheckDependencies') }),
  z.object({ kind: z.literal('openInstallGuide'), tool: z.string() }),
  z.object({ kind: z.literal('signIn') }),
  z.object({
    kind: z.literal('dismissBanner'),
    banner: z.enum(['login', 'gettingStarted', 'dependency']),
  }),
  z.object({
    kind: z.literal('gettingStarted'),
    action: GettingStartedActionSchema,
  }),
  z.object({
    kind: z.literal('onboarding'),
    action: z.enum([
      'signInChatGpt',
      'setApiKey',
      'skip',
      'runSetup',
      'skipSetup',
      'openGettingStarted',
    ]),
  }),
]);
export type HostRequest = z.infer<typeof HostRequestSchema>;
