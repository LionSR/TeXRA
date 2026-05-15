import { html, nothing, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { SignalWatcher, signal, Signal } from '@shared/signals';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { hostBridge, postMessage } from '@shared/hostBridge';
import { PersistedState, createWebviewStorage } from '@shared/state';
import { designTokens, commonViewStyles, viewTabStyles } from '@shared/styles';
import {
  mainViewMessages,
  MainViewPersistedStateSchema,
  type MainViewMessage,
  type MainViewPersistedState,
  type ApiKeyBannerState,
  type AgentConfigBannerState,
  type DependencyBannerState,
  type ModelOptionData,
  type AgentOptionData,
  type SingleFiles,
  type FileOptions,
  type MultiFiles,
  type MultiFilesVisible,
  type CheckboxValues,
  type ActionDetail,
  type AgentChangeDetail,
  type BannerActionDetail,
  type BaseFileChangeDetail,
  type CheckboxChangeDetail,
  type CommitChangeDetail,
  type EditedFileChangeDetail,
  type FileActionDetail,
  type FocusInstructionDetail,
  type InstallGuideDetail,
  type InstructionChangeDetail,
  type LatexDiffsActionDetail,
  type LatexDiffsToggleDetail,
  type ModelChangeDetail,
  type MultipleFilesActionDetail,
  type MultipleFilesTypeActionDetail,
  type ReorderFilesDetail,
  type RemoveFileDetail,
  type SessionTypeChangeDetail,
} from '@shared/schemas';
import {
  registerTeXRAWebAwesomeIcons,
  TEXRA_ICON_LIBRARY,
} from '@shared/wa/webAwesomeIcons';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';
import { agentName } from '@shared/schemas/agent';
import { capitalize } from '@shared/utils/string';
import '@shared/wa/tabs';
import type { MutableWaTabGroup, WaTabShowEvent } from '@shared/wa/tabs';

import './components/FileSelectGroup';
import './components/BannerGroup';
import './components/LatexDiffsSection';
import './components/InstructionPanel';
import './components/OutputFilesSection';
import {
  ELEMENT_IDS,
  DOCUMENT_FILE_TYPES,
  MULTIPLE_DOCUMENT_FILE_TYPES,
  SESSION_TYPES,
  type DocumentFileType,
  type MultipleDocumentFileType,
  type SessionType,
  parseSessionType,
} from './constants';
import {
  fileStateContext,
  sessionContext,
  type FileStateContextValue,
  type SessionContextValue,
} from './contexts/mainViewContexts';
import {
  dispatchMainViewMessage,
  type MainViewHandlerRegistry,
} from './mainViewDispatcher';
import { SESSION_DEFAULTS } from './sessionDefaults';
import {
  DEFAULT_STATE,
  DEFAULT_SINGLE_FILES,
  DEFAULT_FILE_OPTIONS,
  DEFAULT_MULTI_FILES,
  DEFAULT_MULTI_FILES_VISIBLE,
  DEFAULT_CHECKBOX_VALUES,
  FILE_UPDATE_COMMANDS,
  MULTI_FILE_COMMAND_TO_KEY,
  PLACEHOLDER_ROTATION_MS,
  ONBOARDING_PLACEHOLDERS,
  FILE_SELECT_CONFIGS,
} from './store';
import { mainViewStyles } from './styles';

registerTeXRAWebAwesomeIcons();

// Helper type for extracting specific message type from union
type MainViewMessageFor<C extends MainViewMessage['command']> = Extract<
  MainViewMessage,
  { command: C }
>;

type SetEditedFileOptionsMessage = MainViewMessageFor<
  typeof MAIN_VIEW_COMMANDS.SET_EDITED_FILE
>;

type EditedFileSelectedMessage = MainViewMessageFor<
  typeof MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED
>;

type SetMultipleFilesMessage =
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MEDIA_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES>;

// Cast: BaseWebviewApp is abstract, but SignalWatcher expects a concrete constructor.
// Safe because MainApp implements all abstract members below.
const MainAppBase = SignalWatcher(
  BaseWebviewApp as unknown as new (...args: any[]) => BaseWebviewApp,
);

@customElement('main-app')
export class MainApp extends MainAppBase {
  static styles = [
    designTokens,
    commonViewStyles,
    viewTabStyles,
    mainViewStyles,
  ];

  private readonly sessionType = signal<SessionType>(DEFAULT_STATE.sessionType);
  private readonly workflowAgent = signal(DEFAULT_STATE.workflowAgent);
  private readonly toolUseAgent = signal(DEFAULT_STATE.toolUseAgent);
  private readonly model = signal(DEFAULT_STATE.model);
  private readonly commit = signal(DEFAULT_STATE.commit);
  private readonly instruction = signal(DEFAULT_STATE.instruction);
  private readonly workflowInstruction = signal(
    DEFAULT_STATE.workflowInstruction,
  );
  private readonly toolUseInstruction = signal(
    DEFAULT_STATE.toolUseInstruction,
  );
  private readonly singleFiles = signal<SingleFiles>({
    ...DEFAULT_SINGLE_FILES,
  });
  private readonly fileOptions = signal<FileOptions>({
    ...DEFAULT_FILE_OPTIONS,
  });
  private readonly multiFiles = signal<MultiFiles>({ ...DEFAULT_MULTI_FILES });
  private readonly multiFilesVisible = signal<MultiFilesVisible>({
    ...DEFAULT_MULTI_FILES_VISIBLE,
  });
  private readonly outputFilesActive = signal(DEFAULT_STATE.outputFilesActive);
  private readonly latexdiffsVisible = signal(DEFAULT_STATE.latexdiffsVisible);
  private readonly checkboxValues = signal<CheckboxValues>({
    ...DEFAULT_CHECKBOX_VALUES,
  });
  // Tracks whether the workflow Files <wa-details> is open. Initialized to
  // match the initial session type and updated imperatively from
  // wa-show/wa-hide so user toggles survive across re-renders. Without this,
  // binding `?open=${isWorkflow}` would force the section open on every render
  // pass, defeating user collapses.
  private readonly fileSelectionOpen = signal(
    DEFAULT_STATE.sessionType === SESSION_TYPES.WORKFLOW,
  );
  private readonly isRecording = signal(false);
  private readonly isPolishing = signal(false);
  private readonly modelOptions = signal<ModelOptionData[]>([]);
  private readonly workflowAgentOptions = signal<AgentOptionData[]>([]);
  private readonly toolUseAgentOptions = signal<AgentOptionData[]>([]);
  private readonly apiKeyBanner = signal<ApiKeyBannerState>({ visible: false });
  private readonly agentConfigBanner = signal<AgentConfigBannerState>({
    visible: false,
  });
  private readonly dependencyBanner = signal<DependencyBannerState>({
    visible: false,
  });
  private readonly gettingStartedVisible = signal(false);
  private readonly sessionHintDismissed = signal(true);
  private readonly loginBannerVisible = signal(false);
  private readonly instructionPlaceholder = signal(
    ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0],
  );
  @state() protected override debugMode = false;
  private readonly isGitRepo = signal(true);
  private defaultOutputFiles: string[] = [];
  private instructionSaveTimer: number | null = null;

  private readonly fileStateContext$ = new Signal.Computed(
    (): FileStateContextValue => ({
      sessionType: this.sessionType.get(),
      checkboxValues: this.checkboxValues.get(),
      singleFiles: this.singleFiles.get(),
      fileOptions: this.fileOptions.get(),
      multiFiles: this.multiFiles.get(),
      multiFilesVisible: this.multiFilesVisible.get(),
      outputFilesActive: this.outputFilesActive.get(),
    }),
  );

  private readonly sessionContext$ = new Signal.Computed(
    (): SessionContextValue => ({
      sessionType: this.sessionType.get(),
      instruction: this.instruction.get(),
      placeholder: this.instructionPlaceholder.get(),
      workflowAgent: this.workflowAgent.get(),
      toolUseAgent: this.toolUseAgent.get(),
      model: this.model.get(),
      workflowAgentOptions: this.workflowAgentOptions.get(),
      toolUseAgentOptions: this.toolUseAgentOptions.get(),
      modelOptions: this.modelOptions.get(),
      isRecording: this.isRecording.get(),
      isPolishing: this.isPolishing.get(),
      debugMode: this.debugMode,
    }),
  );

  @provide({ context: fileStateContext })
  @state()
  private fileStateContextValue: FileStateContextValue =
    this.fileStateContext$.get();

  @provide({ context: sessionContext })
  @state()
  private sessionContextValue: SessionContextValue = this.sessionContext$.get();

  private readonly stateManager = new PersistedState(
    createWebviewStorage(hostBridge),
    'mainViewState',
    MainViewPersistedStateSchema,
  );
  private saveBlockCount = 0;
  private placeholderTimer: number | null = null;

  private readonly messageHandlers: MainViewHandlerRegistry = {
    [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (data) =>
      this.handleSetModelOptions(data),
    [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (data) =>
      this.handleSetAgentOptions(data),

    [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (data) =>
      this.handleSetEditedFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: (data) => this.handleSetBaseFile(data),

    [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (data) =>
      this.handleEditedFileSelected(data),

    [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES]: (data) =>
      this.handleSetDefaultOutputFiles(data),
    [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: (data) =>
      this.handleAddMediaFile(data),

    [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (data) =>
      this.handleSetRecentCommits(data),
    [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (data) =>
      this.handleSetCurrentFile(data),
    [MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT]: (data) =>
      this.handleSetSelectedCommit(data),
    [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (data) =>
      this.handleSetOpenedFiles(data),

    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (data) =>
      this.handleInstructionTextPolished(data),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]: (data) =>
      this.handleInstructionTextPolishError(data),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (data) =>
      this.handleInstructionTextTranscribed(data),

    [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: () => {
      this.isRecording.set(true);
    },
    [MAIN_VIEW_COMMANDS.RECORDING_STOPPED]: () => {
      this.isRecording.set(false);
    },
    [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: () => {
      this.isRecording.set(false);
    },

    [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (data) =>
      this.handleShowApiKeyBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () => {
      if (this.shouldForceApiKeyBanner()) {
        return;
      }
      this.apiKeyBanner.set({ visible: false });
    },
    [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (data) =>
      this.handleShowAgentConfigBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: () => {
      this.agentConfigBanner.set({ visible: false });
    },
    [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (data) =>
      this.handleShowDependencyBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: () => {
      this.dependencyBanner.set({ visible: false });
    },
    [MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER]: () => {
      this.gettingStartedVisible.set(true);
    },
    [MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER]: () => {
      this.gettingStartedVisible.set(false);
    },
    [MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER]: () => {
      this.sessionHintDismissed.set(true);
    },
    [MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER]: () => {
      this.sessionHintDismissed.set(false);
    },
    [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: () => {
      this.loginBannerVisible.set(true);
    },
    [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () => {
      this.loginBannerVisible.set(false);
    },

    [MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]: (data) =>
      this.handleSetSelectedAgent(data),
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.restorePersistedState();
  }

  override disconnectedCallback(): void {
    this.stopPlaceholderRotation();
    if (this.instructionSaveTimer) {
      window.clearTimeout(this.instructionSaveTimer);
      this.instructionSaveTimer = null;
      this.saveState();
    }
    super.disconnectedCallback();
  }

  protected handleMessage(raw: unknown): void {
    dispatchMainViewMessage(raw, this.messageHandlers, (error) => {
      this.logSchemaError(
        '[MainApp] Main view message validation failed.',
        error,
      );
    });
  }

  protected override firstUpdated(): void {
    this.requestInitialData();
    this.refreshInstructionPlaceholder(false);
  }

  /**
   * Sync signal-computed values into @provide/@state context properties.
   * SignalWatcher triggers requestUpdate() when any read signal changes,
   * so this runs only when computed values actually propagate.
   */
  protected override willUpdate(): void {
    this.fileStateContextValue = this.fileStateContext$.get();
    this.sessionContextValue = this.sessionContext$.get();
  }

  private blockSave(): void {
    this.saveBlockCount += 1;
  }

  private unblockSave(): void {
    if (this.saveBlockCount > 0) {
      this.saveBlockCount -= 1;
    }
  }

  private saveState(): void {
    if (this.saveBlockCount > 0) {
      return;
    }

    const sf = this.singleFiles.get();
    const mf = this.multiFiles.get();
    const mv = this.multiFilesVisible.get();
    const cv = this.checkboxValues.get();

    const persisted: MainViewPersistedState = {
      sessionType: this.sessionType.get(),
      workflowAgent: this.workflowAgent.get(),
      toolUseAgent: this.toolUseAgent.get(),
      model: this.model.get(),
      commit: this.commit.get(),
      instruction: this.instruction.get(),
      workflowInstruction: this.workflowInstruction.get(),
      toolUseInstruction: this.toolUseInstruction.get(),
      editedFile: sf.editedFile,
      baseFile: sf.baseFile,
      inputFiles: mf.inputFiles,
      contextFiles: mf.contextFiles,
      mediaFiles: mf.mediaFiles,
      outputFiles: mf.outputFiles,
      inputFilesVisible: mv.inputFiles,
      contextFilesVisible: mv.contextFiles,
      mediaFilesVisible: mv.mediaFiles,
      outputFilesVisible: mv.outputFiles,
      outputFilesActive: this.outputFilesActive.get(),
      latexdiffsVisible: this.latexdiffsVisible.get(),
      autoExtractFigure: cv.autoExtractFigure,
      autoExtractTikzFigure: cv.autoExtractTikzFigure,
      autoCompileInputPdf: cv.autoCompileInputPdf,
      attachTeXCount: cv.attachTeXCount,
      attachDiagnostics: cv.attachDiagnostics,
    };

    this.stateManager.setState(persisted);
  }

  private restorePersistedState(): void {
    // State is parsed through MainViewPersistedStateSchema which provides all defaults.
    // No manual fallbacks needed - schema handles missing/invalid values.
    const state = this.stateManager.getState();

    this.sessionType.set(state.sessionType);
    this.fileSelectionOpen.set(state.sessionType === SESSION_TYPES.WORKFLOW);
    this.workflowAgent.set(state.workflowAgent);
    this.toolUseAgent.set(state.toolUseAgent);
    this.model.set(state.model);
    this.commit.set(state.commit);

    this.restorePerModeInstructions(state);
    this.singleFiles.set({
      editedFile: state.editedFile,
      baseFile: state.baseFile,
    });
    this.multiFiles.set({
      inputFiles: state.inputFiles,
      contextFiles: state.contextFiles,
      mediaFiles: state.mediaFiles,
      outputFiles: state.outputFiles,
    });
    this.multiFilesVisible.set({
      inputFiles: state.inputFilesVisible,
      contextFiles: state.contextFilesVisible,
      mediaFiles: state.mediaFilesVisible,
      outputFiles: state.outputFilesVisible,
    });
    this.outputFilesActive.set(state.outputFilesActive);
    this.latexdiffsVisible.set(state.latexdiffsVisible);
    this.checkboxValues.set({
      autoExtractFigure: state.autoExtractFigure,
      autoExtractTikzFigure: state.autoExtractTikzFigure,
      autoCompileInputPdf: state.autoCompileInputPdf,
      attachTeXCount: state.attachTeXCount,
      attachDiagnostics: state.attachDiagnostics,
    });
  }

  private requestInitialData(): void {
    const commands = [
      MAIN_VIEW_COMMANDS.GET_THEME,
      MAIN_VIEW_COMMANDS.GET_DEBUG_MODE,
      // Multi-list refresh: backend pushes back the current input/context/media
      // pickable file lists for the base-file dropdown and the multi-file picker.
      MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES,
      MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    ];
    commands.forEach((command) => postMessage(command));

    const agent =
      this.sessionType.get() === SESSION_TYPES.TOOL_USE
        ? this.toolUseAgent.get()
        : this.workflowAgent.get();
    if (agent) {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES, { agent });
    }
  }

  private updateMultiFiles(listId: keyof MultiFiles, files: string[]): void {
    this.multiFiles.set({ ...this.multiFiles.get(), [listId]: files });
    this.saveState();

    const fileType = listId.replace('Files', '') as MultipleDocumentFileType;
    const command = FILE_UPDATE_COMMANDS[fileType];
    if (command) {
      postMessage(command, { fileType, files });
    }
  }

  private setInstruction(value: string): void {
    this.instruction.set(value);
    if (this.sessionType.get() === SESSION_TYPES.WORKFLOW) {
      this.workflowInstruction.set(value);
    } else {
      this.toolUseInstruction.set(value);
    }
  }

  /** Stash instruction for the mode being left, restore for the mode being entered. */
  private swapModeInstruction(from: SessionType, to: SessionType): void {
    if (from === to) return;
    if (from === SESSION_TYPES.WORKFLOW) {
      this.workflowInstruction.set(this.instruction.get());
    } else {
      this.toolUseInstruction.set(this.instruction.get());
    }
    this.instruction.set(
      to === SESSION_TYPES.WORKFLOW
        ? this.workflowInstruction.get()
        : this.toolUseInstruction.get(),
    );
  }

  /**
   * Restore per-mode instructions from persisted state, migrating the legacy
   * single `instruction` field for users who haven't saved per-mode fields yet.
   */
  private restorePerModeInstructions(state: MainViewPersistedState): void {
    const wf =
      state.workflowInstruction ||
      (state.sessionType === SESSION_TYPES.WORKFLOW ? state.instruction : '');
    const tu =
      state.toolUseInstruction ||
      (state.sessionType !== SESSION_TYPES.WORKFLOW ? state.instruction : '');
    this.workflowInstruction.set(wf);
    this.toolUseInstruction.set(tu);
    this.instruction.set(
      state.sessionType === SESSION_TYPES.WORKFLOW ? wf : tu,
    );
  }

  /**
   * Validates that a selection exists in options.
   * Returns current value if found, otherwise falls back to first available option.
   */
  private validateSelection<T extends { value: string; disabled?: boolean }>(
    options: T[],
    currentValue: string,
    preferEnabled = false,
  ): string {
    // Exact match
    if (options.some((opt) => opt.value === currentValue)) {
      return currentValue;
    }

    // Fallback: prefer enabled options (for models with missing API keys)
    if (preferEnabled) {
      const firstEnabled = options.find((opt) => !opt.disabled);
      if (firstEnabled) return firstEnabled.value;
    }
    return options[0]?.value ?? '';
  }

  private handleSetModelOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS>,
  ): void {
    if (!message.optionsData) return;

    this.modelOptions.set(message.optionsData);
    this.model.set(
      this.validateSelection(
        message.optionsData,
        this.model.get(),
        true, // preferEnabled: skip disabled models
      ),
    );
  }

  private handleSetAgentOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS>,
  ): void {
    const optionsData = message.optionsData ?? {};

    if (optionsData.workflow) {
      this.workflowAgentOptions.set(optionsData.workflow);
      this.workflowAgent.set(
        this.validateAgentSelection(
          optionsData.workflow,
          this.workflowAgent.get(),
        ),
      );
    }

    if (optionsData.toolUse) {
      this.toolUseAgentOptions.set(optionsData.toolUse);
      this.toolUseAgent.set(
        this.validateAgentSelection(
          optionsData.toolUse,
          this.toolUseAgent.get(),
        ),
      );
    }
  }

  /**
   * No silent fallback — if the agent is gone, keeps the stale value
   * so the dropdown shows no selection and execution errors explicitly.
   */
  private validateAgentSelection(
    options: AgentOptionData[],
    currentValue: string,
  ): string {
    if (options.some((opt) => opt.value === currentValue)) {
      return currentValue;
    }
    // Match by name: handles source changes and plain-name defaults
    const name = agentName(currentValue);
    const byName = options.find((opt) => opt.label === name);
    if (byName) return byName.value;
    // No match — keep stale value so the UI shows no selection.
    // Execution will error with "unknown agent" if the user proceeds.
    return currentValue;
  }

  private handleSetEditedFileOptions(
    message: SetEditedFileOptionsMessage,
  ): void {
    const files = message.files ?? [];
    this.fileOptions.set({ ...this.fileOptions.get(), editedFile: files });
    const currentValue = this.singleFiles.get().editedFile;
    if (currentValue && !files.includes(currentValue)) {
      this.singleFiles.set({ ...this.singleFiles.get(), editedFile: '' });
    }
    this.saveState();
  }

  private handleSetBaseFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_BASE_FILE>,
  ): void {
    const files = message.files ?? [];
    this.fileOptions.set({ ...this.fileOptions.get(), baseFile: files });

    if (
      !message.preserveBaseFile &&
      !files.includes(this.singleFiles.get().baseFile)
    ) {
      this.singleFiles.set({ ...this.singleFiles.get(), baseFile: '' });
    }

    this.saveState();
  }

  private handleEditedFileSelected(message: EditedFileSelectedMessage): void {
    this.singleFiles.set({
      ...this.singleFiles.get(),
      editedFile: message.filePath,
    });
    this.saveState();
  }

  private handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    const files = message.files ?? [];
    const listId = this.extractFileKeyFromCommand(
      message.command,
    ) as keyof MultiFiles;
    if (!listId) return;

    this.multiFiles.set({ ...this.multiFiles.get(), [listId]: files });
    this.multiFilesVisible.set({
      ...this.multiFilesVisible.get(),
      [listId]: files.length > 0,
    });
    if (listId === ELEMENT_IDS.OUTPUT_FILES) {
      this.outputFilesActive.set(files.length > 0);
    }
    this.saveState();
  }

  private handleSetDefaultOutputFiles(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES
    >,
  ): void {
    this.defaultOutputFiles = [...message.files];
    if (
      this.outputFilesActive.get() &&
      this.multiFiles.get().outputFiles.length === 0
    ) {
      this.initializeOutputFiles();
    }
  }

  private handleAddMediaFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE>,
  ): void {
    const file = message.file;
    const mf = this.multiFiles.get();
    const existing = mf.mediaFiles;
    if (existing.includes(file)) return;
    this.multiFiles.set({
      ...mf,
      mediaFiles: [...existing, file],
    });
    this.multiFilesVisible.set({
      ...this.multiFilesVisible.get(),
      mediaFiles: true,
    });
    this.saveState();
  }

  private handleSetRecentCommits(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS>,
  ): void {
    const commits = message.commits;
    const gitRepo = message.isGitRepo ?? true;
    this.isGitRepo.set(gitRepo);

    this.fileOptions.set({
      ...this.fileOptions.get(),
      commit: gitRepo ? commits : [],
    });

    const currentCommit = this.commit.get();
    if (!gitRepo) {
      this.commit.set('');
    } else if (!currentCommit || !this.hasCommitValue(currentCommit)) {
      this.commit.set('HEAD');
    }
    this.saveState();
  }

  private handleSetCurrentFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_CURRENT_FILE>,
  ): void {
    const { fileType, filePath } = message;
    if (!filePath) return;

    // Workflow categories (input/context/media): prepend the active editor's
    // file to the multi-list head so it becomes the "primary" file.
    if (DOCUMENT_FILE_TYPES.includes(fileType as DocumentFileType)) {
      const listId = `${fileType}Files` as keyof MultiFiles;
      const mf = this.multiFiles.get();
      const existing = mf[listId] ?? [];
      const next = [filePath, ...existing.filter((f) => f !== filePath)];
      this.multiFiles.set({ ...mf, [listId]: next });
      this.multiFilesVisible.set({
        ...this.multiFilesVisible.get(),
        [listId]: true,
      });
      this.saveState();
      return;
    }

    // Base/edited single-slot fields go through fileOptions like before.
    const key = `${fileType}File` as keyof FileOptions;
    const sf = this.singleFiles.get();
    if (!(key in sf)) return;
    const options = this.fileOptions.get()[key] ?? [];
    if (!options.includes(filePath)) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: `The current file is not in the ${fileType} file list: ${filePath}`,
      });
      return;
    }
    this.singleFiles.set({ ...sf, [key]: filePath });
    this.saveState();
  }

  private handleSetSelectedCommit(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT>,
  ): void {
    const commitHash = message.commitHash;
    const commitLabel = message.commitLabel ?? '';

    if (!commitHash) return;
    const fo = this.fileOptions.get();
    const options = fo.commit ?? [];
    if (!options.some((option) => option.startsWith(commitHash))) {
      this.fileOptions.set({
        ...fo,
        commit: [...options, commitLabel || commitHash],
      });
    }
    this.commit.set(commitHash);
    this.saveState();
  }

  private handleSetOpenedFiles(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_OPENED_FILES>,
  ): void {
    const fileType = message.fileType;
    const normalizedType = fileType.endsWith('Files')
      ? fileType
      : `${fileType}Files`;
    const listId = normalizedType as keyof MultiFiles;
    const mf = this.multiFiles.get();
    if (!(listId in mf)) return;

    const filesToAdd = message.files ?? [];
    const existing = mf[listId] ?? [];
    const merged = this.mergeUnique(existing, filesToAdd);
    this.multiFiles.set({ ...mf, [listId]: merged });
    this.multiFilesVisible.set({
      ...this.multiFilesVisible.get(),
      [listId]: true,
    });
    this.saveState();
  }

  private handleInstructionTextPolished(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED
    >,
  ): void {
    this.isPolishing.set(false);
    if (message.text.trim()) {
      this.setInstruction(message.text);
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Instruction text has been polished!',
      });
      this.saveState();
    }
  }

  private handleInstructionTextPolishError(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR
    >,
  ): void {
    this.isPolishing.set(false);
    const errorText = message.error ?? '';
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Error polishing text: ${errorText || 'Unknown error'}`,
    });
  }

  private handleInstructionTextTranscribed(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED
    >,
  ): void {
    if (!message.text) {
      this.isRecording.set(false);
      return;
    }

    const current = this.instruction.get();
    const updated = current ? `${current} ${message.text}` : message.text;
    this.setInstruction(updated);
    this.isRecording.set(false);
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: 'Instruction text transcribed!',
    });
    this.saveState();
  }

  protected override onStateRestore(message: StateRestoreMessage): void {
    this.handleRestoreState(message);
  }

  private handleRestoreState(message: StateRestoreMessage): void {
    if (message.isResetOperation === true) {
      this.clearForNewSession();
      return;
    }
    if (!message.state) {
      return;
    }

    const parsed = MainViewPersistedStateSchema.safeParse(message.state);
    if (!parsed.success) {
      this.logSchemaError(
        '[MainApp] State restore validation failed.',
        parsed.error,
      );
      return;
    }
    const state = parsed.data;
    this.blockSave();
    try {
      this.sessionType.set(state.sessionType);
      this.workflowAgent.set(state.workflowAgent);
      this.toolUseAgent.set(state.toolUseAgent);
      this.model.set(state.model);
      this.commit.set(state.commit);
      this.restorePerModeInstructions(state);
      this.singleFiles.set({
        editedFile: state.editedFile,
        baseFile: state.baseFile,
      });

      this.checkboxValues.set({
        autoExtractFigure: state.autoExtractFigure,
        autoExtractTikzFigure: state.autoExtractTikzFigure,
        autoCompileInputPdf: state.autoCompileInputPdf,
        attachTeXCount: state.attachTeXCount,
        attachDiagnostics: state.attachDiagnostics,
      });
      this.outputFilesActive.set(state.outputFilesActive);
      this.latexdiffsVisible.set(state.latexdiffsVisible);

      this.restoreFileArrays(state);
    } finally {
      this.unblockSave();
    }
    this.saveState();

    if (message.executeImmediately) {
      this.executeAgent();
    }
  }

  private restoreFileArrays(state: MainViewPersistedState): void {
    this.multiFiles.set(
      Object.fromEntries(
        MULTIPLE_DOCUMENT_FILE_TYPES.map((type) => {
          const key = `${type}Files` as keyof MultiFiles;
          const files = state[key as keyof MainViewPersistedState];
          return [key, Array.isArray(files) ? files : []];
        }),
      ) as MultiFiles,
    );

    this.multiFilesVisible.set(
      Object.fromEntries(
        MULTIPLE_DOCUMENT_FILE_TYPES.map((type) => {
          const key = `${type}Files` as keyof MultiFilesVisible;
          const visible =
            state[`${key}Visible` as keyof MainViewPersistedState];
          return [key, Boolean(visible)];
        }),
      ) as MultiFilesVisible,
    );
  }

  private clearForNewSession(): void {
    this.instruction.set('');
    this.workflowInstruction.set('');
    this.toolUseInstruction.set('');
    const defaults = SESSION_DEFAULTS[this.sessionType.get()];
    if (defaults.resetFiles) {
      this.singleFiles.set({
        editedFile: '',
        baseFile: '',
      });
      this.multiFiles.set({
        inputFiles: [],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
      });
      this.multiFilesVisible.set({
        inputFiles: false,
        contextFiles: false,
        mediaFiles: false,
        outputFiles: false,
      });
      if (defaults.checkboxOverrides) {
        this.checkboxValues.set({
          ...this.checkboxValues.get(),
          ...defaults.checkboxOverrides,
        });
      }
      if (defaults.outputFilesActive !== undefined) {
        this.outputFilesActive.set(defaults.outputFilesActive);
      }
    }
    this.saveState();
  }

  /**
   * Extracts the multi-list key from a SET_*_FILES command name.
   * Compile-time verifiable via the `MULTI_FILE_COMMAND_TO_KEY` map.
   */
  private extractFileKeyFromCommand(command: string): string | undefined {
    return MULTI_FILE_COMMAND_TO_KEY[command];
  }

  private toggleListVisibility(listId: keyof MultiFiles): void {
    const visible = !this.multiFilesVisible.get()[listId];
    this.multiFilesVisible.set({
      ...this.multiFilesVisible.get(),
      [listId]: visible,
    });
    if (listId === ELEMENT_IDS.OUTPUT_FILES) {
      this.outputFilesActive.set(visible);
      if (visible && this.multiFiles.get().outputFiles.length === 0) {
        this.initializeOutputFiles();
      }
    }
    this.saveState();
  }

  private initializeOutputFiles(): void {
    const primaryInput = this.multiFiles.get().inputFiles[0];
    if (!primaryInput) return;

    const initialFiles = this.getInitialOutputFiles();
    this.multiFiles.set({
      ...this.multiFiles.get(),
      outputFiles: initialFiles,
    });
  }

  private getInitialOutputFiles(): string[] {
    const mf = this.multiFiles.get();
    if (mf.outputFiles.length > 0) {
      return mf.outputFiles;
    }
    if (this.defaultOutputFiles.length > 0) {
      return this.defaultOutputFiles;
    }
    // Default: mirror the input list (so each input gets its own output slot).
    return [...mf.inputFiles];
  }

  private handleRemoveFile(listId: keyof MultiFiles, file: string): void {
    const files = (this.multiFiles.get()[listId] ?? []).filter(
      (f: string) => f !== file,
    );
    if (files.length === 0) {
      this.multiFilesVisible.set({
        ...this.multiFilesVisible.get(),
        [listId]: false,
      });
      if (listId === ELEMENT_IDS.OUTPUT_FILES) {
        this.outputFilesActive.set(false);
      }
    }
    this.updateMultiFiles(listId, files);
  }

  private handleSelectMultipleFiles(listId: string): void {
    // Hint the OS dialog with the head of the multi-list (the "primary"
    // file post-collapse) so it opens at the right folder.
    const fileType = listId.replace('Files', '');
    const mf = this.multiFiles.get();
    const listKey = listId as keyof MultiFiles;
    const currentFile = (mf[listKey] ?? [])[0];
    postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
      fileType,
      currentFile,
    });
  }

  private handleAddOpenedFiles(type: DocumentFileType): void {
    postMessage(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES, { fileType: type });
  }

  private handleGetCurrentFile(
    type: DocumentFileType | 'base' | 'edited',
  ): void {
    const payload: Record<string, unknown> = { fileType: type };
    const sf = this.singleFiles.get();
    if ((type === 'base' || type === 'edited') && sf.baseFile) {
      payload.baseFile = sf.baseFile;
    }
    postMessage(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE, payload);
  }

  // No-op for input/context/media so the LatexDiffsSection event signature
  // (DocumentFileType union) stays compatible — only base/edited can be cleared.
  private handleEmptyFile(type: DocumentFileType | 'base' | 'edited'): void {
    if (type !== 'base' && type !== 'edited') return;
    const sf = this.singleFiles.get();
    this.singleFiles.set({
      ...sf,
      [type === 'base' ? 'baseFile' : 'editedFile']: '',
    });
    this.saveState();
  }

  private handleRefreshEditedFiles(): void {
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
      baseFile: this.singleFiles.get().baseFile,
      notifyWhenEmpty: true,
    });
  }

  private handleEmptyFiles(type: MultipleDocumentFileType): void {
    const listId = `${type}Files`;
    this.multiFilesVisible.set({
      ...this.multiFilesVisible.get(),
      [listId]: false,
    });
    if (type === 'output') {
      this.outputFilesActive.set(false);
    }
    this.updateMultiFiles(listId as keyof MultiFiles, []);
  }

  private handleBaseFileChange(value: string): void {
    this.singleFiles.set({ ...this.singleFiles.get(), baseFile: value });
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, { baseFile: value });
  }

  private handleSessionTypeChange(value: string): void {
    const parsed = parseSessionType(value) ?? SESSION_TYPES.WORKFLOW;
    const prev = this.sessionType.get();
    if (parsed === prev) return;

    this.swapModeInstruction(prev, parsed);
    this.sessionType.set(parsed);
    // Auto-open the Files <wa-details> when the user enters workflow mode,
    // and auto-close when leaving. This is the one-shot behavior the bound
    // `?open` template expression used to encode — but tracking it here
    // means subsequent user collapses survive re-renders.
    this.fileSelectionOpen.set(parsed === SESSION_TYPES.WORKFLOW);
    this.refreshInstructionPlaceholder(false);
    if (parsed === SESSION_TYPES.TOOL_USE) {
      this.outputFilesActive.set(false);
      this.multiFilesVisible.set({
        ...this.multiFilesVisible.get(),
        outputFiles: false,
      });
      this.updateMultiFiles('outputFiles', []);
    }
    this.saveState();
  }

  private handleAgentChange(sessionType: SessionType, value: string): void {
    if (sessionType === SESSION_TYPES.WORKFLOW) {
      this.workflowAgent.set(value);
    } else {
      this.toolUseAgent.set(value);
    }
    this.swapModeInstruction(this.sessionType.get(), sessionType);
    this.sessionType.set(sessionType);
    this.refreshInstructionPlaceholder(false);
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
    if (value) {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES, {
        agent: value,
      });
    }
  }

  private handleModelChange(value: string): void {
    this.model.set(value);
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.MODEL_SELECTED, { model: value });
  }

  private handleShowApiKeyBanner(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER>,
  ): void {
    this.apiKeyBanner.set({
      visible: true,
      provider: message.provider ?? '',
      requiresKey: message.requiresKey ?? false,
    });
  }

  private handleShowAgentConfigBanner(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER
    >,
  ): void {
    this.agentConfigBanner.set({
      visible: true,
      agentName: message.agentName ?? '',
      customDirSet: message.customDirSet ?? false,
    });
  }

  private handleShowDependencyBanner(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER
    >,
  ): void {
    this.dependencyBanner.set({
      visible: true,
      missingTools: message.missingTools ?? [],
    });
  }

  private handleSetSelectedAgent(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT>,
  ): void {
    const sessionType = parseSessionType(message.sessionType ?? undefined);
    if (sessionType) {
      this.swapModeInstruction(this.sessionType.get(), sessionType);
      this.sessionType.set(sessionType);
    }
    if (message.agentId) {
      if (this.sessionType.get() === SESSION_TYPES.TOOL_USE) {
        this.toolUseAgent.set(message.agentId);
      } else {
        this.workflowAgent.set(message.agentId);
      }
    }
    this.refreshInstructionPlaceholder(false);
    this.saveState();
  }

  private handleComponentInstructionPaste(): void {
    this.saveState();
  }

  private scheduleInstructionSave(): void {
    if (this.instructionSaveTimer) {
      window.clearTimeout(this.instructionSaveTimer);
    }
    this.instructionSaveTimer = window.setTimeout(() => {
      this.saveState();
      this.instructionSaveTimer = null;
    }, 300);
  }

  private stopPlaceholderRotation(): void {
    if (this.placeholderTimer) {
      window.clearInterval(this.placeholderTimer);
      this.placeholderTimer = null;
    }
  }

  private isSelectedAgentOrchestrator(): boolean {
    if (this.sessionType.get() !== SESSION_TYPES.TOOL_USE) return false;
    const agentId = this.toolUseAgent.get();
    const opt = this.toolUseAgentOptions.get().find((o) => o.value === agentId);
    return opt?.isOrchestrator ?? false;
  }

  private getPlaceholderKey(): keyof typeof ONBOARDING_PLACEHOLDERS {
    return this.isSelectedAgentOrchestrator()
      ? 'orchestrator'
      : this.sessionType.get();
  }

  private refreshInstructionPlaceholder(advance: boolean): void {
    const placeholders = ONBOARDING_PLACEHOLDERS[this.getPlaceholderKey()];
    if (!placeholders.length) return;
    const current = this.instructionPlaceholder.get();
    const currentIndex = placeholders.indexOf(current);
    if (advance) {
      const nextIndex = (currentIndex + 1) % placeholders.length;
      this.instructionPlaceholder.set(placeholders[nextIndex]);
    } else if (!current || currentIndex === -1) {
      this.instructionPlaceholder.set(placeholders[0]);
    }
  }

  private executeAgent(): void {
    const {
      agent,
      isToolUseAgent,
      singleFileSelections,
      multipleFileSelections,
      checkboxValues,
    } = this.collectCurrentContext();
    postMessage(MAIN_VIEW_COMMANDS.EXECUTE, {
      agent,
      model: this.model.get(),
      instruction: this.instruction.get(),
      isToolUseAgent,
      ...singleFileSelections,
      ...multipleFileSelections,
      ...checkboxValues,
    });
  }

  private collectCurrentContext(): {
    agent: string;
    isToolUseAgent: boolean;
    singleFileSelections: Record<string, string>;
    multipleFileSelections: Record<string, string[] | boolean>;
    checkboxValues: Record<string, boolean>;
  } {
    const st = this.sessionType.get();
    const agent =
      st === SESSION_TYPES.TOOL_USE
        ? this.toolUseAgent.get()
        : this.workflowAgent.get();

    const sf = this.singleFiles.get();
    const singleFileSelections = {
      editedFile: sf.editedFile,
      baseFile: sf.baseFile,
    };

    const mf = this.multiFiles.get();
    const mv = this.multiFilesVisible.get();
    const multipleFileSelections: Record<string, string[] | boolean> = {};
    MULTIPLE_DOCUMENT_FILE_TYPES.forEach((type) => {
      const listId = `${type}Files` as keyof MultiFiles;
      const isActive = mv[listId];
      const files = isActive ? (mf[listId] ?? []) : [];
      multipleFileSelections[listId] = files;
      multipleFileSelections[`${listId}Active`] = isActive;
    });

    const checkboxValues = { ...this.checkboxValues.get() };

    return {
      agent,
      isToolUseAgent: st === SESSION_TYPES.TOOL_USE,
      singleFileSelections,
      multipleFileSelections,
      checkboxValues,
    };
  }

  private handlePolishInstruction(): void {
    const instructionText = this.instruction.get();
    if (!instructionText.trim()) return;

    const { agent, singleFileSelections, multipleFileSelections } =
      this.collectCurrentContext();
    this.isPolishing.set(true);
    postMessage(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT, {
      text: instructionText,
      agent,
      model: this.model.get(),
      ...singleFileSelections,
      ...multipleFileSelections,
    });
  }

  private handleMerge(): void {
    const sf = this.singleFiles.get();
    const primaryInput = this.multiFiles.get().inputFiles[0] ?? '';
    if (!primaryInput || !sf.editedFile) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select both input and edited files to merge',
      });
      return;
    }

    postMessage(MAIN_VIEW_COMMANDS.MERGE, {
      inputFile: primaryInput,
      editedFile: sf.editedFile,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Merging files: ${primaryInput} and ${sf.editedFile}`,
    });
  }

  private handlePackClean(action: 'pack' | 'clean'): void {
    const primaryInput = this.multiFiles.get().inputFiles[0] ?? '';
    if (!primaryInput || !this.model.get()) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select all required fields (input file, agent, and model)',
      });
      return;
    }

    const outputFiles = this.multiFiles.get().outputFiles ?? [];
    const useMultiple = this.outputFilesActive.get() && outputFiles.length > 0;
    const command = this.getPackCleanCommand(action, useMultiple);

    postMessage(command, {
      inputFile: primaryInput,
      agent:
        this.sessionType.get() === SESSION_TYPES.TOOL_USE
          ? this.toolUseAgent.get()
          : this.workflowAgent.get(),
      model: this.model.get(),
      outputFiles: useMultiple ? outputFiles : undefined,
    });

    const actionLabel = capitalize(action);
    const summary = useMultiple
      ? `${actionLabel}ing multiple files: ${[primaryInput, ...outputFiles].join(', ')}`
      : `${actionLabel}ing single file: ${primaryInput}`;
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, { text: summary });
  }

  private getPackCleanCommand(
    action: 'pack' | 'clean',
    useMultiple: boolean,
  ): string {
    if (action === 'pack') {
      return useMultiple
        ? MAIN_VIEW_COMMANDS.PACK_MULTIPLE
        : MAIN_VIEW_COMMANDS.PACK_SINGLE;
    }
    return useMultiple
      ? MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE
      : MAIN_VIEW_COMMANDS.CLEAN_SINGLE;
  }

  private handleLatexdiff(): void {
    const sf = this.singleFiles.get();
    const primaryInput = this.multiFiles.get().inputFiles[0] ?? '';
    postMessage(MAIN_VIEW_COMMANDS.LATEXDIFF, {
      inputFile: primaryInput,
      baseFile: sf.baseFile,
      editedFile: sf.editedFile,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Running LaTeX diff between ${sf.baseFile} and ${sf.editedFile}`,
    });
  }

  private handleLatexdiffVC(): void {
    const sf = this.singleFiles.get();
    const primaryInput = this.multiFiles.get().inputFiles[0] ?? '';
    const commitVal = this.commit.get();
    postMessage(MAIN_VIEW_COMMANDS.LATEXDIFFVC, {
      inputFile: primaryInput,
      baseFile: sf.baseFile,
      commitHash: commitVal,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Running LaTeX diff with version control: ${sf.baseFile} at commit ${commitVal}`,
    });
  }

  private handleLatexdiffVCPack(action: 'pack' | 'clean'): void {
    const sf = this.singleFiles.get();
    const primaryInput = this.multiFiles.get().inputFiles[0] ?? '';
    const commitVal = this.commit.get();
    postMessage(
      action === 'pack'
        ? MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC
        : MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC,
      {
        inputFile: primaryInput,
        baseFile: sf.baseFile,
        commitHash: commitVal,
        clean: action === 'clean',
      },
    );
    const actionLabel = action === 'pack' ? 'Pack' : 'Clean';
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `${actionLabel}ing LaTeX diff with version control: ${sf.baseFile} at commit ${commitVal}`,
    });
  }

  private handleCompare(command: string): void {
    const sf = this.singleFiles.get();
    if (!sf.baseFile || !sf.editedFile) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select both base and edited files to compare',
      });
      return;
    }

    postMessage(command, {
      baseFile: sf.baseFile,
      editedFile: sf.editedFile,
    });
  }

  private handleRecordingToggle(): void {
    if (this.isRecording.get()) {
      postMessage(MAIN_VIEW_COMMANDS.STOP_RECORDING);
    } else {
      postMessage(MAIN_VIEW_COMMANDS.START_RECORDING);
    }
  }

  private handleApiKeyBannerAction(action: 'set' | 'guide'): void {
    const { provider } = this.apiKeyBanner.get();
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

  private handleAgentConfigAction(action: 'edit' | 'dir' | 'docs'): void {
    switch (action) {
      case 'edit':
        postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS, {
          sessionType: this.sessionType.get(),
        });
        break;
      case 'dir':
        postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, {
          customDirSet: this.agentConfigBanner.get().customDirSet,
        });
        break;
      case 'docs':
        postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS);
        break;
    }
  }

  // =========================================================================
  // Component Event Handlers
  // These handlers receive custom events from child Lit components and
  // delegate to the existing handler methods.
  // =========================================================================

  private handleComponentGetCurrentFile(
    e: CustomEvent<FileActionDetail>,
  ): void {
    this.handleGetCurrentFile(e.detail.type);
  }

  private handleComponentEmptyFile(e: CustomEvent<FileActionDetail>): void {
    this.handleEmptyFile(e.detail.type);
  }

  private handleComponentToggleList(
    e: CustomEvent<MultipleFilesActionDetail>,
  ): void {
    this.toggleListVisibility(e.detail.listId as keyof MultiFiles);
  }

  private handleComponentAddOpenedFiles(
    e: CustomEvent<MultipleFilesTypeActionDetail>,
  ): void {
    if (e.detail.type !== 'output') {
      this.handleAddOpenedFiles(e.detail.type as DocumentFileType);
    }
  }

  private handleComponentEmptyFiles(
    e: CustomEvent<MultipleFilesTypeActionDetail>,
  ): void {
    this.handleEmptyFiles(e.detail.type as MultipleDocumentFileType);
  }

  private handleComponentSelectMultipleFiles(
    e: CustomEvent<MultipleFilesActionDetail>,
  ): void {
    this.handleSelectMultipleFiles(e.detail.listId);
  }

  private handleComponentRemoveFile(e: CustomEvent<RemoveFileDetail>): void {
    this.handleRemoveFile(e.detail.listId as keyof MultiFiles, e.detail.file);
  }

  private handleComponentFilesReordered(
    e: CustomEvent<ReorderFilesDetail>,
  ): void {
    this.updateMultiFiles(e.detail.listId as keyof MultiFiles, e.detail.files);
  }

  private handleComponentCheckboxChange(
    e: CustomEvent<CheckboxChangeDetail>,
  ): void {
    const { id, checked } = e.detail;
    const cv = this.checkboxValues.get();
    if (id in cv) {
      this.checkboxValues.set({
        ...cv,
        [id]: checked,
      });
      this.saveState();
    }
  }

  private handleComponentFocusInstruction(
    e: CustomEvent<FocusInstructionDetail>,
  ): void {
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
      key: e.detail.key,
      text: e.detail.text,
    });
  }

  private handleComponentApiKeyAction(
    e: CustomEvent<BannerActionDetail>,
  ): void {
    this.handleApiKeyBannerAction(e.detail.action as 'set' | 'guide');
  }

  private handleComponentAgentConfigAction(
    e: CustomEvent<BannerActionDetail>,
  ): void {
    this.handleAgentConfigAction(e.detail.action as 'edit' | 'dir' | 'docs');
  }

  private handleComponentDependencyDismiss(): void {
    this.handleDependencyDismiss();
  }

  private handleComponentRecheckDependencies(): void {
    postMessage(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES);
  }

  private handleComponentOpenInstallGuide(
    e: CustomEvent<InstallGuideDetail>,
  ): void {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE, { tool: e.detail.tool });
  }

  private handleComponentSignIn(): void {
    postMessage(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER);
  }

  private handleComponentDismissLogin(): void {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER);
    this.loginBannerVisible.set(false);
  }

  private handleComponentDismissGettingStarted(): void {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_GETTING_STARTED_BANNER);
    this.gettingStartedVisible.set(false);
  }

  private handleComponentDismissSessionHint(): void {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER);
    this.sessionHintDismissed.set(true);
  }

  private handleComponentLatexDiffsToggle(
    e: CustomEvent<LatexDiffsToggleDetail>,
  ): void {
    this.latexdiffsVisible.set(e.detail.visible);
    this.saveState();
  }

  private handleComponentLatexDiffsAction(
    e: CustomEvent<LatexDiffsActionDetail>,
  ): void {
    switch (e.detail.action) {
      case 'latexdiff':
        this.handleLatexdiff();
        break;
      case 'latexdiffvc':
        this.handleLatexdiffVC();
        break;
      case 'packLatexdiffvc':
        this.handleLatexdiffVCPack('pack');
        break;
      case 'cleanLatexdiffvc':
        this.handleLatexdiffVCPack('clean');
        break;
      case 'merge':
        this.handleMerge();
        break;
      case 'compare':
        this.handleCompare(MAIN_VIEW_COMMANDS.COMPARE);
        break;
      case 'accept':
        this.handleCompare(MAIN_VIEW_COMMANDS.ACCEPT_EDITED);
        break;
    }
  }

  private handleComponentBaseFileChange(
    e: CustomEvent<BaseFileChangeDetail>,
  ): void {
    this.handleBaseFileChange(e.detail.value);
  }

  private handleComponentEditedFileChange(
    e: CustomEvent<EditedFileChangeDetail>,
  ): void {
    this.singleFiles.set({
      ...this.singleFiles.get(),
      editedFile: e.detail.value,
    });
    this.saveState();
  }

  private handleComponentCommitChange(
    e: CustomEvent<CommitChangeDetail>,
  ): void {
    this.commit.set(e.detail.value);
    this.saveState();
  }

  private handleComponentRefreshEditedFiles(): void {
    this.handleRefreshEditedFiles();
  }

  private handleComponentRefreshCommits(): void {
    postMessage(MAIN_VIEW_COMMANDS.REFRESH_COMMITS);
  }

  // InstructionPanel component handlers
  private handleComponentSessionTypeChange(
    e: CustomEvent<SessionTypeChangeDetail>,
  ): void {
    this.handleSessionTypeChange(e.detail.value);
  }

  private handleComponentAgentChange(e: CustomEvent<AgentChangeDetail>): void {
    this.handleAgentChange(e.detail.sessionType, e.detail.value);
  }

  private handleComponentModelChange(e: CustomEvent<ModelChangeDetail>): void {
    this.handleModelChange(e.detail.value);
  }

  private shouldForceApiKeyBanner(): boolean {
    if (this.apiKeyBanner.get().requiresKey) {
      return true;
    }
    const option = this.modelOptions
      .get()
      .find((item) => item.value === this.model.get());
    return option?.requiresKey ?? false;
  }

  private handleComponentInstructionInput(
    e: CustomEvent<InstructionChangeDetail>,
  ): void {
    this.setInstruction(e.detail.value);
    this.scheduleInstructionSave();
  }

  private handleComponentPanelAction(e: CustomEvent<ActionDetail>): void {
    switch (e.detail.action) {
      case 'pack':
        this.handlePackClean('pack');
        break;
      case 'clean':
        this.handlePackClean('clean');
        break;
      case 'polish':
        this.handlePolishInstruction();
        break;
      case 'record':
        this.handleRecordingToggle();
        break;
      case 'erase':
        this.setInstruction('');
        this.saveState();
        break;
    }
  }

  private handleComponentExecute(): void {
    this.executeAgent();
  }

  private handleComponentAgentSettings(): void {
    this.handleAgentConfigAction('edit');
  }

  private handleComponentModelSettings(): void {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS);
  }

  private onViewTabShow = (event: WaTabShowEvent): void => {
    if (event.detail.name !== 'progress') return;
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'progress' });
    const tabs = event.currentTarget as MutableWaTabGroup;
    requestAnimationFrame(() => {
      tabs.active = 'launcher';
    });
  };

  private onOpenDashboard = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'dashboard' });
  };

  private onPopOutProgress = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, {
      view: 'progress',
      openInEditor: true,
    });
  };

  // =========================================================================
  // Existing Handler Methods
  // =========================================================================

  private handleDependencyDismiss(): void {
    this.dependencyBanner.set({ visible: false });
  }

  /** Check if a commit hash exists in the options array. */
  private hasCommitValue(value: string): boolean {
    if (!value) return false;
    const commits = this.fileOptions.get().commit ?? [];
    const entries = commits.some((commit) => commit.startsWith('HEAD'))
      ? commits
      : ['HEAD', ...commits];
    return entries.some((commit) => {
      const [hash] = commit.split(': ');
      return hash === value;
    });
  }

  /** Merge arrays, appending only items not already present */
  private mergeUnique(existing: string[], additions: string[]): string[] {
    const merged = [...existing];
    for (const item of additions) {
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
    return merged;
  }

  render(): TemplateResult {
    const isToolUse = this.sessionType.get() === SESSION_TYPES.TOOL_USE;
    const fileSelectionClasses = classMap({
      'file-selection-group': true,
      'file-selection-group--disabled': isToolUse,
    });

    const akb = this.apiKeyBanner.get();
    const acb = this.agentConfigBanner.get();
    const db = this.dependencyBanner.get();
    const sf = this.singleFiles.get();
    const fo = this.fileOptions.get();

    return html`
      <div class="content-wrapper">
        ${this.isDesktopHost
          ? nothing
          : html`
              <div class="view-header">
                <wa-tab-group
                  class="view-tabs"
                  active="launcher"
                  without-scroll-controls
                  @wa-tab-show=${this.onViewTabShow}
                >
                  <wa-tab panel="launcher">
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="pencil"
                      variant="solid"
                    ></wa-icon>
                    Launcher
                  </wa-tab>
                  <wa-tab panel="progress">
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="robot"
                      variant="solid"
                    ></wa-icon>
                    Progress
                  </wa-tab>
                  <wa-tab-panel name="launcher"></wa-tab-panel>
                  <wa-tab-panel name="progress"></wa-tab-panel>
                </wa-tab-group>
                <wa-button
                  class="header-action"
                  aria-label="Open dashboard"
                  appearance="plain"
                  size="small"
                  title="Open dashboard"
                  @click=${this.onOpenDashboard}
                >
                  <wa-icon
                    library=${TEXRA_ICON_LIBRARY}
                    name="gear"
                    variant="solid"
                  ></wa-icon>
                </wa-button>
                <wa-button
                  class="header-action"
                  aria-label="Open progress sessions in editor"
                  appearance="plain"
                  size="small"
                  title="Open progress sessions in editor"
                  @click=${this.onPopOutProgress}
                >
                  <wa-icon
                    library=${TEXRA_ICON_LIBRARY}
                    name="picture-in-picture"
                    variant="solid"
                  ></wa-icon>
                </wa-button>
              </div>
            `}

        <div class="main-content">
          <instruction-panel
            .showSessionHint=${!this.sessionHintDismissed.get()}
            @session-type-change=${this.handleComponentSessionTypeChange}
            @agent-change=${this.handleComponentAgentChange}
            @model-change=${this.handleComponentModelChange}
            @instruction-input=${this.handleComponentInstructionInput}
            @instruction-paste=${this.handleComponentInstructionPaste}
            @panel-action=${this.handleComponentPanelAction}
            @execute=${this.handleComponentExecute}
            @agent-settings=${this.handleComponentAgentSettings}
            @model-settings=${this.handleComponentModelSettings}
            @focus-instruction=${this.handleComponentFocusInstruction}
            @dismiss-session-hint=${this.handleComponentDismissSessionHint}
          ></instruction-panel>

          <banner-group
            .apiKeyBanner=${{
              visible: akb.visible,
              provider: akb.provider,
              requiresKey: akb.requiresKey,
            }}
            .agentConfigBanner=${{
              visible: acb.visible,
              agentName: acb.agentName,
              customDirSet: acb.customDirSet,
            }}
            .dependencyBanner=${{
              visible: db.visible,
              missingTools: db.missingTools,
            }}
            .gettingStartedVisible=${this.gettingStartedVisible.get()}
            .loginBannerVisible=${this.loginBannerVisible.get()}
            @api-key-action=${this.handleComponentApiKeyAction}
            @agent-config-action=${this.handleComponentAgentConfigAction}
            @dependency-dismiss=${this.handleComponentDependencyDismiss}
            @recheck-dependencies=${this.handleComponentRecheckDependencies}
            @open-install-guide=${this.handleComponentOpenInstallGuide}
            @sign-in=${this.handleComponentSignIn}
            @dismiss-login=${this.handleComponentDismissLogin}
            @dismiss-getting-started=${this
              .handleComponentDismissGettingStarted}
          ></banner-group>

          ${isToolUse
            ? nothing
            : html`
                <div class="section-separator" role="presentation"></div>
                <wa-details
                  class="file-selection-details"
                  ?open=${this.fileSelectionOpen.get()}
                  @wa-show=${(event: Event) => {
                    // Filter by event source: child wa-dropdown components
                    // inside the panel also emit wa-show/wa-hide which bubble
                    // up. Without this guard, opening any dropdown inside
                    // the Files panel re-flips fileSelectionOpen on the next
                    // dropdown close (see webawesome#1540).
                    if (event.target === event.currentTarget) {
                      this.fileSelectionOpen.set(true);
                    }
                  }}
                  @wa-hide=${(event: Event) => {
                    if (event.target === event.currentTarget) {
                      this.fileSelectionOpen.set(false);
                    }
                  }}
                >
                  <span slot="summary" class="file-selection-summary">
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="folder-tree"
                      variant="solid"
                    ></wa-icon>
                    Files
                  </span>
                  <div class=${fileSelectionClasses}>
                    ${repeat(
                      FILE_SELECT_CONFIGS,
                      (config) => config.type,
                      (config) => html`
                        <file-select-group
                          .config=${config}
                          @toggle-list=${this.handleComponentToggleList}
                          @add-opened-files=${this
                            .handleComponentAddOpenedFiles}
                          @empty-files=${this.handleComponentEmptyFiles}
                          @select-multiple-files=${this
                            .handleComponentSelectMultipleFiles}
                          @remove-file=${this.handleComponentRemoveFile}
                          @files-reordered=${this.handleComponentFilesReordered}
                          @checkbox-change=${this.handleComponentCheckboxChange}
                        ></file-select-group>
                      `,
                    )}
                    <output-files-section
                      @toggle-list=${this.handleComponentToggleList}
                      @empty-files=${this.handleComponentEmptyFiles}
                      @select-multiple-files=${this
                        .handleComponentSelectMultipleFiles}
                      @remove-file=${this.handleComponentRemoveFile}
                      @files-reordered=${this.handleComponentFilesReordered}
                    ></output-files-section>
                  </div>
                </wa-details>
              `}
        </div>

        ${this.isDesktopHost
          ? nothing
          : html`
              <latexdiffs-section
                .visible=${this.latexdiffsVisible.get()}
                .baseFile=${sf.baseFile}
                .baseFileOptions=${fo.baseFile ?? []}
                .editedFile=${sf.editedFile}
                .editedFileOptions=${fo.editedFile ?? []}
                .commit=${this.commit.get()}
                .commitOptions=${fo.commit ?? []}
                .isGitRepo=${this.isGitRepo.get()}
                @latexdiffs-toggle=${this.handleComponentLatexDiffsToggle}
                @latexdiffs-action=${this.handleComponentLatexDiffsAction}
                @base-file-change=${this.handleComponentBaseFileChange}
                @edited-file-change=${this.handleComponentEditedFileChange}
                @get-current-file=${this.handleComponentGetCurrentFile}
                @empty-file=${this.handleComponentEmptyFile}
                @refresh-edited-files=${this.handleComponentRefreshEditedFiles}
                @commit-change=${this.handleComponentCommitChange}
                @refresh-commits=${this.handleComponentRefreshCommits}
              ></latexdiffs-section>
            `}
      </div>
    `;
  }
}
