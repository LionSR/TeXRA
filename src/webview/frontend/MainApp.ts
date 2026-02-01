// Third-party imports
import { html, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage, vscode } from '@shared/vscode';
import { PersistedState, createWebviewStorage } from '@shared/state';

// Local imports - shared utilities
import { capitalize } from '@shared/utils/string';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - shared schemas (Zod-derived types)
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
} from '@shared/schemas';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - main view
import {
  ELEMENT_IDS,
  FILE_TYPES,
  MULTIPLE_FILE_TYPES,
  SESSION_TYPES,
  type FileType,
  type MultipleFileType,
  type SessionType,
  parseSessionType,
} from './constants';
import { SESSION_DEFAULTS } from './sessionDefaults';
import { mainViewStyles } from './styles';
import {
  dispatchMainViewMessage,
  type MainViewHandlerRegistry,
} from './mainViewDispatcher';

// Local imports - main view components (side-effect imports to register custom elements)
import './components/FileSelectGroup';
import './components/BannerGroup';
import './components/LatexDiffsSection';
import './components/InstructionPanel';
import './components/OutputFilesSection';

// Local imports - main view contexts
import {
  fileStateContext,
  sessionContext,
  type FileStateContextValue,
  type SessionContextValue,
} from './contexts/mainViewContexts';

// Local imports - main view store (typed defaults)
import {
  DEFAULT_STATE,
  DEFAULT_SINGLE_FILES,
  DEFAULT_FILE_OPTIONS,
  DEFAULT_MULTI_FILES,
  DEFAULT_MULTI_FILES_VISIBLE,
  DEFAULT_CHECKBOX_VALUES,
  FILE_UPDATE_COMMANDS,
  FILE_REFRESH_COMMANDS,
  FILE_SELECTED_COMMANDS,
  PLACEHOLDER_ROTATION_MS,
  ONBOARDING_PLACEHOLDERS,
  FILE_SELECT_CONFIGS,
} from './store';

// Type imports
import type {
  ActionDetail,
  AgentChangeDetail,
  BannerActionDetail,
  BaseFileChangeDetail,
  CheckboxChangeDetail,
  CommitChangeDetail,
  EditedFileChangeDetail,
  FileActionDetail,
  FileSelectChangeDetail,
  FocusInstructionDetail,
  InstallGuideDetail,
  InstructionChangeDetail,
  LatexDiffsActionDetail,
  LatexDiffsToggleDetail,
  ModelChangeDetail,
  MultipleFilesActionDetail,
  MultipleFilesTypeActionDetail,
  ReorderFilesDetail,
  RemoveFileDetail,
  SessionTypeChangeDetail,
} from '@shared/schemas';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';

// Helper type for extracting specific message type from union
type MainViewMessageFor<C extends MainViewMessage['command']> = Extract<
  MainViewMessage,
  { command: C }
>;

// Union types for handlers that process multiple similar commands
type SetSingleFileOptionsMessage =
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILE>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MEDIA_FILE>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_EDITED_FILE>;

type SingleFileSelectedMessage =
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED>;

type SetMultipleFilesMessage =
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MEDIA_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES>;

@customElement('main-app')
export class MainApp extends BaseWebviewApp {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @state() private sessionType: SessionType = DEFAULT_STATE.sessionType;
  @state() private workflowAgent = DEFAULT_STATE.workflowAgent;
  @state() private toolUseAgent = DEFAULT_STATE.toolUseAgent;
  @state() private model = DEFAULT_STATE.model;
  @state() private commit = DEFAULT_STATE.commit;
  @state() private instruction = DEFAULT_STATE.instruction;
  @state() private singleFiles: SingleFiles = { ...DEFAULT_SINGLE_FILES };
  @state() private fileOptions: FileOptions = { ...DEFAULT_FILE_OPTIONS };
  @state() private multiFiles: MultiFiles = { ...DEFAULT_MULTI_FILES };
  @state() private multiFilesVisible: MultiFilesVisible = {
    ...DEFAULT_MULTI_FILES_VISIBLE,
  };
  @state() private outputFilesActive = DEFAULT_STATE.outputFilesActive;
  @state() private latexdiffsVisible = DEFAULT_STATE.latexdiffsVisible;
  @state() private checkboxValues: CheckboxValues = {
    ...DEFAULT_CHECKBOX_VALUES,
  };
  @state() private isRecording = false;
  @state() private isPolishing = false;
  @state() private modelOptions: ModelOptionData[] = [];
  @state() private workflowAgentOptions: AgentOptionData[] = [];
  @state() private toolUseAgentOptions: AgentOptionData[] = [];
  @state() private apiKeyBanner: ApiKeyBannerState = { visible: false };
  @state() private agentConfigBanner: AgentConfigBannerState = {
    visible: false,
  };
  @state() private dependencyBanner: DependencyBannerState = {
    visible: false,
  };
  @state() private gettingStartedVisible = false;
  @state() private loginBannerVisible = false;
  @state() private instructionPlaceholder =
    ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0];
  @state() protected override debugMode = false;
  @state() private isGitRepo = true;
  private defaultOutputFiles: string[] = [];
  private instructionSaveTimer: number | null = null;

  @provide({ context: fileStateContext })
  @state()
  private fileStateContextValue: FileStateContextValue =
    this.buildFileStateContext();

  @provide({ context: sessionContext })
  @state()
  private sessionContextValue: SessionContextValue = this.buildSessionContext();

  // Note: model/agent selects are inside InstructionPanel's shadow DOM.
  // Decoration is now handled declaratively in selectTemplates.ts via Lit templates.

  private readonly stateManager = new PersistedState(
    createWebviewStorage(vscode),
    'mainViewState',
    MainViewPersistedStateSchema,
  );
  private saveBlockCount = 0;
  private placeholderTimer: number | null = null;

  /**
   * Type-safe message handler registry.
   * Handlers receive typed data - no casts needed.
   */
  private readonly messageHandlers: MainViewHandlerRegistry = {
    // Model and agent options
    [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (data) =>
      this.handleSetModelOptions(data),
    [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (data) =>
      this.handleSetAgentOptions(data),

    // Single file operations
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: (data) =>
      this.handleSetSingleFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: (data) =>
      this.handleSetSingleFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: (data) =>
      this.handleSetSingleFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: (data) =>
      this.handleSetSingleFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (data) =>
      this.handleSetSingleFileOptions(data),
    [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: (data) => this.handleSetBaseFile(data),

    // Single file selected
    [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: (data) =>
      this.handleSingleFileSelected(data),
    [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: (data) =>
      this.handleSingleFileSelected(data),
    [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: (data) =>
      this.handleSingleFileSelected(data),
    [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: (data) =>
      this.handleSingleFileSelected(data),
    [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (data) =>
      this.handleSingleFileSelected(data),

    // Multiple file operations
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: (data) =>
      this.handleSetMultipleFiles(data),
    [MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES]: (data) =>
      this.handleSetDefaultOutputFiles(data),
    [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: (data) =>
      this.handleAddMediaFile(data),

    // Commit operations
    [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (data) =>
      this.handleSetRecentCommits(data),
    [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (data) =>
      this.handleSetCurrentFile(data),
    [MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT]: (data) =>
      this.handleSetSelectedCommit(data),
    [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (data) =>
      this.handleSetOpenedFiles(data),
    [MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES]: (data) =>
      this.handleSetAllSingleFiles(data),

    // Instruction operations
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (data) =>
      this.handleInstructionTextPolished(data),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]: (data) =>
      this.handleInstructionTextPolishError(data),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (data) =>
      this.handleInstructionTextTranscribed(data),

    // Recording state
    [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: () => {
      this.isRecording = true;
    },
    [MAIN_VIEW_COMMANDS.RECORDING_STOPPED]: () => {
      this.isRecording = false;
    },
    [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: () => {
      this.isRecording = false;
    },

    // Banner operations
    [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (data) =>
      this.handleShowApiKeyBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () => {
      if (this.shouldForceApiKeyBanner()) {
        return;
      }
      this.apiKeyBanner = { visible: false };
    },
    [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (data) =>
      this.handleShowAgentConfigBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: () => {
      this.agentConfigBanner = { visible: false };
    },
    [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (data) =>
      this.handleShowDependencyBanner(data),
    [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: () => {
      this.dependencyBanner = { visible: false };
    },
    [MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER]: () => {
      this.gettingStartedVisible = true;
    },
    [MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER]: () => {
      this.gettingStartedVisible = false;
    },
    [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: () => {
      this.loginBannerVisible = true;
    },
    [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () => {
      this.loginBannerVisible = false;
    },

    // Agent selection
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
    // Schema-driven dispatch - parses once with discriminated union,
    // then routes to typed handler
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

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (
      changed.has('sessionType') ||
      changed.has('singleFiles') ||
      changed.has('fileOptions') ||
      changed.has('multiFiles') ||
      changed.has('multiFilesVisible') ||
      changed.has('checkboxValues') ||
      changed.has('outputFilesActive')
    ) {
      const nextValue = this.buildFileStateContext();
      if (
        !this.isFileStateContextEqual(this.fileStateContextValue, nextValue)
      ) {
        this.fileStateContextValue = nextValue;
      }
    }

    if (
      changed.has('sessionType') ||
      changed.has('instruction') ||
      changed.has('instructionPlaceholder') ||
      changed.has('workflowAgent') ||
      changed.has('toolUseAgent') ||
      changed.has('model') ||
      changed.has('workflowAgentOptions') ||
      changed.has('toolUseAgentOptions') ||
      changed.has('modelOptions') ||
      changed.has('isRecording') ||
      changed.has('isPolishing') ||
      changed.has('debugMode')
    ) {
      const nextValue = this.buildSessionContext();
      if (!this.isSessionContextEqual(this.sessionContextValue, nextValue)) {
        this.sessionContextValue = nextValue;
      }
    }
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has('sessionType')) {
      this.refreshInstructionPlaceholder(false);
    }
    // Note: Option decoration is handled declaratively in selectTemplates.ts
    // via renderAgentOptions/renderModelOptions.
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

    const persisted: MainViewPersistedState = {
      sessionType: this.sessionType,
      workflowAgent: this.workflowAgent,
      toolUseAgent: this.toolUseAgent,
      model: this.model,
      commit: this.commit,
      instruction: this.instruction,
      inputFile: this.singleFiles.inputFile,
      referenceFile: this.singleFiles.referenceFile,
      auxiliaryFile: this.singleFiles.auxiliaryFile,
      mediaFile: this.singleFiles.mediaFile,
      editedFile: this.singleFiles.editedFile,
      baseFile: this.singleFiles.baseFile,
      inputFiles: this.multiFiles.inputFiles,
      referenceFiles: this.multiFiles.referenceFiles,
      auxiliaryFiles: this.multiFiles.auxiliaryFiles,
      mediaFiles: this.multiFiles.mediaFiles,
      outputFiles: this.multiFiles.outputFiles,
      inputFilesVisible: this.multiFilesVisible.inputFiles,
      referenceFilesVisible: this.multiFilesVisible.referenceFiles,
      auxiliaryFilesVisible: this.multiFilesVisible.auxiliaryFiles,
      mediaFilesVisible: this.multiFilesVisible.mediaFiles,
      outputFilesVisible: this.multiFilesVisible.outputFiles,
      outputFilesActive: this.outputFilesActive,
      latexdiffsVisible: this.latexdiffsVisible,
      autoExtractFigure: this.checkboxValues.autoExtractFigure,
      autoExtractTikzFigure: this.checkboxValues.autoExtractTikzFigure,
      autoCompileInputPdf: this.checkboxValues.autoCompileInputPdf,
      attachTeXCount: this.checkboxValues.attachTeXCount,
      attachDiagnostics: this.checkboxValues.attachDiagnostics,
      agent:
        this.sessionType === SESSION_TYPES.TOOL_USE
          ? this.toolUseAgent
          : this.workflowAgent,
      isToolUseAgent: this.sessionType === SESSION_TYPES.TOOL_USE,
    };

    this.stateManager.setState(persisted);
  }

  private restorePersistedState(): void {
    const state = this.stateManager.getState();

    this.sessionType = state.sessionType;
    this.workflowAgent = state.workflowAgent || this.workflowAgent;
    this.toolUseAgent = state.toolUseAgent || this.toolUseAgent;
    this.model = state.model || this.model;
    this.commit = state.commit || this.commit;
    this.instruction = state.instruction || '';
    this.singleFiles = {
      inputFile: state.inputFile || '',
      referenceFile: state.referenceFile || '',
      auxiliaryFile: state.auxiliaryFile || '',
      mediaFile: state.mediaFile || '',
      editedFile: state.editedFile || '',
      baseFile: state.baseFile || '',
    };
    this.multiFiles = {
      inputFiles: state.inputFiles ?? [],
      referenceFiles: state.referenceFiles ?? [],
      auxiliaryFiles: state.auxiliaryFiles ?? [],
      mediaFiles: state.mediaFiles ?? [],
      outputFiles: state.outputFiles ?? [],
    };
    this.multiFilesVisible = {
      inputFiles: state.inputFilesVisible ?? false,
      referenceFiles: state.referenceFilesVisible ?? false,
      auxiliaryFiles: state.auxiliaryFilesVisible ?? false,
      mediaFiles: state.mediaFilesVisible ?? false,
      outputFiles: state.outputFilesVisible ?? false,
    };
    this.outputFilesActive = state.outputFilesActive ?? false;
    this.latexdiffsVisible = state.latexdiffsVisible ?? false;
    this.checkboxValues = {
      autoExtractFigure: state.autoExtractFigure ?? false,
      autoExtractTikzFigure: state.autoExtractTikzFigure ?? false,
      autoCompileInputPdf: state.autoCompileInputPdf ?? false,
      attachTeXCount: state.attachTeXCount ?? false,
      attachDiagnostics: state.attachDiagnostics ?? false,
    };
  }

  private requestInitialData(): void {
    const commands = [
      MAIN_VIEW_COMMANDS.GET_THEME,
      MAIN_VIEW_COMMANDS.GET_DEBUG_MODE,
      MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    ];
    commands.forEach((command) => postMessage(command));

    const agent =
      this.sessionType === SESSION_TYPES.TOOL_USE
        ? this.toolUseAgent
        : this.workflowAgent;
    if (agent) {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES, { agent });
    }
  }

  private updateMultiFiles(listId: keyof MultiFiles, files: string[]): void {
    this.multiFiles = { ...this.multiFiles, [listId]: files };
    this.saveState();

    const fileType = listId.replace('Files', '') as MultipleFileType;
    const command = FILE_UPDATE_COMMANDS[fileType];
    if (command) {
      postMessage(command, { fileType, files });
    }
  }

  /**
   * Validates that the current selection exists in the new options.
   * Returns the current value if valid, otherwise returns a fallback.
   */
  private validateOptionSelection<
    T extends { value: string; disabled?: boolean },
  >(options: T[], currentValue: string, preferEnabled = false): string {
    const hasValue = options.some((opt) => opt.value === currentValue);
    if (hasValue) return currentValue;

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

    this.modelOptions = message.optionsData;
    this.model = this.validateOptionSelection(
      message.optionsData,
      this.model,
      true,
    );
  }

  private handleSetAgentOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS>,
  ): void {
    const optionsData = message.optionsData ?? {};

    if (optionsData.workflow) {
      this.workflowAgentOptions = optionsData.workflow;
      this.workflowAgent = this.validateOptionSelection(
        optionsData.workflow,
        this.workflowAgent,
      );
    }

    if (optionsData.toolUse) {
      this.toolUseAgentOptions = optionsData.toolUse;
      this.toolUseAgent = this.validateOptionSelection(
        optionsData.toolUse,
        this.toolUseAgent,
      );
    }
  }

  private handleSetSingleFileOptions(
    message: SetSingleFileOptionsMessage,
  ): void {
    const files = message.files ?? [];
    const targetId = this.extractFileKeyFromCommand(message.command);
    if (!targetId) return;

    this.fileOptions = { ...this.fileOptions, [targetId]: files };
    const currentValue =
      this.singleFiles[targetId as keyof typeof this.singleFiles];
    if (currentValue && !files.includes(currentValue)) {
      this.singleFiles = { ...this.singleFiles, [targetId]: '' };
    }
    this.saveState();
  }

  private handleSetBaseFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_BASE_FILE>,
  ): void {
    const files = message.files ?? [];
    this.fileOptions = { ...this.fileOptions, baseFile: files };

    if (
      !message.preserveBaseFile &&
      !files.includes(this.singleFiles.baseFile)
    ) {
      this.singleFiles = { ...this.singleFiles, baseFile: '' };
    }

    this.saveState();
  }

  private handleSingleFileSelected(message: SingleFileSelectedMessage): void {
    const value = message.filePath;
    const key = this.extractFileKeyFromCommand(message.command);
    if (!key) return;
    this.singleFiles = { ...this.singleFiles, [key]: value };
    this.saveState();
  }

  private handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    const files = message.files ?? [];
    const listId = this.extractFileKeyFromCommand(
      message.command,
    ) as keyof MultiFiles;
    if (!listId) return;

    this.multiFiles = { ...this.multiFiles, [listId]: files };
    this.multiFilesVisible = {
      ...this.multiFilesVisible,
      [listId]: files.length > 0,
    };
    if (listId === ELEMENT_IDS.OUTPUT_FILES) {
      this.outputFilesActive = files.length > 0;
    }
    this.saveState();
  }

  private handleSetDefaultOutputFiles(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES
    >,
  ): void {
    this.defaultOutputFiles = [...message.files];
    if (this.outputFilesActive && this.multiFiles.outputFiles.length === 0) {
      this.initializeOutputFiles();
    }
  }

  private handleAddMediaFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE>,
  ): void {
    const file = message.file;
    const existing = this.multiFiles.mediaFiles;
    if (existing.includes(file)) return;
    this.multiFiles = {
      ...this.multiFiles,
      mediaFiles: [...existing, file],
    };
    this.multiFilesVisible = { ...this.multiFilesVisible, mediaFiles: true };
    this.saveState();
  }

  private handleSetRecentCommits(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS>,
  ): void {
    const commits = message.commits;
    this.isGitRepo = message.isGitRepo ?? true;

    this.fileOptions = {
      ...this.fileOptions,
      commit: this.isGitRepo ? commits : [],
    };

    if (!this.isGitRepo) {
      this.commit = '';
    } else if (!this.commit || !this.hasCommitValue(this.commit)) {
      this.commit = 'HEAD';
    }
    this.saveState();
  }

  private handleSetCurrentFile(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_CURRENT_FILE>,
  ): void {
    const { fileType, filePath } = message;
    const key = `${fileType}File` as keyof FileOptions;
    if (!filePath || !(key in this.singleFiles)) return;

    const options = this.fileOptions[key] ?? [];
    if (!options.includes(filePath)) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: `The current file is not in the ${fileType} file list: ${filePath}`,
      });
      return;
    }
    if (FILE_TYPES.includes(fileType as FileType)) {
      this.handleSingleFileChange(fileType as FileType, filePath);
      return;
    }

    this.singleFiles = { ...this.singleFiles, [key]: filePath };
    this.saveState();
  }

  private handleSetSelectedCommit(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT>,
  ): void {
    const commitHash = message.commitHash;
    const commitLabel = message.commitLabel ?? '';

    if (!commitHash) return;
    const options = this.fileOptions.commit ?? [];
    if (!options.some((option) => option.startsWith(commitHash))) {
      this.fileOptions = {
        ...this.fileOptions,
        commit: [...options, commitLabel || commitHash],
      };
    }
    this.commit = commitHash;
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
    if (!(listId in this.multiFiles)) return;

    let filesToAdd = message.files ?? [];

    if (message.shouldFilter) {
      const singleFileKey = `${normalizedType.replace('Files', '')}File`;
      const selected =
        this.singleFiles[singleFileKey as keyof typeof this.singleFiles];
      if (selected) {
        filesToAdd = filesToAdd.filter((file) => file !== selected);
      }
    }

    const existing = this.multiFiles[listId] ?? [];
    const merged = this.mergeUnique(existing, filesToAdd);
    this.multiFiles = { ...this.multiFiles, [listId]: merged };
    this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: true };
    this.saveState();
  }

  private handleSetAllSingleFiles(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES>,
  ): void {
    this.blockSave();
    try {
      const updates: Record<string, string[]> = {};
      const fileGroups = [
        { files: message.inputFiles, target: 'inputFile' },
        { files: message.referenceFiles, target: 'referenceFile' },
        { files: message.auxiliaryFiles, target: 'auxiliaryFile' },
        { files: message.mediaFiles, target: 'mediaFile' },
      ];

      fileGroups.forEach(({ files, target }) => {
        if (!files || !Array.isArray(files)) {
          return;
        }
        updates[target] = files;
        const currentValue =
          this.singleFiles[target as keyof typeof this.singleFiles];
        if (currentValue && !files.includes(currentValue)) {
          this.singleFiles = {
            ...this.singleFiles,
            [target]: '',
          };
        }
      });
      this.fileOptions = { ...this.fileOptions, ...updates };
    } finally {
      this.unblockSave();
    }
  }

  private handleInstructionTextPolished(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED
    >,
  ): void {
    this.isPolishing = false;
    if (message.text.trim()) {
      this.instruction = message.text;
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
    this.isPolishing = false;
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
      this.isRecording = false;
      return;
    }

    // Append transcribed text to instruction (Lit-native: update state, not DOM)
    // Note: Cursor position insertion is not supported with shadow DOM isolation.
    // The InstructionPanel receives the updated instruction via property binding.
    const updated = this.instruction
      ? `${this.instruction} ${message.text}`
      : message.text;
    this.instruction = updated;
    this.isRecording = false;
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
      this.sessionType = state.sessionType;
      this.workflowAgent = state.workflowAgent;
      this.toolUseAgent = state.toolUseAgent;
      this.model = state.model;
      this.commit = state.commit;
      this.instruction = state.instruction;
      this.singleFiles = {
        inputFile: state.inputFile,
        referenceFile: state.referenceFile,
        auxiliaryFile: state.auxiliaryFile,
        mediaFile: state.mediaFile,
        editedFile: state.editedFile,
        baseFile: state.baseFile,
      };

      this.checkboxValues = {
        autoExtractFigure: state.autoExtractFigure,
        autoExtractTikzFigure: state.autoExtractTikzFigure,
        autoCompileInputPdf: state.autoCompileInputPdf,
        attachTeXCount: state.attachTeXCount,
        attachDiagnostics: state.attachDiagnostics,
      };
      this.outputFilesActive = state.outputFilesActive;
      this.latexdiffsVisible = state.latexdiffsVisible;

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
    this.multiFiles = Object.fromEntries(
      MULTIPLE_FILE_TYPES.map((type) => {
        const key = `${type}Files` as keyof MultiFiles;
        const files = state[key as keyof MainViewPersistedState];
        return [key, Array.isArray(files) ? files : []];
      }),
    ) as MultiFiles;

    this.multiFilesVisible = Object.fromEntries(
      MULTIPLE_FILE_TYPES.map((type) => {
        const key = `${type}Files` as keyof MultiFilesVisible;
        const visible = state[`${key}Visible` as keyof MainViewPersistedState];
        return [key, Boolean(visible)];
      }),
    ) as MultiFilesVisible;
  }

  private clearForNewSession(): void {
    this.instruction = '';
    const defaults = SESSION_DEFAULTS[this.sessionType];
    if (defaults.resetFiles) {
      this.singleFiles = {
        inputFile: '',
        referenceFile: '',
        auxiliaryFile: '',
        mediaFile: '',
        editedFile: '',
        baseFile: '',
      };
      this.multiFiles = {
        inputFiles: [],
        referenceFiles: [],
        auxiliaryFiles: [],
        mediaFiles: [],
        outputFiles: [],
      };
      this.multiFilesVisible = {
        inputFiles: false,
        referenceFiles: false,
        auxiliaryFiles: false,
        mediaFiles: false,
        outputFiles: false,
      };
      if (defaults.checkboxOverrides) {
        this.checkboxValues = {
          ...this.checkboxValues,
          ...defaults.checkboxOverrides,
        };
      }
      if (defaults.outputFilesActive !== undefined) {
        this.outputFilesActive = defaults.outputFilesActive;
      }
    }
    this.saveState();
  }

  /**
   * Extracts the file key from a command name.
   * Patterns:
   *   'setInputFile' -> 'inputFile'
   *   'inputFileSelected' -> 'inputFile'
   *   'setInputFiles' -> 'inputFiles'
   */
  private extractFileKeyFromCommand(command: string): string | undefined {
    // Handle 'set*File' or 'set*Files' pattern
    const setMatch = command.match(/^set(\w+)(Files?)$/);
    if (setMatch) {
      const [, name, suffix] = setMatch;
      return name.charAt(0).toLowerCase() + name.slice(1) + suffix;
    }

    // Handle '*FileSelected' pattern
    const selectedMatch = command.match(/^(\w+File)Selected$/);
    if (selectedMatch) {
      return selectedMatch[1];
    }

    return undefined;
  }

  private toggleListVisibility(listId: keyof MultiFiles): void {
    const visible = !this.multiFilesVisible[listId];
    this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: visible };
    if (listId === ELEMENT_IDS.OUTPUT_FILES) {
      this.outputFilesActive = visible;
      if (visible && this.multiFiles.outputFiles.length === 0) {
        this.initializeOutputFiles();
      }
    }
    this.saveState();
  }

  private initializeOutputFiles(): void {
    const inputFile = this.singleFiles.inputFile;
    if (!inputFile) return;

    const initialFiles = this.getInitialOutputFiles(inputFile);
    this.multiFiles = { ...this.multiFiles, outputFiles: initialFiles };
  }

  private getInitialOutputFiles(inputFile: string): string[] {
    if (this.multiFiles.outputFiles.length > 0) {
      return this.multiFiles.outputFiles;
    }
    if (this.defaultOutputFiles.length > 0) {
      return this.defaultOutputFiles;
    }
    // Include both the single input file and multiple input files
    const files = [inputFile];
    for (const file of this.multiFiles.inputFiles) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
    return files;
  }

  private handleRemoveFile(listId: keyof MultiFiles, file: string): void {
    const files = (this.multiFiles[listId] ?? []).filter(
      (f: string) => f !== file,
    );
    if (files.length === 0) {
      this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: false };
      if (listId === ELEMENT_IDS.OUTPUT_FILES) {
        this.outputFilesActive = false;
      }
    }
    this.updateMultiFiles(listId, files);
  }

  private handleSelectMultipleFiles(listId: string): void {
    const currentFileKey = listId.replace('Files', 'File');
    const currentFile =
      this.singleFiles[currentFileKey as keyof typeof this.singleFiles];
    // Convert listId (e.g., 'inputFiles') to fileType (e.g., 'input')
    const fileType = listId.replace('Files', '');
    postMessage(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES, {
      fileType,
      currentFile,
    });
  }

  private handleAddOpenedFiles(type: FileType): void {
    postMessage(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES, { fileType: type });
  }

  private handleGetCurrentFile(type: FileType | 'base' | 'edited'): void {
    const payload: Record<string, unknown> = { fileType: type };
    if ((type === 'base' || type === 'edited') && this.singleFiles.baseFile) {
      payload.baseFile = this.singleFiles.baseFile;
    }
    postMessage(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE, payload);
  }

  private handleEmptyFile(type: FileType | 'base' | 'edited'): void {
    const key = `${type}File` as keyof typeof this.singleFiles;
    if (key in this.singleFiles) {
      this.singleFiles = { ...this.singleFiles, [key]: '' };
      this.saveState();
    }

    const command = FILE_SELECTED_COMMANDS[type];
    if (command) {
      postMessage(command, { filePath: '' });
    }
  }

  private handleRefreshEditedFiles(): void {
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
      baseFile: this.singleFiles.baseFile,
      notifyWhenEmpty: true,
    });
  }

  private handleEmptyFiles(type: MultipleFileType): void {
    const listId = `${type}Files`;
    this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: false };
    if (type === 'output') {
      this.outputFilesActive = false;
    }
    this.updateMultiFiles(listId as keyof MultiFiles, []);
  }

  private handleRefreshFiles(type: FileType): void {
    const command = FILE_REFRESH_COMMANDS[type];
    if (command) postMessage(command);
  }

  private handleSingleFileChange(type: FileType, value: string): void {
    const key = `${type}File` as keyof typeof this.singleFiles;
    this.singleFiles = { ...this.singleFiles, [key]: value };
    this.saveState();

    const command = FILE_SELECTED_COMMANDS[type];
    if (command) postMessage(command, { filePath: value });

    if (type === 'input') {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, { baseFile: value });
    }
  }

  private handleBaseFileChange(value: string): void {
    this.singleFiles = { ...this.singleFiles, baseFile: value };
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, { baseFile: value });
  }

  private handleSessionTypeChange(value: string): void {
    const parsed = parseSessionType(value) ?? SESSION_TYPES.WORKFLOW;
    if (parsed === this.sessionType) return;
    this.sessionType = parsed;
    if (parsed === SESSION_TYPES.TOOL_USE) {
      this.outputFilesActive = false;
      this.multiFilesVisible = {
        ...this.multiFilesVisible,
        outputFiles: false,
      };
      this.updateMultiFiles('outputFiles', []);
    }
    this.saveState();
  }

  private handleAgentChange(sessionType: SessionType, value: string): void {
    if (sessionType === SESSION_TYPES.WORKFLOW) {
      this.workflowAgent = value;
    } else {
      this.toolUseAgent = value;
    }
    this.sessionType = sessionType;
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE);
    if (value) {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES, {
        agent: value,
      });
    }
  }

  private handleModelChange(value: string): void {
    this.model = value;
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.MODEL_SELECTED, { model: value });
    // Note: API key banner updates are handled by backend messages
    // (SHOW_API_KEY_BANNER, HIDE_API_KEY_BANNER) since the model select
    // is inside InstructionPanel's shadow DOM and data attributes
    // can't be read from here.
  }

  private handleShowApiKeyBanner(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER>,
  ): void {
    this.apiKeyBanner = {
      visible: true,
      provider: message.provider ?? '',
      requiresKey: message.requiresKey ?? false,
    };
  }

  private handleShowAgentConfigBanner(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER
    >,
  ): void {
    this.agentConfigBanner = {
      visible: true,
      agentName: message.agentName ?? '',
      customDirSet: message.customDirSet ?? false,
    };
  }

  private handleShowDependencyBanner(
    message: MainViewMessageFor<
      typeof MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER
    >,
  ): void {
    this.dependencyBanner = {
      visible: true,
      missingTools: message.missingTools ?? [],
    };
  }

  private handleSetSelectedAgent(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT>,
  ): void {
    const sessionType = parseSessionType(message.sessionType ?? undefined);
    if (sessionType) {
      this.sessionType = sessionType;
    }
    if (message.agentId) {
      if (this.sessionType === SESSION_TYPES.TOOL_USE) {
        this.toolUseAgent = message.agentId;
      } else {
        this.workflowAgent = message.agentId;
      }
    }
    this.saveState();
  }

  // Note: Instruction input events are handled via @instruction-input from InstructionPanel.
  // Image paste is handled by @instruction-paste from InstructionPanel (Lit-native pattern).

  /** Handle image paste in instruction - save state after paste completes */
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

  private startPlaceholderRotation(): void {
    if (this.placeholderTimer) return;
    this.placeholderTimer = window.setInterval(() => {
      if (this.instruction.trim()) {
        this.stopPlaceholderRotation();
        return;
      }
      this.refreshInstructionPlaceholder(true);
    }, PLACEHOLDER_ROTATION_MS);
  }

  private stopPlaceholderRotation(): void {
    if (this.placeholderTimer) {
      window.clearInterval(this.placeholderTimer);
      this.placeholderTimer = null;
    }
  }

  private refreshInstructionPlaceholder(advance: boolean): void {
    const placeholders = ONBOARDING_PLACEHOLDERS[this.sessionType];
    if (!placeholders.length) return;
    const currentIndex = placeholders.indexOf(this.instructionPlaceholder);
    if (advance) {
      const nextIndex = (currentIndex + 1) % placeholders.length;
      this.instructionPlaceholder = placeholders[nextIndex];
    } else if (!this.instructionPlaceholder) {
      this.instructionPlaceholder = placeholders[0];
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
      model: this.model,
      instruction: this.instruction,
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
    const agent =
      this.sessionType === SESSION_TYPES.TOOL_USE
        ? this.toolUseAgent
        : this.workflowAgent;

    const singleFileSelections = {
      inputFile: this.singleFiles.inputFile,
      referenceFile: this.singleFiles.referenceFile,
      auxiliaryFile: this.singleFiles.auxiliaryFile,
      mediaFile: this.singleFiles.mediaFile,
      editedFile: this.singleFiles.editedFile,
      baseFile: this.singleFiles.baseFile,
    };

    const multipleFileSelections: Record<string, string[] | boolean> = {};
    MULTIPLE_FILE_TYPES.forEach((type) => {
      const listId = `${type}Files` as keyof MultiFiles;
      const isActive = this.multiFilesVisible[listId];
      const files = isActive ? (this.multiFiles[listId] ?? []) : [];
      multipleFileSelections[listId] = files;
      multipleFileSelections[`${listId}Active`] = isActive;
    });

    const checkboxValues = { ...this.checkboxValues };

    return {
      agent,
      isToolUseAgent: this.sessionType === SESSION_TYPES.TOOL_USE,
      singleFileSelections,
      multipleFileSelections,
      checkboxValues,
    };
  }

  private handlePolishInstruction(): void {
    if (!this.instruction.trim()) return;

    const { agent, singleFileSelections, multipleFileSelections } =
      this.collectCurrentContext();
    this.isPolishing = true;
    postMessage(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT, {
      text: this.instruction,
      agent,
      model: this.model,
      ...singleFileSelections,
      ...multipleFileSelections,
    });
  }

  private handleMerge(): void {
    if (!this.singleFiles.inputFile || !this.singleFiles.editedFile) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select both input and edited files to merge',
      });
      return;
    }

    postMessage(MAIN_VIEW_COMMANDS.MERGE, {
      inputFile: this.singleFiles.inputFile,
      editedFile: this.singleFiles.editedFile,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Merging files: ${this.singleFiles.inputFile} and ${this.singleFiles.editedFile}`,
    });
  }

  private handlePackClean(action: 'pack' | 'clean'): void {
    if (!this.singleFiles.inputFile || !this.model) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select all required fields (input file, agent, and model)',
      });
      return;
    }

    const outputFiles = this.multiFiles.outputFiles ?? [];
    const useMultiple = this.outputFilesActive && outputFiles.length > 0;
    const command = this.getPackCleanCommand(action, useMultiple);

    postMessage(command, {
      inputFile: this.singleFiles.inputFile,
      agent:
        this.sessionType === SESSION_TYPES.TOOL_USE
          ? this.toolUseAgent
          : this.workflowAgent,
      model: this.model,
      outputFiles: useMultiple ? outputFiles : undefined,
    });

    const actionLabel = capitalize(action);
    const summary = useMultiple
      ? `${actionLabel}ing multiple files: ${[this.singleFiles.inputFile, ...outputFiles].join(', ')}`
      : `${actionLabel}ing single file: ${this.singleFiles.inputFile}`;
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
    postMessage(MAIN_VIEW_COMMANDS.LATEXDIFF, {
      inputFile: this.singleFiles.inputFile,
      baseFile: this.singleFiles.baseFile,
      editedFile: this.singleFiles.editedFile,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Running LaTeX diff between ${this.singleFiles.baseFile} and ${this.singleFiles.editedFile}`,
    });
  }

  private handleLatexdiffVC(): void {
    postMessage(MAIN_VIEW_COMMANDS.LATEXDIFFVC, {
      inputFile: this.singleFiles.inputFile,
      baseFile: this.singleFiles.baseFile,
      commitHash: this.commit,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Running LaTeX diff with version control: ${this.singleFiles.baseFile} at commit ${this.commit}`,
    });
  }

  private handleLatexdiffVCPack(action: 'pack' | 'clean'): void {
    postMessage(
      action === 'pack'
        ? MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC
        : MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC,
      {
        inputFile: this.singleFiles.inputFile,
        baseFile: this.singleFiles.baseFile,
        commitHash: this.commit,
        clean: action === 'clean',
      },
    );
    const actionLabel = action === 'pack' ? 'Pack' : 'Clean';
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `${actionLabel}ing LaTeX diff with version control: ${this.singleFiles.baseFile} at commit ${this.commit}`,
    });
  }

  private handleCompare(command: string): void {
    if (!this.singleFiles.baseFile || !this.singleFiles.editedFile) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select both base and edited files to compare',
      });
      return;
    }

    postMessage(command, {
      baseFile: this.singleFiles.baseFile,
      editedFile: this.singleFiles.editedFile,
    });
  }

  private handleRecordingToggle(): void {
    if (this.isRecording) {
      postMessage(MAIN_VIEW_COMMANDS.STOP_RECORDING);
    } else {
      postMessage(MAIN_VIEW_COMMANDS.START_RECORDING);
    }
  }

  private handleApiKeyBannerAction(action: 'set' | 'guide'): void {
    const { provider } = this.apiKeyBanner;
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
          sessionType: this.sessionType,
        });
        break;
      case 'dir':
        postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, {
          customDirSet: this.agentConfigBanner.customDirSet,
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

  private handleComponentFileChange(
    e: CustomEvent<FileSelectChangeDetail>,
  ): void {
    this.handleSingleFileChange(e.detail.type, e.detail.value);
  }

  private handleComponentRefreshFiles(e: CustomEvent<FileActionDetail>): void {
    if (e.detail.type !== 'base' && e.detail.type !== 'edited') {
      this.handleRefreshFiles(e.detail.type);
    }
  }

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
      this.handleAddOpenedFiles(e.detail.type as FileType);
    }
  }

  private handleComponentEmptyFiles(
    e: CustomEvent<MultipleFilesTypeActionDetail>,
  ): void {
    this.handleEmptyFiles(e.detail.type as MultipleFileType);
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
    if (id in this.checkboxValues) {
      this.checkboxValues = {
        ...this.checkboxValues,
        [id]: checked,
      };
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
  }

  private handleComponentLatexDiffsToggle(
    e: CustomEvent<LatexDiffsToggleDetail>,
  ): void {
    this.latexdiffsVisible = e.detail.visible;
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
    this.singleFiles = { ...this.singleFiles, editedFile: e.detail.value };
    this.saveState();
  }

  private handleComponentCommitChange(
    e: CustomEvent<CommitChangeDetail>,
  ): void {
    this.commit = e.detail.value;
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
    // Note: Select element is inside InstructionPanel's shadow DOM and
    // cannot be queried from here. The disabled-option check in
    // handleAgentChange will be skipped. This should be handled by
    // InstructionPanel emitting additional event data when needed.
    this.handleAgentChange(e.detail.sessionType, e.detail.value);
  }

  private handleComponentModelChange(e: CustomEvent<ModelChangeDetail>): void {
    this.handleModelChange(e.detail.value);
  }

  private shouldForceApiKeyBanner(): boolean {
    if (this.apiKeyBanner.requiresKey) {
      return true;
    }
    const option = this.modelOptions.find((item) => item.value === this.model);
    return option?.requiresKey ?? false;
  }

  private handleComponentInstructionInput(
    e: CustomEvent<InstructionChangeDetail>,
  ): void {
    this.instruction = e.detail.value;
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
        this.instruction = '';
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

  // =========================================================================
  // Existing Handler Methods
  // =========================================================================

  private handleDependencyDismiss(): void {
    postMessage(MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING, {
      value: false,
    });
    this.dependencyBanner = { visible: false };
  }

  /** Check if a commit hash exists in the options array. */
  private hasCommitValue(value: string): boolean {
    if (!value) return false;
    const commits = this.fileOptions.commit ?? [];
    const entries = commits.some((commit) => commit.startsWith('HEAD'))
      ? commits
      : ['HEAD', ...commits];
    return entries.some((commit) => {
      const [hash] = commit.split(': ');
      return hash === value;
    });
  }

  private buildFileStateContext(): FileStateContextValue {
    return {
      sessionType: this.sessionType,
      checkboxValues: this.checkboxValues,
      singleFiles: { ...this.singleFiles },
      fileOptions: { ...this.fileOptions },
      multiFiles: { ...this.multiFiles },
      multiFilesVisible: { ...this.multiFilesVisible },
      outputFilesActive: this.outputFilesActive,
    };
  }

  private buildSessionContext(): SessionContextValue {
    return {
      sessionType: this.sessionType,
      instruction: this.instruction,
      placeholder: this.instructionPlaceholder,
      workflowAgent: this.workflowAgent,
      toolUseAgent: this.toolUseAgent,
      model: this.model,
      workflowAgentOptions: this.workflowAgentOptions,
      toolUseAgentOptions: this.toolUseAgentOptions,
      modelOptions: this.modelOptions,
      isRecording: this.isRecording,
      isPolishing: this.isPolishing,
      debugMode: this.debugMode,
    };
  }

  private isSessionContextEqual(
    current: SessionContextValue,
    next: SessionContextValue,
  ): boolean {
    return (
      current.sessionType === next.sessionType &&
      current.instruction === next.instruction &&
      current.placeholder === next.placeholder &&
      current.workflowAgent === next.workflowAgent &&
      current.toolUseAgent === next.toolUseAgent &&
      current.model === next.model &&
      this.areArraysEqual(
        current.workflowAgentOptions,
        next.workflowAgentOptions,
      ) &&
      this.areArraysEqual(
        current.toolUseAgentOptions,
        next.toolUseAgentOptions,
      ) &&
      this.areArraysEqual(current.modelOptions, next.modelOptions) &&
      current.isRecording === next.isRecording &&
      current.isPolishing === next.isPolishing &&
      current.debugMode === next.debugMode
    );
  }

  private isFileStateContextEqual(
    current: FileStateContextValue,
    next: FileStateContextValue,
  ): boolean {
    return (
      current.sessionType === next.sessionType &&
      this.areCheckboxValuesEqual(
        current.checkboxValues,
        next.checkboxValues,
      ) &&
      current.singleFiles.inputFile === next.singleFiles.inputFile &&
      current.singleFiles.referenceFile === next.singleFiles.referenceFile &&
      current.singleFiles.auxiliaryFile === next.singleFiles.auxiliaryFile &&
      current.singleFiles.mediaFile === next.singleFiles.mediaFile &&
      current.singleFiles.baseFile === next.singleFiles.baseFile &&
      current.singleFiles.editedFile === next.singleFiles.editedFile &&
      this.areArraysEqual(
        current.fileOptions.inputFile,
        next.fileOptions.inputFile,
      ) &&
      this.areArraysEqual(
        current.fileOptions.referenceFile,
        next.fileOptions.referenceFile,
      ) &&
      this.areArraysEqual(
        current.fileOptions.auxiliaryFile,
        next.fileOptions.auxiliaryFile,
      ) &&
      this.areArraysEqual(
        current.fileOptions.mediaFile,
        next.fileOptions.mediaFile,
      ) &&
      this.areArraysEqual(
        current.fileOptions.baseFile,
        next.fileOptions.baseFile,
      ) &&
      this.areArraysEqual(
        current.fileOptions.editedFile,
        next.fileOptions.editedFile,
      ) &&
      this.areArraysEqual(
        current.multiFiles.inputFiles,
        next.multiFiles.inputFiles,
      ) &&
      this.areArraysEqual(
        current.multiFiles.referenceFiles,
        next.multiFiles.referenceFiles,
      ) &&
      this.areArraysEqual(
        current.multiFiles.auxiliaryFiles,
        next.multiFiles.auxiliaryFiles,
      ) &&
      this.areArraysEqual(
        current.multiFiles.mediaFiles,
        next.multiFiles.mediaFiles,
      ) &&
      this.areArraysEqual(
        current.multiFiles.outputFiles,
        next.multiFiles.outputFiles,
      ) &&
      current.multiFilesVisible.inputFiles ===
        next.multiFilesVisible.inputFiles &&
      current.multiFilesVisible.referenceFiles ===
        next.multiFilesVisible.referenceFiles &&
      current.multiFilesVisible.auxiliaryFiles ===
        next.multiFilesVisible.auxiliaryFiles &&
      current.multiFilesVisible.mediaFiles ===
        next.multiFilesVisible.mediaFiles &&
      current.multiFilesVisible.outputFiles ===
        next.multiFilesVisible.outputFiles &&
      current.outputFilesActive === next.outputFilesActive
    );
  }

  private areCheckboxValuesEqual(
    current: CheckboxValues,
    next: CheckboxValues,
  ): boolean {
    return (
      current.autoExtractFigure === next.autoExtractFigure &&
      current.autoExtractTikzFigure === next.autoExtractTikzFigure &&
      current.autoCompileInputPdf === next.autoCompileInputPdf &&
      current.attachTeXCount === next.attachTeXCount &&
      current.attachDiagnostics === next.attachDiagnostics
    );
  }

  private areArraysEqual<T>(current: T[], next: T[]): boolean {
    if (current === next) {
      return true;
    }
    if (current.length !== next.length) {
      return false;
    }
    return current.every((value, index) => Object.is(value, next[index]));
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
    const isToolUse = this.sessionType === SESSION_TYPES.TOOL_USE;
    const fileSelectionClasses = classMap({
      'file-selection-group': true,
      'file-selection-group--disabled': isToolUse,
    });

    return html`
      <div class="content-wrapper">
        <div class="main-content">
          <div class=${fileSelectionClasses}>
            ${repeat(
              FILE_SELECT_CONFIGS,
              (config) => config.type,
              (config) => html`
                <file-select-group
                  .config=${config}
                  @file-change=${this.handleComponentFileChange}
                  @refresh-files=${this.handleComponentRefreshFiles}
                  @get-current-file=${this.handleComponentGetCurrentFile}
                  @empty-file=${this.handleComponentEmptyFile}
                  @toggle-list=${this.handleComponentToggleList}
                  @add-opened-files=${this.handleComponentAddOpenedFiles}
                  @empty-files=${this.handleComponentEmptyFiles}
                  @select-multiple-files=${this
                    .handleComponentSelectMultipleFiles}
                  @remove-file=${this.handleComponentRemoveFile}
                  @files-reordered=${this.handleComponentFilesReordered}
                  @checkbox-change=${this.handleComponentCheckboxChange}
                  @focus-instruction=${this.handleComponentFocusInstruction}
                ></file-select-group>
              `,
            )}
            <output-files-section
              @toggle-list=${this.handleComponentToggleList}
              @empty-files=${this.handleComponentEmptyFiles}
              @select-multiple-files=${this.handleComponentSelectMultipleFiles}
              @remove-file=${this.handleComponentRemoveFile}
              @files-reordered=${this.handleComponentFilesReordered}
            ></output-files-section>
          </div>

          <instruction-panel
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
          ></instruction-panel>

          <banner-group
            .apiKeyBanner=${{
              visible: this.apiKeyBanner.visible,
              provider: this.apiKeyBanner.provider,
              requiresKey: this.apiKeyBanner.requiresKey,
            }}
            .agentConfigBanner=${{
              visible: this.agentConfigBanner.visible,
              agentName: this.agentConfigBanner.agentName,
              customDirSet: this.agentConfigBanner.customDirSet,
            }}
            .dependencyBanner=${{
              visible: this.dependencyBanner.visible,
              missingTools: this.dependencyBanner.missingTools,
            }}
            .gettingStartedVisible=${this.gettingStartedVisible}
            .loginBannerVisible=${this.loginBannerVisible}
            @api-key-action=${this.handleComponentApiKeyAction}
            @agent-config-action=${this.handleComponentAgentConfigAction}
            @dependency-dismiss=${this.handleComponentDependencyDismiss}
            @recheck-dependencies=${this.handleComponentRecheckDependencies}
            @open-install-guide=${this.handleComponentOpenInstallGuide}
            @sign-in=${this.handleComponentSignIn}
            @dismiss-login=${this.handleComponentDismissLogin}
          ></banner-group>
        </div>

        <latexdiffs-section
          .visible=${this.latexdiffsVisible}
          .baseFile=${this.singleFiles.baseFile}
          .baseFileOptions=${this.fileOptions.baseFile ?? []}
          .editedFile=${this.singleFiles.editedFile}
          .editedFileOptions=${this.fileOptions.editedFile ?? []}
          .commit=${this.commit}
          .commitOptions=${this.fileOptions.commit ?? []}
          .isGitRepo=${this.isGitRepo}
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
      </div>
    `;
  }
}
