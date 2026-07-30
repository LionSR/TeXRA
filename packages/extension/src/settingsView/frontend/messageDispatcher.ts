/**
 * Composed message-handler registry for SettingsView.
 *
 * Backend → webview messages are validated + routed via
 * `dispatchSettingsViewOutbound` (the schema-driven dispatcher from
 * `@shared/schemas`/`@shared/utils/dispatcher`) — unlike ProgressView, there
 * is no bespoke `dispatchMessage()` here because that generic mechanism
 * already exists and SettingsApp already used it before this migration.
 * Handlers are organized into domain-specific slices under ./slices/, one per
 * section of `SettingsApp`'s state (see `settingsState.ts`). Each slice owns
 * only its own commands and is typed `satisfies Partial<...>`; the composed
 * registry below is the checkpoint where TypeScript enforces exhaustiveness
 * (every SettingsView outbound command needs a real handler or
 * `unsupported(...)` — see `@shared/utils/dispatcher`).
 */
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { agentSelectionHandlers } from './slices/agentSelectionSlice';
import { agentSkillsSettingsHandlers } from './slices/agentSkillsSettingsSlice';
import { agentTeamsHandlers } from './slices/agentTeamsSlice';
import { approvalSettingsHandlers } from './slices/approvalSettingsSlice';
import { gitHandlers } from './slices/gitSlice';
import { goalHandlers } from './slices/goalSlice';
import { historyHandlers } from './slices/historySlice';
import { latexHandlers } from './slices/latexSlice';
import { memoryHandlers } from './slices/memorySlice';
import { modelSelectionHandlers } from './slices/modelSelectionSlice';
import { multiAgentHandlers } from './slices/multiAgentSlice';
import { profileHandlers } from './slices/profileSlice';
import { tabHandlers } from './slices/tabSlice';
import { toolDashboardHandlers } from './slices/toolDashboardSlice';

/** Composed registry: every SETTINGS_VIEW_COMMANDS outbound handler, keyed by command. */
export const settingsViewHandlers: SettingsViewOutboundHandlerRegistry = {
  ...tabHandlers,
  ...memoryHandlers,
  ...historyHandlers,
  ...profileHandlers,
  ...modelSelectionHandlers,
  ...agentSelectionHandlers,
  ...agentSkillsSettingsHandlers,
  ...agentTeamsHandlers,
  ...multiAgentHandlers,
  ...approvalSettingsHandlers,
  ...toolDashboardHandlers,
  ...gitHandlers,
  ...latexHandlers,
  ...goalHandlers,
};
