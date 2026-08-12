/**
 * Extension command IDs for the import/create flow.
 *
 * Registration of these commands goes through the catalog-driven shared
 * registry (`extensionCommandHandlers.ts`), which already guarantees the
 * registered IDs match `commandCatalog`. These constants are the mirror for
 * the *call* sites that dispatch or reference the same commands by literal —
 * the import quick-pick (`mainViewCommands.ts`), the welcome-view buttons,
 * the status-bar CTA, and the setup assistant. Referencing the constant keeps
 * a renamed ID a compile error instead of a silent runtime no-op.
 */
import type { CommandId } from '@shared/commands/catalog';

export const EXTENSION_COMMANDS = {
  CLONE_OVERLEAF_PROJECT: 'texra.cloneOverleafProject',
  DOWNLOAD_ARXIV_SOURCE: 'texra.downloadArXivSource',
  CREATE_SAMPLE_PROJECT: 'texra.createSampleProject',
  RUN_SETUP_ASSISTANT: 'texra.runSetupAssistant',
  OPEN_GETTING_STARTED: 'texra.openGettingStarted',
} as const satisfies Record<string, CommandId>;
