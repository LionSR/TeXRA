/**
 * User-action logic and shared mutators for the Main view.
 *
 * These functions operate on the module-scope signals in `mainViewState.ts`
 * and persist through `persistence.ts`. They are shared by the backend
 * message slices (`slices/`) and by `MainApp`'s DOM event handlers.
 */

// Local imports - shared IPC and helpers
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ActionDetail,
  CompareMessage,
  LatexDiffsActionDetail,
  LatexdiffMessage,
  LatexdiffvcMessage,
  LaunchTarget,
  MergeMessage,
  MultiFiles,
  PackLatexdiffvcMessage,
  PackMultipleMessage,
} from '@shared/schemas';
import { buildMainViewExecuteMessage } from '@shared/mainView/executeMessage';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';

// Local imports - utilities
import { capitalize } from '@utils/text/stringUtils';

// Local imports - main view
import {
  SESSION_TYPES,
  parseSessionType,
  type DocumentFileType,
  type MultipleDocumentFileType,
  type SessionType,
} from './constants';
import {
  agentConfigBanner$,
  apiKeyBanner$,
  checkboxValues$,
  commit$,
  getModelOptionsForSession,
  instruction$,
  instructionPlaceholder$,
  isPolishing$,
  isRecording$,
  isSelectedAgentOrchestrator$,
  launchTarget$,
  model$,
  multiFiles$,
  primaryInputFile,
  selectedTeamId$,
  sessionType$,
  singleFiles$,
  statusAnnouncement$,
  teamOptions$,
  toolUseAgent$,
  toolUseInstruction$,
  workflowAgent$,
  workflowInstruction$,
} from './mainViewState';
import { saveState } from './persistence';
import {
  FILE_UPDATE_COMMANDS,
  KEY_TO_FILE_TYPE,
  ONBOARDING_PLACEHOLDERS,
} from './store';

export function showInformation(text: string): void {
  postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
    text,
  });
}

// ---------------------------------------------------------------------------
// Instruction / session-mode helpers
// ---------------------------------------------------------------------------

export function setInstruction(value: string): void {
  instruction$.set(value);
  if (sessionType$.get() === SESSION_TYPES.WORKFLOW) {
    workflowInstruction$.set(value);
  } else {
    toolUseInstruction$.set(value);
  }
}

/** Stash instruction for the mode being left, restore for the mode being entered. */
export function swapModeInstruction(from: SessionType, to: SessionType): void {
  if (from === to) return;
  if (from === SESSION_TYPES.WORKFLOW) {
    workflowInstruction$.set(instruction$.get());
  } else {
    toolUseInstruction$.set(instruction$.get());
  }
  instruction$.set(
    to === SESSION_TYPES.WORKFLOW
      ? workflowInstruction$.get()
      : toolUseInstruction$.get(),
  );
}

export function refreshInstructionPlaceholder(): void {
  // Team runs share the orchestrator placeholder set: the team lead plans
  // and delegates, so the steering examples are the same shape.
  const placeholderKey: keyof typeof ONBOARDING_PLACEHOLDERS =
    launchTarget$.get() === 'team' || isSelectedAgentOrchestrator$.get()
      ? 'orchestrator'
      : sessionType$.get();
  const placeholders = ONBOARDING_PLACEHOLDERS[placeholderKey];
  if (!placeholders.length) return;
  const current = instructionPlaceholder$.get();
  const currentIndex = placeholders.indexOf(current);
  if (!current || currentIndex === -1) {
    instructionPlaceholder$.set(placeholders[0]);
  }
}

/**
 * Push a status line to the panel's aria-live region. Clear-then-set across a
 * microtask so repeated identical messages still re-announce: the clear render
 * commits before the set render (Lit flushes updates in a microtask queued
 * ahead of ours), so assistive tech observes a removal + insertion.
 */
export function announce(message: string): void {
  statusAnnouncement$.set('');
  queueMicrotask(() => statusAnnouncement$.set(message));
}

// ---------------------------------------------------------------------------
// Selection validation
// ---------------------------------------------------------------------------

/**
 * Validates that a selection exists in options.
 * Returns current value if found, otherwise falls back to first available option.
 */
export function validateSelection<
  T extends { value: string; disabled?: boolean },
>(options: T[], currentValue: string, preferEnabled = false): string {
  const current = options.find((opt) => opt.value === currentValue);
  if (current && (!preferEnabled || !current.disabled)) {
    return currentValue;
  }

  // Fallback: prefer enabled options (for models with missing API keys)
  if (preferEnabled) {
    const firstEnabled = options.find((opt) => !opt.disabled);
    if (firstEnabled) return firstEnabled.value;
  }
  if (current) return currentValue;
  return options[0]?.value ?? '';
}

export function refreshModelSelectionForActiveSession(): void {
  const options = getModelOptionsForSession(sessionType$.get());
  model$.set(
    validateSelection(
      options,
      model$.get(),
      true, // preferEnabled: skip disabled models
    ),
  );
}

export function enterToolUseSession(): void {
  if (sessionType$.get() !== SESSION_TYPES.TOOL_USE) {
    swapModeInstruction(sessionType$.get(), SESSION_TYPES.TOOL_USE);
    sessionType$.set(SESSION_TYPES.TOOL_USE);
    updateMultiFiles('outputFiles', []);
    refreshModelSelectionForActiveSession();
  }
  refreshInstructionPlaceholder();
  saveState();
}

// ---------------------------------------------------------------------------
// File mutations
// ---------------------------------------------------------------------------

export function updateMultiFiles(
  listId: keyof MultiFiles,
  files: string[],
): void {
  multiFiles$.set({ ...multiFiles$.get(), [listId]: files });
  saveState();

  const fileType = KEY_TO_FILE_TYPE[listId];
  const command = FILE_UPDATE_COMMANDS[fileType];
  if (command) {
    postMessage(command, { fileType, files });
  }
}

export function updateCheckboxValue(id: string, checked: boolean): void {
  const cv = checkboxValues$.get();
  if (!(id in cv)) return;
  checkboxValues$.set({
    ...cv,
    [id]: checked,
  });
  saveState();
}

export function removeFile(listId: keyof MultiFiles, file: string): void {
  const files = (multiFiles$.get()[listId] ?? []).filter(
    (f: string) => f !== file,
  );
  updateMultiFiles(listId, files);
}

export function selectMultipleFiles(listId: string): void {
  // Hint the OS dialog with the head of the multi-list (the "primary"
  // file post-collapse) so it opens at the right folder.
  const fileType = listId.replace('Files', '');
  const mf = multiFiles$.get();
  const listKey = listId as keyof MultiFiles;
  const currentFile = (mf[listKey] ?? [])[0];
  postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
    fileType,
    currentFile,
  });
}

export function addOpenedFiles(type: DocumentFileType): void {
  postMessage(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES, {
    fileType: type,
  });
}

export function getCurrentFile(
  type: DocumentFileType | 'base' | 'edited',
): void {
  const payload: Record<string, unknown> = { fileType: type };
  const sf = singleFiles$.get();
  if ((type === 'base' || type === 'edited') && sf.baseFile) {
    payload.baseFile = sf.baseFile;
  }
  postMessage(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE, payload);
}

// No-op for input/context/media so the LatexDiffsSection event signature
// (DocumentFileType union) stays compatible — only base/edited can be cleared.
export function emptyFile(type: DocumentFileType | 'base' | 'edited'): void {
  if (type !== 'base' && type !== 'edited') return;
  const sf = singleFiles$.get();
  singleFiles$.set({
    ...sf,
    [type === 'base' ? 'baseFile' : 'editedFile']: '',
  });
  saveState();
}

export function emptyFiles(type: MultipleDocumentFileType): void {
  const listId = `${type}Files`;
  updateMultiFiles(listId as keyof MultiFiles, []);
}

export function refreshEditedFiles(): void {
  postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
    baseFile: singleFiles$.get().baseFile,
    notifyWhenEmpty: true,
  });
}

export function setBaseFile(value: string): void {
  singleFiles$.set({ ...singleFiles$.get(), baseFile: value });
  saveState();
  postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
    baseFile: value,
  });
}

export function setEditedFile(value: string): void {
  singleFiles$.set({
    ...singleFiles$.get(),
    editedFile: value,
  });
  saveState();
}

export function setCommit(value: string): void {
  commit$.set(value);
  saveState();
}

// ---------------------------------------------------------------------------
// Session / agent / model changes (user-driven)
// ---------------------------------------------------------------------------

export function changeSessionType(value: string): void {
  const parsed = parseSessionType(value) ?? SESSION_TYPES.WORKFLOW;
  const prev = sessionType$.get();

  // Workflows run a single workflow agent, so a team launch target cannot
  // survive the transition — drop back to the agent launcher in the same
  // save rather than leaving a hidden team selection behind.
  const resetTeamLauncher =
    parsed === SESSION_TYPES.WORKFLOW && launchTarget$.get() === 'team';
  if (resetTeamLauncher) {
    launchTarget$.set('agent');
    announce('Workflow uses a single workflow agent.');
  }
  if (parsed === prev) {
    if (resetTeamLauncher) {
      refreshInstructionPlaceholder();
      saveState();
    }
    return;
  }

  swapModeInstruction(prev, parsed);
  sessionType$.set(parsed);
  refreshModelSelectionForActiveSession();
  refreshInstructionPlaceholder();
  if (parsed === SESSION_TYPES.TOOL_USE) {
    updateMultiFiles('outputFiles', []);
  }
  saveState();
}

/**
 * Switch between the single-agent and team launchers. Team runs are
 * interactive-only, so entering team mode from workflow reuses the shared
 * tool-use transition (draft retention, model revalidation, output reset);
 * leaving team mode never resurrects workflow.
 */
export function changeLaunchTarget(value: LaunchTarget): void {
  if (value === launchTarget$.get()) return;
  if (value === 'team') {
    const resolution = reconcileTeamSelection();
    if (resolution.status === 'unavailable') {
      announce('No runnable teams available. Agent launcher selected.');
      return;
    }
    launchTarget$.set('team');
    enterToolUseSession();
    announce('Team launcher selected. Interactive mode.');
  } else {
    launchTarget$.set('agent');
    refreshInstructionPlaceholder();
    saveState();
    announce('Agent launcher selected.');
  }
}

export function changeTeam(value: string): void {
  selectedTeamId$.set(value);
  saveState();
}

/**
 * Reconcile a team ID against the latest catalog without persistence or
 * announcements, so callers control when the reconciled state is saved and
 * announced. Only absence from a non-empty snapshot proves
 * deletion: every successful catalog contains the built-in presets, so empty
 * represents an incomplete or transient snapshot. Present-but-disabled teams
 * remain selected because their availability may recover.
 */
type TeamSelectionResolution =
  | { status: 'unchanged' }
  | { status: 'fallback'; label: string }
  | { status: 'unavailable' };

function reconcileTeamSelection(): TeamSelectionResolution {
  const options = teamOptions$.get();
  if (options.length === 0) return { status: 'unchanged' };
  const current = options.find((opt) => opt.value === selectedTeamId$.get());
  if (current) return { status: 'unchanged' };
  const fallback = options.find((opt) => !opt.disabled);
  if (!fallback) return { status: 'unavailable' };
  selectedTeamId$.set(fallback.value);
  return { status: 'fallback', label: fallback.label };
}

/** Validate and persist an active restored Team after a host catalog push. */
export function validateTeamSelection(): void {
  if (launchTarget$.get() !== 'team') return;
  const resolution = reconcileTeamSelection();
  if (resolution.status === 'unchanged') return;
  if (resolution.status === 'fallback') {
    announce(
      `Selected team is no longer available. Switched to "${resolution.label}".`,
    );
  } else {
    launchTarget$.set('agent');
    announce('No runnable teams available. Agent launcher selected.');
  }
  refreshInstructionPlaceholder();
  saveState();
}

export function changeAgent(sessionType: SessionType, value: string): void {
  if (sessionType === SESSION_TYPES.WORKFLOW) {
    workflowAgent$.set(value);
  } else {
    toolUseAgent$.set(value);
  }
  swapModeInstruction(sessionType$.get(), sessionType);
  sessionType$.set(sessionType);
  refreshModelSelectionForActiveSession();
  refreshInstructionPlaceholder();
  saveState();
  postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
}

export function changeModel(value: string): void {
  model$.set(value);
  saveState();
  postMessage(MAIN_VIEW_COMMANDS.MODEL_SELECTED, { model: value });
}

// ---------------------------------------------------------------------------
// Execute / panel actions
// ---------------------------------------------------------------------------

export function buildExecuteMessage(): MainViewExecuteMessage {
  const sessionType = sessionType$.get();
  const launchTarget =
    sessionType === SESSION_TYPES.WORKFLOW ? 'agent' : launchTarget$.get();
  return buildMainViewExecuteMessage({
    sessionType,
    workflowAgent: workflowAgent$.get(),
    // Team runs still send the current tool-use agent: the host resolves the
    // roster root from teamId, and `agent` stays required by validation.
    toolUseAgent: toolUseAgent$.get(),
    model: model$.get(),
    instruction: instruction$.get(),
    singleFiles: singleFiles$.get(),
    multiFiles: multiFiles$.get(),
    checkboxValues: checkboxValues$.get(),
    session: {
      launchTarget,
      teamId:
        launchTarget === 'team'
          ? selectedTeamId$.get() || undefined
          : undefined,
    },
  });
}

export function executeAgent(): void {
  postMessage(MAIN_VIEW_COMMANDS.EXECUTE, buildExecuteMessage());
}

function polishInstruction(): void {
  const instructionText = instruction$.get();
  if (!instructionText.trim()) return;

  const executionMessage = buildExecuteMessage();
  const files = executionMessage.files ?? {};
  isPolishing$.set(true);
  postMessage(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT, {
    text: instructionText,
    agent: executionMessage.agent,
    model: model$.get(),
    editedFile: files.editedFile,
    baseFile: files.baseFile,
    inputFiles: files.inputFiles,
    inputFilesActive: files.inputFilesActive,
    contextFiles: files.contextFiles,
    contextFilesActive: files.contextFilesActive,
    mediaFiles: files.mediaFiles,
    mediaFilesActive: files.mediaFilesActive,
  });
}

function toggleRecording(): void {
  postMessage(
    isRecording$.get()
      ? MAIN_VIEW_COMMANDS.STOP_RECORDING
      : MAIN_VIEW_COMMANDS.START_RECORDING,
  );
}

export function runPanelAction(action: ActionDetail['action']): void {
  switch (action) {
    case 'pack':
    case 'clean': {
      const inputFile = primaryInputFile();
      const selectedModel = model$.get();
      if (!inputFile || !selectedModel) {
        showInformation(
          'Please select all required fields (input file and model)',
        );
        break;
      }

      const filteredInputs = multiFiles$.get().inputFiles.filter(Boolean);
      const additionalInputFiles = filteredInputs.slice(1);
      const useMultiple = additionalInputFiles.length > 0;

      let command: string;
      if (action === 'pack') {
        command = useMultiple
          ? MAIN_VIEW_COMMANDS.PACK_MULTIPLE
          : MAIN_VIEW_COMMANDS.PACK_SINGLE;
      } else {
        command = useMultiple
          ? MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE
          : MAIN_VIEW_COMMANDS.CLEAN_SINGLE;
      }

      const isToolUse = sessionType$.get() === SESSION_TYPES.TOOL_USE;
      postMessage(command, {
        inputFile,
        agent: isToolUse ? toolUseAgent$.get() : workflowAgent$.get(),
        model: selectedModel,
        inputFiles: useMultiple ? additionalInputFiles : undefined,
      } satisfies Omit<PackMultipleMessage, 'command'>);

      const actionLabel = capitalize(action);
      showInformation(
        useMultiple
          ? `${actionLabel}ing multiple files: ${filteredInputs.join(', ')}`
          : `${actionLabel}ing single file: ${inputFile}`,
      );
      break;
    }
    case 'polish':
      polishInstruction();
      break;
    case 'record':
      toggleRecording();
      break;
    case 'erase':
      setInstruction('');
      saveState();
      break;
  }
}

export function runLatexDiffsAction(
  action: LatexDiffsActionDetail['action'],
): void {
  const sf = singleFiles$.get();
  switch (action) {
    case 'latexdiff': {
      postMessage(MAIN_VIEW_COMMANDS.LATEXDIFF, {
        inputFile: primaryInputFile(),
        baseFile: sf.baseFile,
        editedFile: sf.editedFile,
      } satisfies Omit<LatexdiffMessage, 'command'>);
      showInformation(
        `Running LaTeX diff between ${sf.baseFile} and ${sf.editedFile}`,
      );
      break;
    }
    case 'latexdiffvc': {
      const commitHash = commit$.get();
      postMessage(MAIN_VIEW_COMMANDS.LATEXDIFFVC, {
        inputFile: primaryInputFile(),
        baseFile: sf.baseFile,
        commitHash,
      } satisfies Omit<LatexdiffvcMessage, 'command'>);
      showInformation(
        `Running LaTeX diff with version control: ${sf.baseFile} at commit ${commitHash}`,
      );
      break;
    }
    case 'packLatexdiffvc':
    case 'cleanLatexdiffvc': {
      const commitHash = commit$.get();
      const clean = action === 'cleanLatexdiffvc';
      const command = clean
        ? MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC
        : MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC;
      postMessage(command, {
        inputFile: primaryInputFile(),
        baseFile: sf.baseFile,
        commitHash,
        clean,
      } satisfies Omit<PackLatexdiffvcMessage, 'command'>);
      const actionLabel = clean ? 'Clean' : 'Pack';
      showInformation(
        `${actionLabel}ing LaTeX diff with version control: ${sf.baseFile} at commit ${commitHash}`,
      );
      break;
    }
    case 'merge': {
      const inputFile = primaryInputFile();
      if (!inputFile || !sf.editedFile) {
        showInformation('Please select both input and edited files to merge');
        break;
      }
      postMessage(MAIN_VIEW_COMMANDS.MERGE, {
        inputFile,
        editedFile: sf.editedFile,
      } satisfies Omit<MergeMessage, 'command'>);
      showInformation(`Merging files: ${inputFile} and ${sf.editedFile}`);
      break;
    }
    case 'compare':
    case 'accept': {
      if (!sf.baseFile || !sf.editedFile) {
        showInformation('Please select both base and edited files to compare');
        break;
      }
      const command =
        action === 'compare'
          ? MAIN_VIEW_COMMANDS.COMPARE
          : MAIN_VIEW_COMMANDS.ACCEPT_EDITED;
      postMessage(command, {
        baseFile: sf.baseFile,
        editedFile: sf.editedFile,
      } satisfies Omit<CompareMessage, 'command'>);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Banner actions (user-driven)
// ---------------------------------------------------------------------------

export function runApiKeyBannerAction(action: 'set' | 'guide'): void {
  const { provider } = apiKeyBanner$.get();
  if (action === 'set') {
    const command = provider
      ? MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY
      : MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY;
    postMessage(command, provider ? { provider } : undefined);
    return;
  }
  const command = provider
    ? MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL
    : MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE;
  postMessage(command, provider ? { provider } : undefined);
}

export function runAgentConfigAction(action: 'edit' | 'dir' | 'docs'): void {
  switch (action) {
    case 'edit':
      postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS, {
        sessionType: sessionType$.get(),
      });
      break;
    case 'dir':
      postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, {
        customDirSet: agentConfigBanner$.get().customDirSet,
      });
      break;
    case 'docs':
      postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS);
      break;
  }
}
