/** Approval settings handlers: UPDATE_APPROVAL_SETTINGS. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  bashApprovalEnabled,
  toolPathProtectionEnabled,
  claudeAgentEffort,
  claudeAgentModel,
  claudeAgentPermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the approval-settings
// command, so it's typed as a `satisfies Partial<...>` subset rather than
// the full registry; `messageDispatcher.ts` spreads all slices together and
// is the actual exhaustiveness checkpoint TypeScript enforces.
export const approvalSettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS]: (data) => {
    bashApprovalEnabled.set(data.bashApprovalEnabled);
    toolPathProtectionEnabled.set(data.toolPathProtectionEnabled);
    codexSandboxMode.set(data.codexSandboxMode);
    codexReasoningEffort.set(data.codexReasoningEffort);
    codexApprovalPolicy.set(data.codexApprovalPolicy);
    claudeAgentModel.set(data.claudeAgentModel);
    claudeAgentPermissionMode.set(data.claudeAgentPermissionMode);
    claudeAgentEffort.set(data.claudeAgentEffort);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
