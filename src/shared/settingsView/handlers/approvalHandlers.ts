/**
 * Approval settings handlers shared between desktop and extension hosts.
 *
 * Builds the approval-settings outbound message from workspace state and
 * applies updates from inbound messages. Both hosts hold the same workspace
 * state shape — the only host-specific dependency is the bash-approval flag,
 * which lives in `ConfigProvider` rather than workspace state.
 */
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type { UpdateApprovalSettingsMessage } from '@shared/schemas/settingsViewMessages';
import {
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@tools/codexConfig';
import {
  CLAUDE_AGENT_DEFAULT_MODEL,
  parseClaudeAgentEffort,
  parseClaudeAgentModel,
  parseClaudeAgentPermissionMode,
} from '@tools/claudeAgentConfig';
import { BASH_APPROVAL_CONFIG_KEY } from '@tools/approval/bashApproval';
import type { ConfigProvider, ConfigTarget } from '@platform/interfaces/config';

import type { SettingsStatePorts } from './types';

export interface ApprovalHandlerPorts extends SettingsStatePorts {
  readonly config: ConfigProvider;
}

export function buildApprovalSettingsMessage(
  ports: ApprovalHandlerPorts,
): UpdateApprovalSettingsMessage {
  const { workspaceState, config } = ports;
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
    bashApprovalEnabled: config.get<boolean>(BASH_APPROVAL_CONFIG_KEY, true),
    codexSandboxMode: parseCodexSandboxMode(
      workspaceState.get<string>(
        WorkspaceStateKey.CODEX_SANDBOX_MODE,
        'workspace-write',
      ) ?? 'workspace-write',
    ),
    codexReasoningEffort: parseCodexReasoningEffort(
      workspaceState.get<string>(
        WorkspaceStateKey.CODEX_REASONING_EFFORT,
        'high',
      ) ?? 'high',
    ),
    codexApprovalPolicy: parseCodexApprovalPolicy(
      workspaceState.get<string>(
        WorkspaceStateKey.CODEX_APPROVAL_POLICY,
        'never',
      ) ?? 'never',
    ),
    claudeAgentModel: parseClaudeAgentModel(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_MODEL,
        CLAUDE_AGENT_DEFAULT_MODEL,
      ) ?? CLAUDE_AGENT_DEFAULT_MODEL,
    ),
    claudeAgentPermissionMode: parseClaudeAgentPermissionMode(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
        'acceptEdits',
      ) ?? 'acceptEdits',
    ),
    claudeAgentEffort: parseClaudeAgentEffort(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
        'high',
      ) ?? 'high',
    ),
  };
}

export async function setBashApprovalEnabled(
  ports: ApprovalHandlerPorts,
  enabled: boolean,
  target: ConfigTarget,
): Promise<void> {
  await ports.config.update(BASH_APPROVAL_CONFIG_KEY, enabled, target);
}

export async function setWorkspaceAgentSetting(
  ports: SettingsStatePorts,
  key: WorkspaceStateKey,
  value: string,
): Promise<void> {
  await ports.workspaceState.update(key, value);
}
