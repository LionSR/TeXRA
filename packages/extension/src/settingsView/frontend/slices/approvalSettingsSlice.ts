/** Approval settings handlers: UPDATE_APPROVAL_SETTINGS. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  bashApprovalEnabled,
  claudeAgentEffort,
  claudeAgentModel,
  claudeAgentPermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
} from '../settingsState';

export const approvalSettingsHandlers: SettingsViewOutboundHandlerRegistry = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS]: (data) => {
    bashApprovalEnabled.set(data.bashApprovalEnabled);
    codexSandboxMode.set(data.codexSandboxMode);
    codexReasoningEffort.set(data.codexReasoningEffort);
    codexApprovalPolicy.set(data.codexApprovalPolicy);
    claudeAgentModel.set(data.claudeAgentModel);
    claudeAgentPermissionMode.set(data.claudeAgentPermissionMode);
    claudeAgentEffort.set(data.claudeAgentEffort);
  },
};
