// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { MainViewPersistedStateSchema } from '@shared/schemas';
import type { TeamOptionData } from '@shared/schemas';

// Local imports - main-view actions, catalog slice, and state
import {
  buildExecuteMessage,
  changeLaunchTarget,
  changeSessionType,
  changeTeam,
  validateTeamSelection,
} from '@webview/frontend/mainViewActions';
import { catalogHandlers } from '@webview/frontend/slices/catalogSlice';
import {
  fileSelectionOpen$,
  instruction$,
  launchTarget$,
  model$,
  resetMainViewState,
  selectedTeamId$,
  sessionType$,
  statusAnnouncement$,
  teamOptions$,
  toolUseAgent$,
  toolUseInstruction$,
  workflowInstruction$,
} from '@webview/frontend/mainViewState';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  saveState: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

vi.mock('@webview/frontend/persistence', () => ({
  saveState: mocks.saveState,
}));

function teamOption(
  value: string,
  overrides: Partial<TeamOptionData> = {},
): TeamOptionData {
  return {
    value,
    label: value,
    icon: 'bookmark',
    source: 'built-in',
    description: '',
    unavailableMembers: [],
    rootAgentName: null,
    ...overrides,
  };
}

/** Flush the microtask queue so `announce`'s clear-then-set lands. */
async function flushAnnouncements(): Promise<void> {
  await Promise.resolve();
}

describe('main-view launch target', () => {
  beforeEach(() => {
    resetMainViewState();
    mocks.postMessage.mockClear();
    mocks.saveState.mockClear();
  });

  describe('persistence defaults', () => {
    it('prefaults launchTarget and selectedTeamId for users with pre-team persisted state', () => {
      const parsed = MainViewPersistedStateSchema.parse({});

      expect(parsed.launchTarget).toBe('agent');
      expect(parsed.selectedTeamId).toBe('');
    });

    it('round-trips a team launcher selection through the persisted-state schema', () => {
      const parsed = MainViewPersistedStateSchema.parse({
        launchTarget: 'team',
        selectedTeamId: 'physicist',
      });

      expect(parsed.launchTarget).toBe('team');
      expect(parsed.selectedTeamId).toBe('physicist');
    });
  });

  describe('changeLaunchTarget', () => {
    it('switches workflow to interactive team mode atomically, stashing the workflow draft', async () => {
      sessionType$.set('workflow');
      workflowInstruction$.set('workflow draft');
      instruction$.set('workflow draft');
      toolUseInstruction$.set('interactive draft');

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('team');
      expect(sessionType$.get()).toBe('toolUse');
      // Draft preservation through the shared swap path: the workflow draft is
      // stashed and the interactive draft becomes active in the same save.
      expect(workflowInstruction$.get()).toBe('workflow draft');
      expect(instruction$.get()).toBe('interactive draft');
      expect(fileSelectionOpen$.get()).toBe(false);
      expect(statusAnnouncement$.get()).toBe(
        'Team launcher selected. Interactive mode.',
      );
      expect(mocks.saveState).toHaveBeenCalled();
    });

    it('keeps the interactive draft when selecting Team from an interactive session', async () => {
      sessionType$.set('toolUse');
      toolUseInstruction$.set('interactive draft');
      instruction$.set('interactive draft');

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('team');
      expect(sessionType$.get()).toBe('toolUse');
      expect(instruction$.get()).toBe('interactive draft');
    });

    it('leaves the session interactive when switching Team back to Agent', async () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      instruction$.set('team draft');
      toolUseInstruction$.set('team draft');

      changeLaunchTarget('agent');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('agent');
      expect(sessionType$.get()).toBe('toolUse');
      expect(instruction$.get()).toBe('team draft');
      expect(statusAnnouncement$.get()).toBe('Agent launcher selected.');
      expect(mocks.saveState).toHaveBeenCalledOnce();
    });

    it('is a no-op when the target is already active', () => {
      changeLaunchTarget('agent');

      expect(mocks.saveState).not.toHaveBeenCalled();
      expect(mocks.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('changeSessionType team interplay', () => {
    it('drops the team launcher in the same save when switching to Workflow', async () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');
      toolUseInstruction$.set('interactive draft');
      instruction$.set('interactive draft');
      workflowInstruction$.set('workflow draft');

      changeSessionType('workflow');
      await flushAnnouncements();

      expect(sessionType$.get()).toBe('workflow');
      expect(launchTarget$.get()).toBe('agent');
      // Team runs are interactive-only: the swapModeInstruction path still
      // stashes the interactive draft and restores the workflow draft.
      expect(toolUseInstruction$.get()).toBe('interactive draft');
      expect(instruction$.get()).toBe('workflow draft');
      expect(fileSelectionOpen$.get()).toBe(true);
      expect(statusAnnouncement$.get()).toBe(
        'Workflow uses a single workflow agent.',
      );
      // Atomicity: the launch-target reset and the session swap persist in one
      // save, so no intermediate state can be restored after a reload.
      expect(mocks.saveState).toHaveBeenCalledOnce();
    });

    it('keeps the agent launcher when switching session types without a team selection', () => {
      sessionType$.set('workflow');

      changeSessionType('toolUse');

      expect(sessionType$.get()).toBe('toolUse');
      expect(launchTarget$.get()).toBe('agent');
    });
  });

  describe('changeTeam', () => {
    it('persists the selected team id', () => {
      changeTeam('physicist');

      expect(selectedTeamId$.get()).toBe('physicist');
      expect(mocks.saveState).toHaveBeenCalledOnce();
    });
  });

  describe('validateTeamSelection', () => {
    it('does nothing while the agent launcher is active', () => {
      selectedTeamId$.set('physicist');

      validateTeamSelection();

      expect(selectedTeamId$.get()).toBe('physicist');
      expect(mocks.saveState).not.toHaveBeenCalled();
    });

    it('keeps an enabled restored team', () => {
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');
      teamOptions$.set([
        teamOption('physicist'),
        teamOption('lean-project', { disabled: true }),
      ]);

      validateTeamSelection();

      expect(selectedTeamId$.get()).toBe('physicist');
      expect(launchTarget$.get()).toBe('team');
      // Nothing changed, so nothing is persisted.
      expect(mocks.saveState).not.toHaveBeenCalled();
    });

    it('falls back to the first non-disabled option with an announcement when the restored team vanished', async () => {
      launchTarget$.set('team');
      selectedTeamId$.set('deleted-team');
      teamOptions$.set([
        teamOption('broken', { disabled: true }),
        teamOption('physicist'),
        teamOption('lean-project'),
      ]);

      validateTeamSelection();
      await flushAnnouncements();

      expect(selectedTeamId$.get()).toBe('physicist');
      expect(launchTarget$.get()).toBe('team');
      expect(statusAnnouncement$.get()).toBe(
        'Selected team is no longer available. Switched to "physicist".',
      );
      expect(mocks.saveState).toHaveBeenCalledOnce();
    });

    it('keeps a present-but-disabled team without rewriting the persisted selection', async () => {
      launchTarget$.set('team');
      selectedTeamId$.set('broken');
      teamOptions$.set([
        teamOption('broken', { disabled: true, disabledReason: 'No lead.' }),
        teamOption('physicist'),
      ]);

      validateTeamSelection();
      await flushAnnouncements();

      // The disable may be transient (e.g. remote catalog reload flapping):
      // the picker renders the option disabled with its reason instead of
      // silently stealing the user's persisted selection.
      expect(selectedTeamId$.get()).toBe('broken');
      expect(launchTarget$.get()).toBe('team');
      expect(mocks.saveState).not.toHaveBeenCalled();
      expect(statusAnnouncement$.get()).toBe('');
    });

    it('keeps a present-but-disabled team even when no team is runnable', () => {
      launchTarget$.set('team');
      selectedTeamId$.set('broken');
      teamOptions$.set([teamOption('broken', { disabled: true })]);

      validateTeamSelection();

      expect(selectedTeamId$.get()).toBe('broken');
      expect(launchTarget$.get()).toBe('team');
      expect(mocks.saveState).not.toHaveBeenCalled();
    });

    it('drops to the agent launcher with an announcement when the vanished team has no runnable fallback', async () => {
      launchTarget$.set('team');
      selectedTeamId$.set('deleted-team');
      teamOptions$.set([teamOption('broken', { disabled: true })]);

      validateTeamSelection();
      await flushAnnouncements();

      expect(selectedTeamId$.get()).toBe('deleted-team');
      expect(launchTarget$.get()).toBe('agent');
      expect(statusAnnouncement$.get()).toBe(
        'No runnable teams available. Agent launcher selected.',
      );
      expect(mocks.saveState).toHaveBeenCalledOnce();
    });
  });

  describe('SET_TEAM_OPTIONS handler', () => {
    function setTeamOptions(optionsData: TeamOptionData[]): void {
      catalogHandlers[MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS]({
        command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
        optionsData,
      });
    }

    it('stores the pushed options and revalidates the restored selection', async () => {
      launchTarget$.set('team');
      selectedTeamId$.set('deleted-team');

      // Before the push arrives, the empty async catalog is not proof the
      // team vanished: the restored selection is left alone.
      expect(teamOptions$.get()).toEqual([]);
      expect(selectedTeamId$.get()).toBe('deleted-team');

      setTeamOptions([teamOption('physicist')]);
      await flushAnnouncements();

      expect(teamOptions$.get().map((option) => option.value)).toEqual([
        'physicist',
      ]);
      expect(selectedTeamId$.get()).toBe('physicist');
      expect(launchTarget$.get()).toBe('team');
      expect(statusAnnouncement$.get()).toBe(
        'Selected team is no longer available. Switched to "physicist".',
      );
    });

    it('keeps a still-valid restored selection when the push arrives', () => {
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');

      setTeamOptions([teamOption('physicist'), teamOption('lean-project')]);

      expect(selectedTeamId$.get()).toBe('physicist');
    });

    it('drops to the agent launcher when the push contains no runnable teams', async () => {
      launchTarget$.set('team');
      selectedTeamId$.set('deleted-team');

      setTeamOptions([]);
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('agent');
      expect(statusAnnouncement$.get()).toBe(
        'No runnable teams available. Agent launcher selected.',
      );
    });
  });

  describe('buildExecuteMessage', () => {
    it('sends only launchTarget and teamId as team identity', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');
      toolUseAgent$.set('orchestrator');
      model$.set('gpt-5.4');

      const message = buildExecuteMessage();

      expect(message.session).toEqual({
        launchTarget: 'team',
        teamId: 'physicist',
      });
      // The renderer still sends its current agent; the host replaces it with
      // the planned team root at the execution boundary.
      expect(message.agent).toBe('orchestrator');
      expect(message.isToolUseAgent).toBe(true);
    });

    it('sends no team identity for the agent launcher', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('agent');
      selectedTeamId$.set('physicist');

      expect(buildExecuteMessage().session).toEqual({
        launchTarget: 'agent',
        teamId: undefined,
      });
    });

    it('omits teamId when the team launcher has no selection', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('');

      expect(buildExecuteMessage().session).toEqual({
        launchTarget: 'team',
        teamId: undefined,
      });
    });
  });
});
