/**
 * Composed message-handler registry for SettingsView.
 *
 * Backend → webview messages are validated + routed via
 * `dispatchSettingsViewOutbound` (the schema-driven dispatcher from
 * `@shared/schemas`/`@shared/utils/dispatcher`) — unlike ProgressView, there
 * is no bespoke `dispatchMessage()` here because that generic mechanism
 * already exists and SettingsApp already used it before this migration.
 * Handlers are organized into domain-specific slices under ./slices/, one per
 * section of `SettingsApp`'s state (see `settingsState.ts`) — except
 * miscSettingsSlice.ts, which bundles the single-command/single-toggle
 * handlers that don't own a state section of their own (agent skills,
 * telemetry, goals, agent teams, tool dashboard, multi-agent coordination).
 * modelSelectionSlice.ts and approvalSettingsSlice.ts are also single-command
 * but stay standalone: each owns a named, independently-surfaced state
 * section (model selection, approval/safety) rather than a one-off toggle.
 * Each slice owns only its own commands and is typed `satisfies Partial<...>`;
 * the composed registry below is the checkpoint where TypeScript enforces
 * exhaustiveness (every SettingsView outbound command needs a real handler or
 * `unsupported(...)` — see `@shared/utils/dispatcher`).
 */
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { agentSelectionHandlers } from './slices/agentSelectionSlice';
import { approvalSettingsHandlers } from './slices/approvalSettingsSlice';
import { gitHandlers } from './slices/gitSlice';
import { historyHandlers } from './slices/historySlice';
import { latexHandlers } from './slices/latexSlice';
import { memoryHandlers } from './slices/memorySlice';
import {
  agentSkillsSettingsHandlers,
  agentTeamsHandlers,
  goalHandlers,
  multiAgentHandlers,
  telemetrySettingsHandlers,
  toolDashboardHandlers,
} from './slices/miscSettingsSlice';
import { modelSelectionHandlers } from './slices/modelSelectionSlice';
import { profileHandlers } from './slices/profileSlice';
import { subscriptionUsageHandlers } from './slices/subscriptionUsageSlice';
import { tabHandlers } from './slices/tabSlice';

/** Composed registry: every SETTINGS_VIEW_COMMANDS outbound handler, keyed by command. */
export const settingsViewHandlers: SettingsViewOutboundHandlerRegistry = {
  ...tabHandlers,
  ...memoryHandlers,
  ...historyHandlers,
  ...profileHandlers,
  ...modelSelectionHandlers,
  ...agentSelectionHandlers,
  ...agentSkillsSettingsHandlers,
  ...telemetrySettingsHandlers,
  ...agentTeamsHandlers,
  ...multiAgentHandlers,
  ...approvalSettingsHandlers,
  ...toolDashboardHandlers,
  ...gitHandlers,
  ...subscriptionUsageHandlers,
  ...latexHandlers,
  ...goalHandlers,
};
