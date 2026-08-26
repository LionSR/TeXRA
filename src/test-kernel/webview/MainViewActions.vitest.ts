// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { MainViewPersistedStateSchema, AgentCategory } from '@shared/schemas';
import type {
  MainViewExecuteMessage,
  SessionType,
  TeamOptionData,
} from '@shared/schemas';

// Local imports - main-view actions, catalog slice, state, and test utilities
import {
  changeLaunchTarget,
  changeSessionType,
  changeTeam,
  changeWorkingDirectory,
  runLatexDiffsAction,
  runPanelAction,
  sendExecuteMessage,
  validateTeamSelection,
} from '@webview/frontend/mainViewActions';
import { catalogHandlers } from '@webview/frontend/slices/catalogSlice';
import { sessionHandlers } from '@webview/frontend/slices/sessionSlice';
import {
  commit$,
  instruction$,
  launchTarget$,
  model$,
  multiFiles$,
  resetMainViewState,
  selectedTeamId$,
  sessionType$,
  singleFiles$,
  statusAnnouncement$,
  teamOptions$,
  agent$,
  instructionDrafts$,
  workingDirectory$,
  workspaceRootOptions$,
} from '@webview/frontend/mainViewState';
import { teamOption } from './mainViewTestUtils';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

function setTeamOptions(optionsData: TeamOptionData[]): void {
  catalogHandlers[MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS]({
    command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    optionsData,
  });
}

function setWorkspaceRoots(
  optionsData: Array<{ label: string; value: string }>,
): void {
  catalogHandlers[MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS]({
    command: MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS,
    optionsData,
  });
}

const OPEN_ROOTS = [
  { label: 'paper', value: '/workspace/paper' },
  { label: 'figures', value: '/workspace/figures' },
];

/** Flush the microtask queue so `announce`'s clear-then-set lands. */
async function flushAnnouncements(): Promise<void> {
  await Promise.resolve();
}

/** Post the current form state and return the EXECUTE payload the host gets. */
function captureExecuteMessage(): MainViewExecuteMessage {
  sendExecuteMessage();
  const call = mocks.postMessage.mock.calls.at(-1);
  expect(call?.[0]).toBe(MAIN_VIEW_COMMANDS.EXECUTE);
  return call?.[1] as MainViewExecuteMessage;
}

function stashDraft(sessionType: SessionType, text: string): void {
  instructionDrafts$.set({ ...instructionDrafts$.get(), [sessionType]: text });
}

function selectFiles(inputFiles: string[], baseFile = '', editedFile = '') {
  multiFiles$.set({ ...multiFiles$.get(), inputFiles });
  singleFiles$.set({ baseFile, editedFile });
}

function information(text: string): [string, { text: string }] {
  return [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, { text }];
}

describe('main-view launch target', () => {
  beforeEach(() => {
    resetMainViewState();
    mocks.postMessage.mockClear();
  });

  describe('persistence defaults', () => {
    it('prefaults launchTarget and selectedTeamId for users with pre-team persisted state', () => {
      const parsed = MainViewPersistedStateSchema.parse({});

      expect(parsed.launchTarget).toBe('agent');
      expect(parsed.selectedTeamId).toBe('');
      expect(parsed.workingDirectory).toBe('');
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
      stashDraft('workflow', 'workflow draft');
      stashDraft('toolUse', 'interactive draft');

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('team');
      expect(sessionType$.get()).toBe('toolUse');
      // Draft preservation: the workflow draft stays put and the interactive
      // draft becomes the active one.
      expect(instructionDrafts$.get().workflow).toBe('workflow draft');
      expect(instruction$.get()).toBe('interactive draft');
      expect(statusAnnouncement$.get()).toBe(
        'Team launcher selected. Interactive mode.',
      );
    });

    it('keeps the interactive draft when selecting Team from an interactive session', async () => {
      sessionType$.set('toolUse');
      stashDraft('toolUse', 'interactive draft');

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('team');
      expect(sessionType$.get()).toBe('toolUse');
      expect(instruction$.get()).toBe('interactive draft');
    });

    it('selects the first enabled team when entering Team after the catalog arrived on Agent', async () => {
      sessionType$.set('toolUse');
      setTeamOptions([
        teamOption('broken', { disabled: true }),
        teamOption('physicist'),
        teamOption('lean-project'),
      ]);

      expect(launchTarget$.get()).toBe('agent');
      expect(selectedTeamId$.get()).toBe('');

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('team');
      expect(selectedTeamId$.get()).toBe('physicist');
      expect(statusAnnouncement$.get()).toBe(
        'Team launcher selected. Interactive mode.',
      );
    });

    it('replaces a stale team when entering Team after the catalog arrived', () => {
      sessionType$.set('toolUse');
      selectedTeamId$.set('deleted-team');
      setTeamOptions([teamOption('physicist'), teamOption('lean-project')]);

      changeLaunchTarget('team');

      expect(launchTarget$.get()).toBe('team');
      expect(selectedTeamId$.get()).toBe('physicist');
    });

    it('preserves a selected disabled team when entering Team', () => {
      sessionType$.set('toolUse');
      selectedTeamId$.set('broken');
      setTeamOptions([
        teamOption('broken', { disabled: true }),
        teamOption('physicist'),
      ]);

      changeLaunchTarget('team');

      expect(launchTarget$.get()).toBe('team');
      expect(selectedTeamId$.get()).toBe('broken');
    });

    it('rejects Team when a non-empty catalog has no runnable fallback', async () => {
      sessionType$.set('toolUse');
      setTeamOptions([teamOption('broken', { disabled: true })]);

      changeLaunchTarget('team');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('agent');
      expect(selectedTeamId$.get()).toBe('');
      expect(statusAnnouncement$.get()).toBe(
        'No runnable teams available. Agent launcher selected.',
      );
    });

    it('leaves the session interactive when switching Team back to Agent', async () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      stashDraft('toolUse', 'team draft');

      changeLaunchTarget('agent');
      await flushAnnouncements();

      expect(launchTarget$.get()).toBe('agent');
      expect(sessionType$.get()).toBe('toolUse');
      expect(instruction$.get()).toBe('team draft');
      expect(statusAnnouncement$.get()).toBe('Agent launcher selected.');
    });

    it('is a no-op when the target is already active', () => {
      changeLaunchTarget('agent');

      expect(mocks.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('changeSessionType team interplay', () => {
    it('drops the team launcher when switching to Workflow', async () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');
      stashDraft('toolUse', 'interactive draft');
      stashDraft('workflow', 'workflow draft');

      changeSessionType('workflow');
      await flushAnnouncements();

      expect(sessionType$.get()).toBe('workflow');
      expect(launchTarget$.get()).toBe('agent');
      // Team runs are interactive-only: the interactive draft survives the
      // switch and the workflow draft becomes the active one.
      expect(instructionDrafts$.get().toolUse).toBe('interactive draft');
      expect(instruction$.get()).toBe('workflow draft');
      expect(statusAnnouncement$.get()).toBe(
        'Workflow uses a single workflow agent.',
      );
    });

    it('keeps the agent launcher when switching session types without a team selection', () => {
      sessionType$.set('workflow');

      changeSessionType('toolUse');

      expect(sessionType$.get()).toBe('toolUse');
      expect(launchTarget$.get()).toBe('agent');
    });
  });

  describe('per-mode instruction drafts', () => {
    it('follows the active session mode without a stash step', () => {
      sessionType$.set('workflow');
      stashDraft('workflow', 'workflow draft');
      stashDraft('toolUse', 'interactive draft');

      expect(instruction$.get()).toBe('workflow draft');

      // The host-pushed agent selection switches mode without touching the
      // drafts: `instruction$` is derived, so both survive the round trip.
      sessionHandlers[MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]({
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        sessionType: 'toolUse',
        agentId: 'coder',
      });

      expect(sessionType$.get()).toBe('toolUse');
      expect(agent$.get().toolUse).toBe('coder');
      expect(instruction$.get()).toBe('interactive draft');
      expect(instructionDrafts$.get().workflow).toBe('workflow draft');

      changeSessionType('workflow');

      expect(instruction$.get()).toBe('workflow draft');
      expect(instructionDrafts$.get().toolUse).toBe('interactive draft');
    });
  });

  describe('changeTeam', () => {
    it('records the selected team id', () => {
      changeTeam('physicist');

      expect(selectedTeamId$.get()).toBe('physicist');
    });
  });

  describe('working directory selection', () => {
    it('defaults to the first open root and preserves a valid selection', () => {
      setWorkspaceRoots(OPEN_ROOTS);

      expect(workspaceRootOptions$.get()).toHaveLength(2);
      expect(workingDirectory$.get()).toBe('/workspace/paper');

      changeWorkingDirectory('/workspace/figures');
      setWorkspaceRoots(OPEN_ROOTS);

      expect(workingDirectory$.get()).toBe('/workspace/figures');
    });

    it('falls back when the persisted root is no longer open', () => {
      workingDirectory$.set('/workspace/removed');

      setWorkspaceRoots(OPEN_ROOTS);

      expect(workingDirectory$.get()).toBe('/workspace/paper');
    });
  });

  describe('validateTeamSelection', () => {
    it('does nothing while the agent launcher is active', () => {
      selectedTeamId$.set('physicist');

      validateTeamSelection();

      expect(selectedTeamId$.get()).toBe('physicist');
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
      expect(statusAnnouncement$.get()).toBe('');
    });

    it('keeps a present-but-disabled team even when no team is runnable', () => {
      launchTarget$.set('team');
      selectedTeamId$.set('broken');
      teamOptions$.set([teamOption('broken', { disabled: true })]);

      validateTeamSelection();

      expect(selectedTeamId$.get()).toBe('broken');
      expect(launchTarget$.get()).toBe('team');
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
    });
  });

  describe('SET_TEAM_OPTIONS handler', () => {
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

    it('does not abandon a restored team on a transient empty push before options arrive', () => {
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');

      setTeamOptions([]);

      expect(launchTarget$.get()).toBe('team');
      expect(selectedTeamId$.get()).toBe('physicist');

      setTeamOptions([teamOption('physicist'), teamOption('lean-project')]);

      expect(launchTarget$.get()).toBe('team');
      expect(selectedTeamId$.get()).toBe('physicist');
    });
  });

  describe('sendExecuteMessage', () => {
    it('sends only launchTarget and teamId as team identity', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');
      agent$.set({ ...agent$.get(), toolUse: 'orchestrator' });
      model$.set('gpt-5.4');

      const message = captureExecuteMessage();

      expect(message.session).toEqual({
        launchTarget: 'team',
        teamId: 'physicist',
      });
      // The renderer still sends its current agent; the host replaces it with
      // the planned team root at the execution boundary.
      expect(message.agent).toBe('orchestrator');
      expect(message.agentCategory).toBe(AgentCategory.ToolUse);
    });

    it('sends the selected working directory through the existing session payload', () => {
      workingDirectory$.set('/workspace/paper');

      expect(captureExecuteMessage().session).toMatchObject({
        launchTarget: 'agent',
        workingDirectory: '/workspace/paper',
      });
    });

    it('sends no team identity for the agent launcher', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('agent');
      selectedTeamId$.set('physicist');

      expect(captureExecuteMessage().session).toEqual({
        launchTarget: 'agent',
        teamId: undefined,
      });
    });

    it('canonicalizes stale team state to an agent workflow launch', () => {
      sessionType$.set('workflow');
      launchTarget$.set('team');
      selectedTeamId$.set('physicist');

      expect(captureExecuteMessage().session).toEqual({
        launchTarget: 'agent',
        teamId: undefined,
      });
    });

    it('omits teamId when the team launcher has no selection', () => {
      sessionType$.set('toolUse');
      launchTarget$.set('team');
      selectedTeamId$.set('');

      expect(captureExecuteMessage().session).toEqual({
        launchTarget: 'team',
        teamId: undefined,
      });
    });
  });
});

describe('main-view direct actions', () => {
  beforeEach(() => {
    resetMainViewState();
    mocks.postMessage.mockClear();
  });

  it('posts a single-file pack followed by its information message', () => {
    sessionType$.set('workflow');
    model$.set('gpt-5.4');
    agent$.set({ ...agent$.get(), workflow: 'correct' });
    selectFiles(['main.tex']);

    runPanelAction('pack');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.PACK_SINGLE,
        {
          inputFile: 'main.tex',
          agent: 'correct',
          model: 'gpt-5.4',
          inputFiles: undefined,
        },
      ],
      information('Packing single file: main.tex'),
    ]);
  });

  it('filters empty entries and posts a multi-file clean with the active tool-use agent', () => {
    sessionType$.set('toolUse');
    model$.set('gpt-5.4');
    agent$.set({ ...agent$.get(), toolUse: 'orchestrator' });
    selectFiles(['main.tex', '', 'chapter.tex']);

    runPanelAction('clean');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE,
        {
          inputFile: 'main.tex',
          agent: 'orchestrator',
          model: 'gpt-5.4',
          inputFiles: ['chapter.tex'],
        },
      ],
      information('Cleaning multiple files: main.tex, chapter.tex'),
    ]);
  });

  it.each([
    { inputFiles: [] as string[], model: 'gpt-5.4' },
    { inputFiles: ['main.tex'], model: '' },
  ])('rejects a pack when a required field is absent', (state) => {
    model$.set(state.model);
    selectFiles(state.inputFiles);

    runPanelAction('pack');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose an input file and a model first.'),
    ]);
  });

  it.each([
    {
      action: 'latexdiff' as const,
      command: MAIN_VIEW_COMMANDS.LATEXDIFF,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        editedFile: 'new.tex',
      },
      info: 'Running LaTeX diff between old.tex and new.tex',
    },
    {
      action: 'latexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
      },
      info: 'Running LaTeX diff with version control: old.tex at commit abc123',
    },
    {
      action: 'packLatexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
        clean: false,
      },
      info: 'Packing LaTeX diff with version control: old.tex at commit abc123',
    },
    {
      action: 'cleanLatexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
        clean: true,
      },
      info: 'Cleaning LaTeX diff with version control: old.tex at commit abc123',
    },
  ])('posts $action followed by its information message', (expected) => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');
    commit$.set('abc123');

    runLatexDiffsAction(expected.action);

    expect(mocks.postMessage.mock.calls).toEqual([
      [expected.command, expected.payload],
      information(expected.info),
    ]);
  });

  it('posts merge followed by its information message', () => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');

    runLatexDiffsAction('merge');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.MERGE,
        { inputFile: 'main.tex', editedFile: 'new.tex' },
      ],
      information('Merging files: main.tex and new.tex'),
    ]);
  });

  it.each([
    { inputFiles: [] as string[], editedFile: 'new.tex' },
    { inputFiles: ['main.tex'], editedFile: '' },
  ])('rejects merge when either required file is absent', (state) => {
    selectFiles(state.inputFiles, 'old.tex', state.editedFile);

    runLatexDiffsAction('merge');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose both the input and edited files to merge.'),
    ]);
  });

  it.each([
    ['compare' as const, MAIN_VIEW_COMMANDS.COMPARE],
    ['accept' as const, MAIN_VIEW_COMMANDS.ACCEPT_EDITED],
  ])('posts the exact %s file-operation message', (action, command) => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');

    runLatexDiffsAction(action);

    expect(mocks.postMessage.mock.calls).toEqual([
      [command, { baseFile: 'old.tex', editedFile: 'new.tex' }],
    ]);
  });

  it.each([
    { baseFile: '', editedFile: 'new.tex' },
    { baseFile: 'old.tex', editedFile: '' },
  ])('rejects compare when either required file is absent', (state) => {
    selectFiles(['main.tex'], state.baseFile, state.editedFile);

    runLatexDiffsAction('compare');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose both the base and edited files to compare.'),
    ]);
  });
});
