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

// Bash-approval gating is a security-adjacent bypass: keep it scoped per
// workspace (not global) so disabling it in one project can't silently
// disable approval everywhere else. Both hosts must reference this constant
// rather than hardcoding their own target.
export const BASH_APPROVAL_CONFIG_TARGET: ConfigTarget = 'workspace';

export function buildApprovalSettingsMessage(
  ports: ApprovalHandlerPorts,
): UpdateApprovalSettingsMessage {
  const { workspaceState, config } = ports;

  // Read a workspace-state string (with default) and parse it to its enum.
  function read<T>(
    key: WorkspaceStateKey,
    fallback: string,
    parse: (raw: string) => T,
  ): T {
    return parse(workspaceState.get<string>(key, fallback));
  }

  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
    bashApprovalEnabled: config.get<boolean>(BASH_APPROVAL_CONFIG_KEY, true),
    codexSandboxMode: read(
      WorkspaceStateKey.CODEX_SANDBOX_MODE,
      CODEX_SANDBOX_MODE_DEFAULT,
      parseCodexSandboxMode,
    ),
    codexReasoningEffort: read(
      WorkspaceStateKey.CODEX_REASONING_EFFORT,
      CODEX_REASONING_EFFORT_DEFAULT,
      parseCodexReasoningEffort,
    ),
    codexApprovalPolicy: read(
      WorkspaceStateKey.CODEX_APPROVAL_POLICY,
      CODEX_APPROVAL_POLICY_DEFAULT,
      parseCodexApprovalPolicy,
    ),
    claudeAgentModel: read(
      WorkspaceStateKey.CLAUDE_AGENT_MODEL,
      CLAUDE_AGENT_DEFAULT_MODEL,
      parseClaudeAgentModel,
    ),
    claudeAgentPermissionMode: read(
      WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
      parseClaudeAgentPermissionMode,
    ),
    claudeAgentEffort: read(
      WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
      CLAUDE_AGENT_DEFAULT_EFFORT,
      parseClaudeAgentEffort,
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
