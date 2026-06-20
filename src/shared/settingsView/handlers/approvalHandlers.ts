/**
 * Approval settings handlers shared between desktop and extension hosts.
 *
 * Builds the approval-settings outbound message from workspace state and
 * applies updates from inbound messages. Both hosts hold the same workspace
 * state shape — the only host-specific dependency is the bash-approval flag,
 * which lives in `ConfigProvider` rather than workspace state.
 */
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc/settingsViewCommands';
import type { UpdateApprovalSettingsMessage } from '@shared/schemas/settingsViewMessages';
import {
  BASH_APPROVAL_CONFIG_KEY,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseClaudeAgentEffort,
  parseClaudeAgentModel,
  parseClaudeAgentPermissionMode,
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@shared/schemas/agentCliSettings';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import type { ConfigProvider, ConfigTarget } from '@platform/interfaces/config';

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
        CODEX_SANDBOX_MODE_DEFAULT,
      ),
    ),
    codexReasoningEffort: parseCodexReasoningEffort(
      workspaceState.get<string>(
        WorkspaceStateKey.CODEX_REASONING_EFFORT,
        CODEX_REASONING_EFFORT_DEFAULT,
      ),
    ),
    codexApprovalPolicy: parseCodexApprovalPolicy(
      workspaceState.get<string>(
        WorkspaceStateKey.CODEX_APPROVAL_POLICY,
        CODEX_APPROVAL_POLICY_DEFAULT,
      ),
    ),
    claudeAgentModel: parseClaudeAgentModel(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_MODEL,
        CLAUDE_AGENT_DEFAULT_MODEL,
      ),
    ),
    claudeAgentPermissionMode: parseClaudeAgentPermissionMode(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
        CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
      ),
    ),
    claudeAgentEffort: parseClaudeAgentEffort(
      workspaceState.get<string>(
        WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
        CLAUDE_AGENT_DEFAULT_EFFORT,
      ),
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
