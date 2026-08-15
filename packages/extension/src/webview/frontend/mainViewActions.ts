/**
 * User-action logic and shared mutators for the Main view.
 *
 * These functions operate on the module-scope signals in `mainViewState.ts`
 * and are shared by the backend message slices (`slices/`) and by `MainApp`'s
 * DOM event handlers. None of them persist: `persistence.ts` watches the
 * signals and owns every write.
 */

// Local imports - shared IPC and helpers
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ActionDetail,
  CompareMessage,
  LatexdiffMessage,
  LatexDiffsActionDetail,
  LatexdiffvcMessage,
  LaunchTarget,
  MainViewExecuteMessage,
  MergeMessage,
  MultiFiles,
  PackLatexdiffvcMessage,
  PackMultipleMessage,
} from '@shared/schemas';
import { buildMainViewExecuteMessage } from '@shared/mainView/executionFormState';

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
  agent$,
  instructionDrafts$,
  workingDirectory$,
} from './mainViewState';
import {
  MULTI_FILE_LIST_BY_KEY,
  MULTI_FILE_LISTS,
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
  instructionDrafts$.set({
    ...instructionDrafts$.get(),
    [sessionType$.get()]: value,
  });
}

export function refreshInstructionPlaceholder(): void {
  // Team runs share the orchestrator placeholder set: the team lead plans
  // and delegates, so the steering examples are the same shape.
  const placeholderKey: keyof typeof ONBOARDING_PLACEHOLDERS =
    launchTarget$.get() === 'team' || isSelectedAgentOrchestrator$.get()
      ? 'orchestrator'
      : sessionType$.get();
  const placeholders = ONBOARDING_PLACEHOLDERS[placeholderKey];
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
 * Resolve the model selection against the current options: keep the current
 * value when it is present and enabled, otherwise prefer the first enabled
 * option (models with a missing API key are disabled), then the current
 * value even though it is disabled, then the first option.
 */
function validateSelection<T extends { value: string; disabled?: boolean }>(
  options: T[],
  currentValue: string,
): string {
  const current = options.find((opt) => opt.value === currentValue);
  if (current && !current.disabled) {
    return currentValue;
  }

  const firstEnabled = options.find((opt) => !opt.disabled);
  if (firstEnabled) return firstEnabled.value;
  if (current) return currentValue;
  return options[0]?.value ?? '';
}

export function refreshModelSelectionForActiveSession(): void {
  const options = getModelOptionsForSession(sessionType$.get());
  model$.set(validateSelection(options, model$.get()));
}

export function enterToolUseSession(): void {
  if (sessionType$.get() !== SESSION_TYPES.TOOL_USE) {
    sessionType$.set(SESSION_TYPES.TOOL_USE);
    updateMultiFiles('outputFiles', []);
    refreshModelSelectionForActiveSession();
  }
  refreshInstructionPlaceholder();
}

// ---------------------------------------------------------------------------
// File mutations
// ---------------------------------------------------------------------------

export function updateMultiFiles(
  listId: keyof MultiFiles,
  files: string[],
): void {
  multiFiles$.set({ ...multiFiles$.get(), [listId]: files });
}

export function updateCheckboxValue(id: string, checked: boolean): void {
  const cv = checkboxValues$.get();
  if (!(id in cv)) return;
  checkboxValues$.set({
    ...cv,
    [id]: checked,
  });
}

export function removeFile(listId: keyof MultiFiles, file: string): void {
  const files = multiFiles$.get()[listId].filter((f) => f !== file);
  updateMultiFiles(listId, files);
}

export function selectMultipleFiles(listId: keyof MultiFiles): void {
  // Hint the OS dialog with the head of the multi-list (the "primary"
  // file post-collapse) so it opens at the right folder.
  const currentFile = multiFiles$.get()[listId][0];
  postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
    fileType: MULTI_FILE_LIST_BY_KEY[listId].fileType,
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
  const sf = singleFiles$.get();
  const payload: { fileType: typeof type; baseFile?: string } =
    (type === 'base' || type === 'edited') && sf.baseFile
      ? { fileType: type, baseFile: sf.baseFile }
      : { fileType: type };
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
}

export function emptyFiles(type: MultipleDocumentFileType): void {
  updateMultiFiles(MULTI_FILE_LISTS[type].key, []);
}

export function refreshEditedFiles(): void {
  postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
    baseFile: singleFiles$.get().baseFile,
    notifyWhenEmpty: true,
  });
}

export function setBaseFile(value: string): void {
  singleFiles$.set({ ...singleFiles$.get(), baseFile: value });
  postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
    baseFile: value,
  });
}

// ---------------------------------------------------------------------------
// Session / agent / model changes (user-driven)
// ---------------------------------------------------------------------------

export function changeSessionType(value: string): void {
  const parsed = parseSessionType(value) ?? SESSION_TYPES.WORKFLOW;
  const prev = sessionType$.get();

  // Workflows run a single workflow agent, so a team launch target cannot
  // survive the transition — drop back to the agent launcher rather than
  // leaving a hidden team selection behind.
  const resetTeamLauncher =
    parsed === SESSION_TYPES.WORKFLOW && launchTarget$.get() === 'team';
  if (resetTeamLauncher) {
    launchTarget$.set('agent');
    announce('Workflow uses a single workflow agent.');
  }
  if (parsed === prev) {
    if (resetTeamLauncher) {
      refreshInstructionPlaceholder();
    }
    return;
  }

  sessionType$.set(parsed);
  refreshModelSelectionForActiveSession();
  refreshInstructionPlaceholder();
  if (parsed === SESSION_TYPES.TOOL_USE) {
    updateMultiFiles('outputFiles', []);
  }
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
    announce('Agent launcher selected.');
  }
}

export function changeTeam(value: string): void {
  selectedTeamId$.set(value);
}

export function changeWorkingDirectory(value: string): void {
  workingDirectory$.set(value);
}

/**
 * Reconcile a team ID against the latest catalog without announcing, so
 * callers control what the user is told. Only absence from a non-empty
 * snapshot proves
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

/** Validate an active restored Team after a host catalog push. */
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
}

export function changeAgent(sessionType: SessionType, value: string): void {
  agent$.set({ ...agent$.get(), [sessionType]: value });
  sessionType$.set(sessionType);
  refreshModelSelectionForActiveSession();
  refreshInstructionPlaceholder();
  postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
}

// ---------------------------------------------------------------------------
// Execute / panel actions
// ---------------------------------------------------------------------------

export function buildExecuteMessage(): MainViewExecuteMessage {
  const sessionType = sessionType$.get();
  const launchTarget =
    sessionType === SESSION_TYPES.WORKFLOW ? 'agent' : launchTarget$.get();
  const workingDirectory = workingDirectory$.get().trim();
  // Team runs still send the current tool-use agent: the host resolves the
  // roster root from teamId, and `agent` stays required by validation.
  return buildMainViewExecuteMessage({
    sessionType,
    agent: agent$.get(),
    model: model$.get(),
    instruction: instruction$.get(),
    singleFiles: singleFiles$.get(),
    multiFiles: multiFiles$.get(),
    checkboxValues: checkboxValues$.get(),
    session: {
      launchTarget,
      ...(workingDirectory ? { workingDirectory } : {}),
      teamId:
        launchTarget === 'team'
          ? selectedTeamId$.get() || undefined
          : undefined,
    },
  });
}

/** Post the current form state to the host as an EXECUTE message. */
export function sendExecuteMessage(): void {
  postMessage(MAIN_VIEW_COMMANDS.EXECUTE, buildExecuteMessage());
}

function polishInstruction(): void {
  const instructionText = instruction$.get();
  if (!instructionText.trim()) {
    // The button stays enabled, so mirror the pack/clean actions and tell the
    // user why nothing happened.
    showInformation('Enter an instruction to polish first.');
    return;
  }

  const executionMessage = buildExecuteMessage();
  const files = executionMessage.files ?? {};
  isPolishing$.set(true);
  postMessage(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT, {
    text: instructionText,
    agent: executionMessage.agent,
    model: model$.get(),
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

const SINGLE_FILE_PACK_COMMANDS = {
  pack: MAIN_VIEW_COMMANDS.PACK_SINGLE,
  clean: MAIN_VIEW_COMMANDS.CLEAN_SINGLE,
} as const;

const MULTI_FILE_PACK_COMMANDS = {
  pack: MAIN_VIEW_COMMANDS.PACK_MULTIPLE,
  clean: MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE,
} as const;

export function runPanelAction(action: ActionDetail['action']): void {
  switch (action) {
    case 'pack':
    case 'clean': {
      const inputFile = primaryInputFile();
      const selectedModel = model$.get();
      if (!inputFile || !selectedModel) {
        showInformation('Choose an input file and a model first.');
        break;
      }

      const filteredInputs = multiFiles$.get().inputFiles.filter(Boolean);
      const additionalInputFiles = filteredInputs.slice(1);
      const useMultiple = additionalInputFiles.length > 0;

      const command = useMultiple
        ? MULTI_FILE_PACK_COMMANDS[action]
        : SINGLE_FILE_PACK_COMMANDS[action];

      postMessage(command, {
        inputFile,
        agent: agent$.get()[sessionType$.get()],
        model: selectedModel,
        inputFiles: useMultiple ? additionalInputFiles : undefined,
      } satisfies Omit<PackMultipleMessage, 'command'>);

      const progressLabel = action === 'clean' ? 'Cleaning' : 'Packing';
      showInformation(
        useMultiple
          ? `${progressLabel} multiple files: ${filteredInputs.join(', ')}`
          : `${progressLabel} single file: ${inputFile}`,
      );
      break;
    }
    case 'polish':
      polishInstruction();
      break;
    case 'record':
      toggleRecording();
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
      const progressLabel = clean ? 'Cleaning' : 'Packing';
      showInformation(
        `${progressLabel} LaTeX diff with version control: ${sf.baseFile} at commit ${commitHash}`,
      );
      break;
    }
    case 'merge': {
      const inputFile = primaryInputFile();
      if (!inputFile || !sf.editedFile) {
        showInformation('Choose both the input and edited files to merge.');
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
        showInformation('Choose both the base and edited files to compare.');
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
