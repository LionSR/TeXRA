import { describe, expect, it, vi } from 'vitest';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory, AGENT_SOURCE } from '@shared/schemas';
import type { AgentSelectionItem } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { buildAuthStatusMessage } from '@shared/settingsView/handlers/authStatusMessage';
import {
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
  buildAgentModePresetsMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import {
  buildGitAuthorSettingsMessage,
  type GitAuthorSettings,
} from '@utils/system/gitAuthorSettings';

const workflowItem: AgentSelectionItem = {
  name: 'a',
  category: AgentCategory.Workflow,
  source: AGENT_SOURCE.BUILT_IN_WORKFLOW,
  hasPath: true,
  enabled: true,
};
const toolUseItem: AgentSelectionItem = {
  name: 'b',
  category: AgentCategory.ToolUse,
  source: AGENT_SOURCE.CUSTOM,
  hasPath: false,
  enabled: false,
};

// Regression guard for the settingsView host consolidation: both the
// extension and desktop hosts now call these shared builders instead of
// hand-rolling the outbound message shape. These tests pin the exact shape
// both hosts previously built by hand.
describe('settingsView notification message builders', () => {
  it('buildAgentSelectionMessage loads agents then wraps the selection items', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const buildSelectionItems = vi.fn().mockReturnValue({
      workflow: [workflowItem],
      toolUse: [toolUseItem],
    });

    const message = await buildAgentSelectionMessage({
      loadAgents,
      buildSelectionItems,
      getCustomAgentScanIssues: () => [],
    });

    expect(loadAgents).toHaveBeenCalledOnce();
    expect(buildSelectionItems).toHaveBeenCalledOnce();
    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      agents: { workflow: [workflowItem], toolUse: [toolUseItem] },
      customAgentIssues: [],
    });
  });

  it('buildAgentSelectionMessage includes custom agent scan issues', async () => {
    const issues = [
      {
        path: 'retired.yaml',
        message: 'settings: unrecognized keys documentTag',
      },
    ];
    const message = await buildAgentSelectionMessage({
      loadAgents: vi.fn().mockResolvedValue(undefined),
      buildSelectionItems: vi.fn().mockReturnValue({
        workflow: [],
        toolUse: [],
      }),
      getCustomAgentScanIssues: () => issues,
    });

    expect(message.customAgentIssues).toEqual(issues);
  });

  it('buildCustomAgentDirMessage wraps the resolved status', async () => {
    const getCustomDirStatus = vi
      .fn()
      .mockResolvedValue({ path: '/some/dir', isDefault: false });

    const message = await buildCustomAgentDirMessage({ getCustomDirStatus });

    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: '/some/dir',
      isDefault: false,
    });
  });

  it('buildAgentModePresetsMessage wraps presets and orchestrator names', () => {
    const message = buildAgentModePresetsMessage({
      getCustomPresets: () => [],
      getOrchestratorAgentNames: () => ['orchestrator-agent'],
    });

    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: [],
      orchestratorAgents: ['orchestrator-agent'],
    });
  });

  it('buildAuthStatusMessage wraps the resolved status', async () => {
    const status = {
      signedIn: true,
      email: 'user@example.com',
      accountId: 'acct-1',
      preferSubscription: true,
    };
    const getStatus = vi.fn().mockResolvedValue(status);

    const message = await buildAuthStatusMessage(
      SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      getStatus,
    );

    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      status,
    });
  });

  it('buildGitAuthorSettingsMessage wraps the settings object', () => {
    const settings: GitAuthorSettings = {
      markCommits: true,
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      worktreeSupport: false,
    };

    const message = buildGitAuthorSettingsMessage(settings);

    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ...settings,
    });
  });

  it('LatexConfigPersistenceController.buildConfigMessage wraps buildConfigValues', () => {
    const controller = new LatexConfigPersistenceController();
    const stored = new Map<WorkspaceStateKey, unknown>([
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE, true],
    ]);

    const message = controller.buildConfigMessage((key) => stored.get(key));

    expect(message).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: controller.buildConfigValues((key) => stored.get(key)),
    });
  });
});
