// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import Sortable from 'sortablejs';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';
import { WebviewStateManager } from '@shared/state';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - shared schemas
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
} from '@shared/schemas';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - main view
import {
  AGENT_SELECT_LIST,
  ELEMENT_IDS,
  FILE_TYPES,
  MULTIPLE_FILE_TYPES,
  SESSION_TYPES,
  type FileType,
  type MultipleFileType,
  type SessionType,
  parseSessionType,
} from './constants';
import { mainViewStyles } from './styles';

// Local imports - main view components (side-effect imports to register custom elements)
import './components/FileSelectGroup';
import './components/BannerGroup';
import './components/LatexDiffsSection';
import './components/InstructionPanel';
import './components/OutputFilesSection';

// Local imports - main view store
import {
  DEFAULT_STATE,
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
  RemoveFileDetail,
  SessionTypeChangeDetail,
} from '@shared/schemas';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';

type MainViewMessageHandler = (message: MainViewMessage) => void;
type MainViewMessageFor<C extends MainViewMessage['command']> = Extract<
  MainViewMessage,
  { command: C }
>;
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
  @state() private singleFiles = {
    inputFile: DEFAULT_STATE.inputFile,
    referenceFile: DEFAULT_STATE.referenceFile,
    auxiliaryFile: DEFAULT_STATE.auxiliaryFile,
    mediaFile: DEFAULT_STATE.mediaFile,
    baseFile: DEFAULT_STATE.baseFile,
    editedFile: DEFAULT_STATE.editedFile,
  };
  @state() private fileOptions: Record<string, string[]> = {
    inputFile: [],
    referenceFile: [],
    auxiliaryFile: [],
    mediaFile: [],
    editedFile: [],
    baseFile: [],
  };
  @state() private multiFiles: Record<string, string[]> = {
    inputFiles: [],
    referenceFiles: [],
    auxiliaryFiles: [],
    mediaFiles: [],
    outputFiles: [],
  };
  @state() private multiFilesVisible: Record<string, boolean> = {
    inputFiles: false,
    referenceFiles: false,
    auxiliaryFiles: false,
    mediaFiles: false,
    outputFiles: false,
  };
  @state() private outputFilesActive = DEFAULT_STATE.outputFilesActive;
  @state() private latexdiffsVisible = DEFAULT_STATE.latexdiffsVisible;
  @state() private checkboxValues = {
    autoExtractFigure: DEFAULT_STATE.autoExtractFigure,
    autoExtractTikzFigure: DEFAULT_STATE.autoExtractTikzFigure,
    autoCompileInputPdf: DEFAULT_STATE.autoCompileInputPdf,
    attachTeXCount: DEFAULT_STATE.attachTeXCount,
    attachDiagnostics: DEFAULT_STATE.attachDiagnostics,
  };
  @state() private isRecording = false;
  @state() private isPolishing = false;
  /** @deprecated Use modelOptions for Lit-native rendering */
  @state() private modelOptionsHtml = '';
  /** @deprecated Use workflowAgentOptions for Lit-native rendering */
  @state() private workflowAgentOptionsHtml = '';
  /** @deprecated Use toolUseAgentOptions for Lit-native rendering */
  @state() private toolUseAgentOptionsHtml = '';
  /** Typed model options for Lit-native rendering */
  @state() private modelOptions: ModelOptionData[] = [];
  /** Typed workflow agent options for Lit-native rendering */
  @state() private workflowAgentOptions: AgentOptionData[] = [];
  /** Typed tool-use agent options for Lit-native rendering */
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
  private apiKeyBannerForced = false;
  private instructionSaveTimer: number | null = null;

  // Note: model/agent selects are inside InstructionPanel's shadow DOM.
  // Decoration is now handled declaratively in selectTemplates.ts via Lit templates.

  private readonly stateManager =
    new WebviewStateManager<MainViewPersistedState>(
      DEFAULT_STATE,
      MainViewPersistedStateSchema,
    );
  private saveBlockCount = 0;
  private placeholderTimer: number | null = null;
  private sortables: Sortable[] = [];
  private readonly messageHandlers: Record<string, MainViewMessageHandler> = {
    [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (message) =>
      this.handleSetModelOptions(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (message) =>
      this.handleSetAgentOptions(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: (message) =>
      this.handleSetSingleFileOptions(message as SetSingleFileOptionsMessage),
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: (message) =>
      this.handleSetSingleFileOptions(message as SetSingleFileOptionsMessage),
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: (message) =>
      this.handleSetSingleFileOptions(message as SetSingleFileOptionsMessage),
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: (message) =>
      this.handleSetSingleFileOptions(message as SetSingleFileOptionsMessage),
    [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (message) =>
      this.handleSetSingleFileOptions(message as SetSingleFileOptionsMessage),
    [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: (message) =>
      this.handleSetBaseFile(
        message as MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_BASE_FILE>,
      ),
    [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: (message) =>
      this.handleSingleFileSelected(message as SingleFileSelectedMessage),
    [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: (message) =>
      this.handleSingleFileSelected(message as SingleFileSelectedMessage),
    [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: (message) =>
      this.handleSingleFileSelected(message as SingleFileSelectedMessage),
    [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: (message) =>
      this.handleSingleFileSelected(message as SingleFileSelectedMessage),
    [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (message) =>
      this.handleSingleFileSelected(message as SingleFileSelectedMessage),
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (message) =>
      this.handleSetMultipleFiles(message as SetMultipleFilesMessage),
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: (message) =>
      this.handleSetMultipleFiles(message as SetMultipleFilesMessage),
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: (message) =>
      this.handleSetMultipleFiles(message as SetMultipleFilesMessage),
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (message) =>
      this.handleSetMultipleFiles(message as SetMultipleFilesMessage),
    [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: (message) =>
      this.handleSetMultipleFiles(message as SetMultipleFilesMessage),
    [MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES]: (message) =>
      this.handleSetDefaultOutputFiles(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES
        >,
      ),
    [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: (message) =>
      this.handleAddMediaFile(
        message as MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE>,
      ),
    [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (message) =>
      this.handleSetRecentCommits(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (message) =>
      this.handleSetCurrentFile(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_CURRENT_FILE
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT]: (message) =>
      this.handleSetSelectedCommit(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (message) =>
      this.handleSetOpenedFiles(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_OPENED_FILES
        >,
      ),
    [MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES]: (message) =>
      this.handleSetAllSingleFiles(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES
        >,
      ),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (message) =>
      this.handleInstructionTextPolished(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED
        >,
      ),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]: (message) =>
      this.handleInstructionTextPolishError(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR
        >,
      ),
    [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (message) =>
      this.handleInstructionTextTranscribed(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED
        >,
      ),
    [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: () => {
      this.isRecording = true;
    },
    [MAIN_VIEW_COMMANDS.RECORDING_STOPPED]: () => {
      this.isRecording = false;
    },
    [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: () => {
      this.isRecording = false;
    },
    [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (message) =>
      this.handleShowApiKeyBanner(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER
        >,
      ),
    [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () => {
      this.apiKeyBannerForced = false;
      this.apiKeyBanner = { visible: false };
    },
    [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (message) =>
      this.handleShowAgentConfigBanner(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER
        >,
      ),
    [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: () => {
      this.agentConfigBanner = { visible: false };
    },
    [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (message) =>
      this.handleShowDependencyBanner(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER
        >,
      ),
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
    [MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]: (message) =>
      this.handleSetSelectedAgent(
        message as MainViewMessageFor<
          typeof MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT
        >,
      ),
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.restorePersistedState();
  }

  override disconnectedCallback(): void {
    this.sortables.forEach((sortable) => sortable.destroy());
    this.sortables = [];
    this.stopPlaceholderRotation();
    if (this.instructionSaveTimer) {
      window.clearTimeout(this.instructionSaveTimer);
      this.instructionSaveTimer = null;
      this.saveState();
    }
    super.disconnectedCallback();
  }

  protected handleMessage(raw: unknown): void {
    const result = mainViewMessages.MainViewMessageSchema.safeParse(raw);
    if (!result.success) {
      this.logSchemaError(
        '[MainApp] Main view message validation failed.',
        result.error,
      );
      return;
    }

    const handler = this.messageHandlers[result.data.command];
    if (handler) {
      handler(result.data);
    }
  }

  protected override firstUpdated(): void {
    this.requestInitialData();
    this.initializeSortables();
    this.refreshInstructionPlaceholder(false);
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

  /**
   * Initialize Sortable.js for file lists.
   * Note: This queries into child component shadow DOMs which doesn't work.
   * TODO: Phase 9 - Move Sortable initialization to FileSelectGroup and
   * OutputFilesSection components, have them emit 'files-reordered' events.
   * @deprecated Sortable integration needs to be moved to child components
   */
  private initializeSortables(): void {
    // File lists are now inside shadow DOM of child components.
    // This code is preserved for backward compatibility but Sortable
    // will not initialize since elements can't be found.
    const listIds = MULTIPLE_FILE_TYPES.map((type) => `${type}Files`);
    listIds.forEach((listId) => {
      const element = this.renderRoot.querySelector(
        `#${listId}`,
      ) as HTMLElement | null;
      if (!element) return;
      const sortable = new Sortable(element, {
        animation: 150,
        onEnd: (event) => this.handleSortEnd(listId, event),
      });
      this.sortables.push(sortable);
    });
  }

  /**
   * Handle Sortable drag end - update state from event indices.
   * @deprecated Will be replaced by handling events from child components
   */
  private handleSortEnd(listId: string, event: Sortable.SortableEvent): void {
    // Use Sortable event indices instead of querying DOM
    const oldIndex = event.oldIndex;
    const newIndex = event.newIndex;
    if (oldIndex === undefined || newIndex === undefined) return;

    const current = [...(this.multiFiles[listId] ?? [])];
    const [moved] = current.splice(oldIndex, 1);
    current.splice(newIndex, 0, moved);

    this.updateMultiFiles(listId, current);
  }

  private updateMultiFiles(listId: string, files: string[]): void {
    this.multiFiles = { ...this.multiFiles, [listId]: files };
    this.saveState();

    const type = listId.replace('Files', '') as MultipleFileType;
    const command = FILE_UPDATE_COMMANDS[type];
    if (command) {
      postMessage(command, { files });
    }
  }

  private handleSetModelOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS>,
  ): void {
    // Store typed data (preferred for Lit-native rendering)
    if (message.optionsData) {
      this.modelOptions = message.optionsData;
    }
    // Also store HTML for backward compatibility during migration
    if (message.options) {
      this.modelOptionsHtml = message.options;
    }
    // Validate selected model exists in new options
    if (this.model) {
      const hasModel = message.optionsData
        ? message.optionsData.some((opt) => opt.value === this.model)
        : this.hasOptionValue(message.options ?? '', this.model);
      if (!hasModel) {
        this.model = '';
      }
    }
  }

  private handleSetAgentOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS>,
  ): void {
    const options = message.options ?? {};
    const optionsData = message.optionsData ?? {};

    // Workflow agents
    if (optionsData.workflow) {
      this.workflowAgentOptions = optionsData.workflow;
    }
    if (options.workflow !== null && options.workflow !== undefined) {
      this.workflowAgentOptionsHtml = options.workflow;
    }
    // Validate selected workflow agent
    if (this.workflowAgent) {
      const hasAgent = optionsData.workflow
        ? optionsData.workflow.some((opt) => opt.value === this.workflowAgent)
        : this.hasOptionValue(options.workflow ?? '', this.workflowAgent);
      if (!hasAgent) {
        this.workflowAgent = '';
      }
    }

    // Tool-use agents
    if (optionsData.toolUse) {
      this.toolUseAgentOptions = optionsData.toolUse;
    }
    if (options.toolUse !== null && options.toolUse !== undefined) {
      this.toolUseAgentOptionsHtml = options.toolUse;
    }
    // Validate selected tool-use agent
    if (this.toolUseAgent) {
      const hasAgent = optionsData.toolUse
        ? optionsData.toolUse.some((opt) => opt.value === this.toolUseAgent)
        : this.hasOptionValue(options.toolUse ?? '', this.toolUseAgent);
      if (!hasAgent) {
        this.toolUseAgent = '';
      }
    }
  }

  private handleSetSingleFileOptions(
    message: SetSingleFileOptionsMessage,
  ): void {
    const files = message.files ?? [];
    const targetId = this.singleSelectIdMap[message.command];
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
    const key = this.singleSelectKeyMap[message.command];
    if (!key) return;
    this.singleFiles = { ...this.singleFiles, [key]: value };
    this.saveState();
  }

  private handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    const files = message.files ?? [];
    const listId = this.multipleListIdMap[message.command];
    if (!listId) return;

    const existing = this.multiFiles[listId] ?? [];
    const merged = [...existing];
    files.forEach((file) => {
      if (!merged.includes(file)) {
        merged.push(file);
      }
    });

    this.multiFiles = { ...this.multiFiles, [listId]: merged };
    this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: true };
    if (listId === ELEMENT_IDS.OUTPUT_FILES) {
      this.outputFilesActive = true;
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
    const key = `${fileType}File`;
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
    const listId = normalizedType;
    if (!(listId in this.multiFiles)) return;

    const files = message.files ?? [];
    let filesToAdd = files;

    if (message.shouldFilter) {
      const singleFileKey = `${normalizedType.replace('Files', '')}File`;
      const selected =
        this.singleFiles[singleFileKey as keyof typeof this.singleFiles];
      if (selected) {
        filesToAdd = filesToAdd.filter((file) => file !== selected);
      }
    }

    const existing = this.multiFiles[listId] ?? [];
    const merged = [...existing];
    filesToAdd.forEach((file) => {
      if (!merged.includes(file)) {
        merged.push(file);
      }
    });
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
    if (message.text.trim()) {
      this.instruction = message.text;
      this.isPolishing = false;
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
    const updatedFiles: Record<string, string[]> = { ...this.multiFiles };
    const updatedVisibility: Record<string, boolean> = {
      ...this.multiFilesVisible,
    };

    MULTIPLE_FILE_TYPES.forEach((fileType) => {
      const key = `${fileType}Files`;
      const files = state[key as keyof MainViewPersistedState];
      const visible =
        state[`${key}Visible` as keyof MainViewPersistedState] ?? false;
      updatedFiles[key] = Array.isArray(files) ? files : [];
      updatedVisibility[key] = Boolean(visible);
    });

    this.multiFiles = updatedFiles;
    this.multiFilesVisible = updatedVisibility;
  }

  private clearForNewSession(): void {
    const isToolUse = this.sessionType === SESSION_TYPES.TOOL_USE;
    this.instruction = '';
    if (!isToolUse) {
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
      this.checkboxValues = {
        ...this.checkboxValues,
        autoExtractFigure: false,
        autoExtractTikzFigure: false,
        autoCompileInputPdf: false,
      };
      this.outputFilesActive = false;
    }
    this.saveState();
  }

  private readonly singleSelectIdMap: Record<string, string> = {
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: 'inputFile',
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: 'referenceFile',
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: 'auxiliaryFile',
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: 'mediaFile',
    [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: 'editedFile',
  };

  private readonly singleSelectKeyMap: Record<
    string,
    keyof typeof this.singleFiles
  > = {
    [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: 'inputFile',
    [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: 'referenceFile',
    [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: 'auxiliaryFile',
    [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: 'mediaFile',
    [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: 'editedFile',
  };

  private readonly multipleListIdMap: Record<string, string> = {
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: 'inputFiles',
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: 'referenceFiles',
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: 'auxiliaryFiles',
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: 'mediaFiles',
    [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: 'outputFiles',
  };

  private toggleListVisibility(listId: string): void {
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

    const initialFiles =
      this.multiFiles.outputFiles.length > 0
        ? this.multiFiles.outputFiles
        : this.defaultOutputFiles.length > 0
          ? this.defaultOutputFiles
          : [inputFile];
    this.multiFiles = { ...this.multiFiles, outputFiles: initialFiles };
  }

  private handleRemoveFile(listId: string, file: string): void {
    const files = (this.multiFiles[listId] ?? []).filter((f) => f !== file);
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
    const fileType =
      listId.length > 0
        ? `${listId[0].toUpperCase()}${listId.slice(1)}`
        : listId;
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
  }

  private handleRefreshEditedFiles = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE, {
      baseFile: this.singleFiles.baseFile,
      notifyWhenEmpty: true,
    });
  };

  private handleEmptyFiles(type: MultipleFileType): void {
    const listId = `${type}Files`;
    this.multiFiles = { ...this.multiFiles, [listId]: [] };
    this.multiFilesVisible = { ...this.multiFilesVisible, [listId]: false };
    if (type === 'output') {
      this.outputFilesActive = false;
    }
    this.saveState();
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
      this.multiFiles = { ...this.multiFiles, outputFiles: [] };
      this.multiFilesVisible = {
        ...this.multiFilesVisible,
        outputFiles: false,
      };
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
    postMessage(MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE);
    if (value) {
      postMessage(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES, {
        agent: value,
      });
      // Hide banner when a valid agent is selected.
      // Previously checked classList.contains('disabled-option') but that
      // required access to select element which is in InstructionPanel's
      // shadow DOM. If the backend needs to show the banner for disabled
      // agents, it should send a message.
      postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
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
    this.apiKeyBannerForced = true;
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
  private handleComponentInstructionPaste = (): void => {
    this.saveState();
  };

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
      const listId = `${type}Files`;
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
    postMessage(MAIN_VIEW_COMMANDS.MERGE, {
      inputFile: this.singleFiles.inputFile,
      editedFile: this.singleFiles.editedFile,
    });
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
      text: `Merging files: ${this.singleFiles.inputFile} and ${this.singleFiles.editedFile}`,
    });
  }

  private handlePackClean(action: 'pack' | 'clean'): void {
    const outputFiles = this.multiFiles.outputFiles ?? [];
    const useMultiple = this.outputFilesActive && outputFiles.length > 0;
    const command =
      action === 'pack'
        ? useMultiple
          ? MAIN_VIEW_COMMANDS.PACK_MULTIPLE
          : MAIN_VIEW_COMMANDS.PACK_SINGLE
        : useMultiple
          ? MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE
          : MAIN_VIEW_COMMANDS.CLEAN_SINGLE;

    if (!this.singleFiles.inputFile || !this.model) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: 'Please select all required fields (input file, agent, and model)',
      });
      return;
    }

    postMessage(command, {
      inputFile: this.singleFiles.inputFile,
      agent:
        this.sessionType === SESSION_TYPES.TOOL_USE
          ? this.toolUseAgent
          : this.workflowAgent,
      model: this.model,
      outputFiles: useMultiple ? outputFiles : undefined,
    });

    const actionLabel = action === 'pack' ? 'Pack' : 'Clean';
    const summary = useMultiple
      ? `${actionLabel}ing multiple files: ${[this.singleFiles.inputFile, ...outputFiles].join(', ')}`
      : `${actionLabel}ing single file: ${this.singleFiles.inputFile}`;
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, { text: summary });
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
    const provider = this.apiKeyBanner.provider;
    if (action === 'set') {
      if (provider) {
        postMessage(MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY, { provider });
      } else {
        postMessage(MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY);
      }
      return;
    }

    if (provider) {
      postMessage(MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL, { provider });
    } else {
      postMessage(MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE);
    }
  }

  private handleAgentConfigAction(action: 'edit' | 'dir' | 'docs'): void {
    if (action === 'edit') {
      postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS, {
        sessionType: this.sessionType,
      });
      return;
    }

    if (action === 'dir') {
      postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, {
        customDirSet: this.agentConfigBanner.customDirSet,
      });
      return;
    }

    postMessage(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS);
  }

  // =========================================================================
  // Component Event Handlers
  // These handlers receive custom events from child Lit components and
  // delegate to the existing handler methods.
  // =========================================================================

  private handleComponentFileChange = (
    e: CustomEvent<FileSelectChangeDetail>,
  ): void => {
    this.handleSingleFileChange(e.detail.type, e.detail.value);
  };

  private handleComponentRefreshFiles = (
    e: CustomEvent<FileActionDetail>,
  ): void => {
    if (e.detail.type !== 'base' && e.detail.type !== 'edited') {
      this.handleRefreshFiles(e.detail.type);
    }
  };

  private handleComponentGetCurrentFile = (
    e: CustomEvent<FileActionDetail>,
  ): void => {
    this.handleGetCurrentFile(e.detail.type);
  };

  private handleComponentEmptyFile = (
    e: CustomEvent<FileActionDetail>,
  ): void => {
    this.handleEmptyFile(e.detail.type);
  };

  private handleComponentToggleList = (
    e: CustomEvent<MultipleFilesActionDetail>,
  ): void => {
    this.toggleListVisibility(e.detail.listId);
  };

  private handleComponentAddOpenedFiles = (
    e: CustomEvent<MultipleFilesTypeActionDetail>,
  ): void => {
    if (e.detail.type !== 'output') {
      this.handleAddOpenedFiles(e.detail.type as FileType);
    }
  };

  private handleComponentEmptyFiles = (
    e: CustomEvent<MultipleFilesTypeActionDetail>,
  ): void => {
    this.handleEmptyFiles(e.detail.type as MultipleFileType);
  };

  private handleComponentSelectMultipleFiles = (
    e: CustomEvent<MultipleFilesActionDetail>,
  ): void => {
    this.handleSelectMultipleFiles(e.detail.listId);
  };

  private handleComponentRemoveFile = (
    e: CustomEvent<RemoveFileDetail>,
  ): void => {
    this.handleRemoveFile(e.detail.listId, e.detail.file);
  };

  private handleComponentCheckboxChange = (
    e: CustomEvent<CheckboxChangeDetail>,
  ): void => {
    const { id, checked } = e.detail;
    if (id in this.checkboxValues) {
      this.checkboxValues = {
        ...this.checkboxValues,
        [id]: checked,
      };
      this.saveState();
    }
  };

  private handleComponentFocusInstruction = (
    e: CustomEvent<FocusInstructionDetail>,
  ): void => {
    postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
      key: e.detail.key,
      text: e.detail.text,
    });
  };

  private handleComponentApiKeyAction = (
    e: CustomEvent<BannerActionDetail>,
  ): void => {
    this.handleApiKeyBannerAction(e.detail.action as 'set' | 'guide');
  };

  private handleComponentAgentConfigAction = (
    e: CustomEvent<BannerActionDetail>,
  ): void => {
    this.handleAgentConfigAction(e.detail.action as 'edit' | 'dir' | 'docs');
  };

  private handleComponentDependencyDismiss = (): void => {
    this.handleDependencyDismiss();
  };

  private handleComponentRecheckDependencies = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES);
  };

  private handleComponentOpenInstallGuide = (
    e: CustomEvent<InstallGuideDetail>,
  ): void => {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE, { tool: e.detail.tool });
  };

  private handleComponentSignIn = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER);
  };

  private handleComponentDismissLogin = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER);
  };

  private handleComponentLatexDiffsToggle = (
    e: CustomEvent<LatexDiffsToggleDetail>,
  ): void => {
    this.latexdiffsVisible = e.detail.visible;
    this.saveState();
  };

  private handleComponentLatexDiffsAction = (
    e: CustomEvent<LatexDiffsActionDetail>,
  ): void => {
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
  };

  private handleComponentBaseFileChange = (
    e: CustomEvent<BaseFileChangeDetail>,
  ): void => {
    this.handleBaseFileChange(e.detail.value);
  };

  private handleComponentEditedFileChange = (
    e: CustomEvent<EditedFileChangeDetail>,
  ): void => {
    this.singleFiles = { ...this.singleFiles, editedFile: e.detail.value };
    this.saveState();
  };

  private handleComponentCommitChange = (
    e: CustomEvent<CommitChangeDetail>,
  ): void => {
    this.commit = e.detail.value;
    this.saveState();
  };

  private handleComponentRefreshEditedFiles = (): void => {
    this.handleRefreshEditedFiles();
  };

  private handleComponentRefreshCommits = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.REFRESH_COMMITS);
  };

  // InstructionPanel component handlers
  private handleComponentSessionTypeChange = (
    e: CustomEvent<SessionTypeChangeDetail>,
  ): void => {
    this.handleSessionTypeChange(e.detail.value);
  };

  private handleComponentAgentChange = (
    e: CustomEvent<AgentChangeDetail>,
  ): void => {
    // Note: Select element is inside InstructionPanel's shadow DOM and
    // cannot be queried from here. The disabled-option check in
    // handleAgentChange will be skipped. This should be handled by
    // InstructionPanel emitting additional event data when needed.
    this.handleAgentChange(e.detail.sessionType, e.detail.value);
  };

  private handleComponentModelChange = (
    e: CustomEvent<ModelChangeDetail>,
  ): void => {
    this.handleModelChange(e.detail.value);
  };

  private handleComponentInstructionInput = (
    e: CustomEvent<InstructionChangeDetail>,
  ): void => {
    this.instruction = e.detail.value;
    this.scheduleInstructionSave();
  };

  private handleComponentPanelAction = (e: CustomEvent<ActionDetail>): void => {
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
  };

  private handleComponentExecute = (): void => {
    this.executeAgent();
  };

  private handleComponentAgentSettings = (): void => {
    this.handleAgentConfigAction('edit');
  };

  private handleComponentModelSettings = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS);
  };

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

  /** Get single file value for a file type */
  private getFileValue(type: FileType): string {
    const key = `${type}File` as keyof typeof this.singleFiles;
    return this.singleFiles[key] ?? '';
  }

  /** Get file options for a file type */
  private getFileOptions(type: FileType): string[] {
    const key = `${type}File` as keyof typeof this.fileOptions;
    return (this.fileOptions[key] as string[] | undefined) ?? [];
  }

  /** Get multi-files visibility for a file type */
  private getFilesVisible(type: FileType): boolean {
    const key = `${type}Files` as keyof typeof this.multiFilesVisible;
    return this.multiFilesVisible[key] ?? false;
  }

  /** Get multi-files array for a file type */
  private getFiles(type: FileType): string[] {
    const key = `${type}Files` as keyof typeof this.multiFiles;
    return (this.multiFiles[key] as string[] | undefined) ?? [];
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
                  .selectedValue=${this.getFileValue(config.type)}
                  .options=${this.getFileOptions(config.type)}
                  .listVisible=${this.getFilesVisible(config.type)}
                  .files=${this.getFiles(config.type)}
                  .checkboxValues=${this.checkboxValues}
                  .isToolUse=${isToolUse}
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
                  @checkbox-change=${this.handleComponentCheckboxChange}
                  @focus-instruction=${this.handleComponentFocusInstruction}
                ></file-select-group>
              `,
            )}
            <output-files-section
              .expanded=${this.outputFilesActive}
              .files=${this.multiFiles.outputFiles ?? []}
              @toggle-list=${this.handleComponentToggleList}
              @empty-files=${this.handleComponentEmptyFiles}
              @select-multiple-files=${this.handleComponentSelectMultipleFiles}
              @remove-file=${this.handleComponentRemoveFile}
            ></output-files-section>
          </div>

          <instruction-panel
            .sessionType=${this.sessionType}
            .instruction=${this.instruction}
            .placeholder=${this.instructionPlaceholder}
            .workflowAgent=${this.workflowAgent}
            .toolUseAgent=${this.toolUseAgent}
            .model=${this.model}
            .workflowAgentOptionsHtml=${this.workflowAgentOptionsHtml}
            .toolUseAgentOptionsHtml=${this.toolUseAgentOptionsHtml}
            .modelOptionsHtml=${this.modelOptionsHtml}
            .workflowAgentOptions=${this.workflowAgentOptions}
            .toolUseAgentOptions=${this.toolUseAgentOptions}
            .modelOptions=${this.modelOptions}
            .isRecording=${this.isRecording}
            .isPolishing=${this.isPolishing}
            .debugMode=${this.debugMode}
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
            } as ApiKeyBannerState}
            .agentConfigBanner=${{
              visible: this.agentConfigBanner.visible,
              agentName: this.agentConfigBanner.agentName,
              customDirSet: this.agentConfigBanner.customDirSet,
            } as AgentConfigBannerState}
            .dependencyBanner=${{
              visible: this.dependencyBanner.visible,
              missingTools: this.dependencyBanner.missingTools,
            } as DependencyBannerState}
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
