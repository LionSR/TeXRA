/** Approval-and-safety settings handler. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  bashApprovalEnabled,
  editApprovalEnabled,
  toolPathProtectionEnabled,
  claudeAgentEffort,
  claudeAgentModel,
  claudeAgentPermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
} from '../settingsState';

export const approvalSettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS]: (data) => {
    bashApprovalEnabled.set(data.bashApprovalEnabled);
    editApprovalEnabled.set(data.editApprovalEnabled);
    toolPathProtectionEnabled.set(data.toolPathProtectionEnabled);
    codexSandboxMode.set(data.codexSandboxMode);
    codexReasoningEffort.set(data.codexReasoningEffort);
    codexApprovalPolicy.set(data.codexApprovalPolicy);
    claudeAgentModel.set(data.claudeAgentModel);
    claudeAgentPermissionMode.set(data.claudeAgentPermissionMode);
    claudeAgentEffort.set(data.claudeAgentEffort);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
