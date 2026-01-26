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
import {
  decorateAgentOptions,
  decorateModelOptions,
  markOptionAsSelected,
  updateAgentSelectTooltip,
  withPlaceholder,
} from '@shared/utils/dropdown';
import {
  getSelectedOptionElement,
  isSelectLikeElement,
} from '@shared/utils/dom';
import { resolveTextareaTarget, syncHostValue } from '@shared/utils/textarea';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - shared schemas
import {
  MainViewMessageSchema,
  type MainViewMessage,
} from '@shared/schemas/mainViewMessages';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - main view
import {
  AGENT_SELECT_LIST,
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
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
import { handleImagePaste } from './pasteHandler';

// Type imports
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';

interface MainViewPersistedState extends Record<string, unknown> {
  sessionType: SessionType;
  workflowAgent: string;
  toolUseAgent: string;
  model: string;
  commit: string;
  instruction: string;
  inputFile: string;
  referenceFile: string;
  auxiliaryFile: string;
  mediaFile: string;
  editedFile: string;
  baseFile: string;
  inputFiles: string[];
  referenceFiles: string[];
  auxiliaryFiles: string[];
  mediaFiles: string[];
  outputFiles: string[];
  inputFilesVisible: boolean;
  referenceFilesVisible: boolean;
  auxiliaryFilesVisible: boolean;
  mediaFilesVisible: boolean;
  outputFilesVisible: boolean;
  outputFilesActive: boolean;
  latexdiffsVisible: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  autoCompileInputPdf: boolean;
  attachTeXCount: boolean;
  attachDiagnostics: boolean;
  agent: string;
  isToolUseAgent: boolean;
  openedFiles?: string[];
}

interface BannerState {
  visible: boolean;
  provider?: string;
  requiresKey?: boolean;
  agentName?: string;
  customDirSet?: boolean;
  missingTools?: string[];
}

const DEFAULT_STATE: MainViewPersistedState = {
  sessionType: SESSION_TYPES.TOOL_USE,
  workflowAgent: 'correct',
  toolUseAgent: 'chat',
  model: 'gemini3p',
  commit: 'HEAD',
  instruction: '',
  inputFile: '',
  referenceFile: '',
  auxiliaryFile: '',
  mediaFile: '',
  editedFile: '',
  baseFile: '',
  inputFiles: [],
  referenceFiles: [],
  auxiliaryFiles: [],
  mediaFiles: [],
  outputFiles: [],
  inputFilesVisible: false,
  referenceFilesVisible: false,
  auxiliaryFilesVisible: false,
  mediaFilesVisible: false,
  outputFilesVisible: false,
  outputFilesActive: false,
  latexdiffsVisible: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  autoCompileInputPdf: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  agent: '',
  isToolUseAgent: true,
};

const FILE_UPDATE_COMMANDS: Record<MultipleFileType, string> = {
  input: MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES,
  reference: MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES,
  auxiliary: MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES,
  media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
  output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
};

const PLACEHOLDER_ROTATION_MS = 12000;
const ONBOARDING_PLACEHOLDERS: Record<SessionType, string[]> = {
  [SESSION_TYPES.WORKFLOW]: [
    'Correct LaTeX errors, tighten language, and keep math notation intact.',
    'Convert this section into Beamer slides with bullet points.',
    'Derive the gradient of the loss function step by step.',
  ],
  [SESSION_TYPES.TOOL_USE]: [
    'Find missing citations, then suggest BibTeX entries.',
    'Scan for TODOs and draft fixes with file paths.',
    'Run LaTeX checks and report compilation warnings.',
  ],
};

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
  @state() private modelOptionsHtml = '';
  @state() private workflowAgentOptionsHtml = '';
  @state() private toolUseAgentOptionsHtml = '';
  @state() private apiKeyBanner: BannerState = { visible: false };
  @state() private agentConfigBanner: BannerState = { visible: false };
  @state() private dependencyBanner: BannerState = { visible: false };
  @state() private gettingStartedVisible = false;
  @state() private loginBannerVisible = false;
  @state() private autoExtractMenuOpen = false;
  @state() private toolConfigMenuOpen = false;
  @state() private instructionPlaceholder =
    ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0];
  @state() protected override debugMode = false;
  @state() private isGitRepo = true;
  private defaultOutputFiles: string[] = [];
  private apiKeyBannerForced = false;
  private instructionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  @query('#instruction')
  declare private instructionElement: HTMLElement | null;

  @query('#model')
  declare private modelSelectElement: HTMLElement | null;

  @query('#workflowAgent')
  declare private workflowAgentElement: HTMLElement | null;

  @query('#toolUseAgent')
  declare private toolUseAgentElement: HTMLElement | null;

  private readonly stateManager =
    new WebviewStateManager<MainViewPersistedState>(DEFAULT_STATE);
  private saveBlockCount = 0;
  private placeholderTimer: number | null = null;
  private sortables: Sortable[] = [];
  private readonly documentClickHandler = (event: MouseEvent) => {
    const path = event.composedPath();
    const autoExtractMenu = this.renderRoot.querySelector(
      `#${ELEMENT_IDS.AUTO_EXTRACT_OPTIONS}`,
    ) as HTMLElement | null;
    const toolConfigMenu = this.renderRoot.querySelector(
      `#${ELEMENT_IDS.TOOL_CONFIG_OPTIONS}`,
    ) as HTMLElement | null;
    const autoExtractButton = this.renderRoot.querySelector(
      `#${ELEMENT_IDS.TOGGLE_AUTO_EXTRACT}`,
    ) as HTMLElement | null;
    const toolConfigButton = this.renderRoot.querySelector(
      `#${ELEMENT_IDS.TOGGLE_TOOL_CONFIG}`,
    ) as HTMLElement | null;

    const clickedAutoExtract =
      (autoExtractMenu && path.includes(autoExtractMenu)) ||
      (autoExtractButton && path.includes(autoExtractButton));
    const clickedToolConfig =
      (toolConfigMenu && path.includes(toolConfigMenu)) ||
      (toolConfigButton && path.includes(toolConfigButton));

    if (!clickedAutoExtract && this.autoExtractMenuOpen) {
      this.autoExtractMenuOpen = false;
    }
    if (!clickedToolConfig && this.toolConfigMenuOpen) {
      this.toolConfigMenuOpen = false;
    }
  };
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
    document.addEventListener('click', this.documentClickHandler);
    this.restorePersistedState();
  }

  override disconnectedCallback(): void {
    document.removeEventListener('click', this.documentClickHandler);
    this.sortables.forEach((sortable) => sortable.destroy());
    this.sortables = [];
    this.stopPlaceholderRotation();
    if (this.instructionSaveTimer) {
      window.clearTimeout(this.instructionSaveTimer);
      this.instructionSaveTimer = null;
    }
    super.disconnectedCallback();
  }

  protected handleMessage(raw: unknown): void {
    const result = MainViewMessageSchema.safeParse(raw);
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
    this.setupInstructionHandlers();
    this.refreshInstructionPlaceholder(false);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has('modelOptionsHtml')) {
      const modelSelect = this.modelSelectElement;
      if (modelSelect) {
        decorateModelOptions(modelSelect);
        this.updateModelApiKeyBanner(modelSelect);
      }
    }

    if (changed.has('workflowAgentOptionsHtml')) {
      const select = this.workflowAgentElement;
      if (select) {
        decorateAgentOptions(select);
        updateAgentSelectTooltip(select);
      }
    }

    if (changed.has('toolUseAgentOptionsHtml')) {
      const select = this.toolUseAgentElement;
      if (select) {
        decorateAgentOptions(select);
        updateAgentSelectTooltip(select);
      }
    }

    if (changed.has('sessionType')) {
      this.refreshInstructionPlaceholder(false);
    }

    if (changed.has('workflowAgent') || changed.has('toolUseAgent')) {
      AGENT_SELECT_LIST.forEach((id) => {
        const select = this.renderRoot.querySelector(
          `#${id}`,
        ) as HTMLElement | null;
        if (select) {
          updateAgentSelectTooltip(select);
        }
      });
    }
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
    const saved = this.stateManager.getState();
    const state = { ...DEFAULT_STATE, ...saved };

    const sessionType =
      parseSessionType(state.sessionType) ?? DEFAULT_STATE.sessionType;

    this.sessionType = sessionType;
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

  private initializeSortables(): void {
    const listIds = MULTIPLE_FILE_TYPES.map((type) => `${type}Files`);
    listIds.forEach((listId) => {
      const element = this.renderRoot.querySelector(
        `#${listId}`,
      ) as HTMLElement | null;
      if (!element) return;
      const sortable = new Sortable(element, {
        animation: 150,
        onEnd: () => this.handleSortEnd(listId),
      });
      this.sortables.push(sortable);
    });
  }

  private handleSortEnd(listId: string): void {
    const element = this.renderRoot.querySelector(
      `#${listId}`,
    ) as HTMLElement | null;
    if (!element) return;
    // eslint-disable-next-line unicorn/prefer-spread -- NodeList lacks iterator typing.
    const items = Array.from(element.querySelectorAll('.file-item'));
    const files = items
      .map((item) => item.getAttribute('data-path') || '')
      .filter(Boolean);

    this.updateMultiFiles(listId, files);
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
    this.modelOptionsHtml = message.options;
    if (this.model && !this.hasOptionValue(message.options, this.model)) {
      this.model = '';
    }
  }

  private handleSetAgentOptions(
    message: MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS>,
  ): void {
    const options = message.options ?? {};
    if (options.workflow !== null && options.workflow !== undefined) {
      this.workflowAgentOptionsHtml = options.workflow;
      if (
        this.workflowAgent &&
        !this.hasOptionValue(options.workflow, this.workflowAgent)
      ) {
        this.workflowAgent = '';
      }
    }
    if (options.toolUse !== null && options.toolUse !== undefined) {
      this.toolUseAgentOptionsHtml = options.toolUse;
      if (
        this.toolUseAgent &&
        !this.hasOptionValue(options.toolUse, this.toolUseAgent)
      ) {
        this.toolUseAgent = '';
      }
    }
  }

  private handleSetSingleFileOptions(
    message: SetSingleFileOptionsMessage,
  ): void {
    const files = message.files ?? [];
    const command = message.command;
    const targetId = this.getSingleSelectId(command);
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
    const command = message.command;
    const key = this.getSingleSelectKey(command);
    if (!key) return;
    this.singleFiles = { ...this.singleFiles, [key]: value };
    this.saveState();
  }

  private handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    const files = message.files ?? [];
    const listId = this.getMultipleListId(message.command);
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
    } else if (
      !this.commit ||
      !this.hasOptionValue(this.buildCommitOptions(), this.commit)
    ) {
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
      const messageValues = message as unknown as Record<
        string,
        string[] | null | undefined
      >;
      const updates: Record<string, string[]> = {};
      (
        [
          'inputFiles',
          'referenceFiles',
          'auxiliaryFiles',
          'mediaFiles',
        ] as const
      ).forEach((key) => {
        const files = messageValues[key] ?? [];
        if (Array.isArray(files)) {
          const target = key.replace('Files', 'File');
          updates[target] = files;
          const currentValue =
            this.singleFiles[target as keyof typeof this.singleFiles];
          if (currentValue && !files.includes(currentValue)) {
            this.singleFiles = {
              ...this.singleFiles,
              [target]: '',
            };
          }
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

    const instructionEl = this.instructionElement;
    if (!instructionEl) {
      return;
    }

    const { textarea } = resolveTextareaTarget(instructionEl);
    if (!textarea) {
      return;
    }

    const startPos = textarea.selectionStart ?? textarea.value.length;
    const endPos = textarea.selectionEnd ?? textarea.value.length;
    const updated =
      textarea.value.slice(0, startPos) +
      message.text +
      textarea.value.slice(endPos);
    textarea.value = updated;
    textarea.setSelectionRange(
      startPos + message.text.length,
      startPos + message.text.length,
    );
    syncHostValue(instructionEl, textarea);
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
    if (!message.state || typeof message.state !== 'object') {
      return;
    }
    const state = message.state as Record<string, unknown>;
    this.blockSave();
    try {
      const sessionType = this.determineSessionType(state);
      this.sessionType = sessionType;
      this.workflowAgent = this.extractAgentValue(state, false, sessionType);
      this.toolUseAgent = this.extractAgentValue(state, true, sessionType);
      if (typeof state.model === 'string') {
        this.model = state.model;
      }
      this.instruction =
        typeof state.instruction === 'string' ? state.instruction : '';
      this.singleFiles = {
        inputFile: typeof state.inputFile === 'string' ? state.inputFile : '',
        referenceFile:
          typeof state.referenceFile === 'string' ? state.referenceFile : '',
        auxiliaryFile:
          typeof state.auxiliaryFile === 'string' ? state.auxiliaryFile : '',
        mediaFile: typeof state.mediaFile === 'string' ? state.mediaFile : '',
        editedFile:
          typeof state.editedFile === 'string' ? state.editedFile : '',
        baseFile: typeof state.baseFile === 'string' ? state.baseFile : '',
      };

      const toolConfig = (state.toolConfig as Record<string, unknown>) ?? {};
      this.checkboxValues = {
        autoExtractFigure: Boolean(
          state.autoExtractFigure ?? toolConfig.autoExtractFigure,
        ),
        autoExtractTikzFigure: Boolean(
          state.autoExtractTikzFigure ?? toolConfig.autoExtractTikzFigure,
        ),
        autoCompileInputPdf: Boolean(
          state.autoCompileInputPdf ?? toolConfig.autoCompileInputPdf,
        ),
        attachTeXCount: Boolean(
          state.attachTeXCount ?? toolConfig.attachTeXCount,
        ),
        attachDiagnostics: Boolean(
          state.attachDiagnostics ?? toolConfig.attachDiagnostics,
        ),
      };

      const activeFiles = (state.activeFiles as Record<string, boolean>) ?? {};
      this.restoreFileArrays(state, activeFiles);
    } finally {
      this.unblockSave();
    }
    this.saveState();

    if (message.executeImmediately) {
      this.executeAgent();
    }
  }

  private determineSessionType(state: Record<string, unknown>): SessionType {
    const candidate = state.agentCategory ?? state.sessionType;
    const parsed = parseSessionType(
      typeof candidate === 'string' ? candidate : undefined,
    );
    if (parsed) return parsed;
    if (state.isToolUseAgent) return SESSION_TYPES.TOOL_USE;
    return SESSION_TYPES.WORKFLOW;
  }

  private extractAgentValue(
    state: Record<string, unknown>,
    forToolUse: boolean,
    sessionType: SessionType,
  ): string {
    const explicit = forToolUse ? state.toolUseAgent : state.workflowAgent;
    if (typeof explicit === 'string') {
      return explicit;
    }

    if (
      typeof state.agent === 'string' &&
      forToolUse === (sessionType === SESSION_TYPES.TOOL_USE)
    ) {
      return state.agent;
    }

    return '';
  }

  private restoreFileArrays(
    state: Record<string, unknown>,
    activeFiles: Record<string, boolean>,
  ): void {
    const updatedFiles: Record<string, string[]> = { ...this.multiFiles };
    const updatedVisibility: Record<string, boolean> = {
      ...this.multiFilesVisible,
    };

    MULTIPLE_FILE_TYPES.forEach((fileType) => {
      const key = `${fileType}Files`;
      const files = (state[key] as string[]) ?? [];
      const visible =
        activeFiles[fileType] ??
        (state[`${key}Active`] as boolean | undefined) ??
        (state[`${key}Visible`] as boolean | undefined);
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

  private getSingleSelectId(command: string): string | null {
    switch (command) {
      case MAIN_VIEW_COMMANDS.SET_INPUT_FILE:
        return 'inputFile';
      case MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE:
        return 'referenceFile';
      case MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE:
        return 'auxiliaryFile';
      case MAIN_VIEW_COMMANDS.SET_MEDIA_FILE:
        return 'mediaFile';
      case MAIN_VIEW_COMMANDS.SET_EDITED_FILE:
        return 'editedFile';
      default:
        return null;
    }
  }

  private getSingleSelectKey(
    command: string,
  ): keyof typeof this.singleFiles | null {
    switch (command) {
      case MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED:
        return 'inputFile';
      case MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED:
        return 'referenceFile';
      case MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED:
        return 'auxiliaryFile';
      case MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED:
        return 'mediaFile';
      case MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED:
        return 'editedFile';
      default:
        return null;
    }
  }

  private getMultipleListId(command: string): string | null {
    switch (command) {
      case MAIN_VIEW_COMMANDS.SET_INPUT_FILES:
        return 'inputFiles';
      case MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES:
        return 'referenceFiles';
      case MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES:
        return 'auxiliaryFiles';
      case MAIN_VIEW_COMMANDS.SET_MEDIA_FILES:
        return 'mediaFiles';
      case MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES:
        return 'outputFiles';
      default:
        return null;
    }
  }

  private toggleMenu(type: 'autoExtract' | 'toolConfig'): void {
    if (type === 'autoExtract') {
      this.autoExtractMenuOpen = !this.autoExtractMenuOpen;
      if (this.autoExtractMenuOpen) {
        this.toolConfigMenuOpen = false;
      }
    } else {
      this.toolConfigMenuOpen = !this.toolConfigMenuOpen;
      if (this.toolConfigMenuOpen) {
        this.autoExtractMenuOpen = false;
      }
    }
  }

  private handleCheckboxChange(
    id: keyof typeof this.checkboxValues,
    value: boolean,
  ): void {
    this.checkboxValues = { ...this.checkboxValues, [id]: value };
    this.saveState();
  }

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
    const commandMap: Record<FileType, string> = {
      input: MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
      reference: MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
      auxiliary: MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
      media: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
    };
    postMessage(commandMap[type]);
  }

  private handleSingleFileChange(type: FileType, value: string): void {
    const key = `${type}File` as keyof typeof this.singleFiles;
    this.singleFiles = { ...this.singleFiles, [key]: value };
    this.saveState();

    const commandMap: Record<FileType, string> = {
      input: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
      reference: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
      auxiliary: MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
      media: MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
    };
    postMessage(commandMap[type], { filePath: value });

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

  private handleAgentChange(
    sessionType: SessionType,
    value: string,
    selectElement?: HTMLElement,
  ): void {
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
    }
    if (selectElement && isSelectLikeElement(selectElement)) {
      const selectedOption = getSelectedOptionElement(selectElement);
      if (
        selectedOption &&
        !selectedOption.classList.contains('disabled-option')
      ) {
        postMessage(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER);
      }
    }
  }

  private handleModelChange(value: string): void {
    this.model = value;
    this.saveState();
    postMessage(MAIN_VIEW_COMMANDS.MODEL_SELECTED, { model: value });
    if (this.modelSelectElement) {
      this.updateModelApiKeyBanner(this.modelSelectElement);
    }
  }

  private updateModelApiKeyBanner(selectElement: HTMLElement): void {
    if (!isSelectLikeElement(selectElement)) return;
    const selectedOption = getSelectedOptionElement(selectElement);
    const requiresKey = selectedOption?.dataset?.requiresKey === 'true';
    const provider = selectedOption?.dataset?.provider;

    if (requiresKey) {
      this.apiKeyBannerForced = false;
      this.apiKeyBanner = {
        visible: true,
        provider: provider || '',
        requiresKey: true,
      };
      return;
    }

    if (!this.apiKeyBanner.requiresKey && !this.apiKeyBannerForced) {
      this.apiKeyBanner = { visible: false };
    }
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

  private setupInstructionHandlers(): void {
    const instructionHost = this.instructionElement;
    if (!instructionHost) return;

    instructionHost.addEventListener('input', () => {
      const { textarea } = resolveTextareaTarget(instructionHost);
      if (!textarea) return;
      this.instruction = textarea.value;
      this.scheduleInstructionSave();
      if (textarea.value.trim()) {
        this.stopPlaceholderRotation();
      } else {
        this.startPlaceholderRotation();
      }
    });

    instructionHost.addEventListener('paste', async (event: Event) => {
      if (!(event instanceof ClipboardEvent)) return;
      const handled = await handleImagePaste(event, instructionHost);
      if (handled) {
        this.saveState();
      }
    });
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

  private handleDependencyDismiss(): void {
    postMessage(MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING, {
      value: false,
    });
    this.dependencyBanner = { visible: false };
  }

  private renderFileList(listId: string): TemplateResult {
    const files = this.multiFiles[listId] ?? [];
    if (files.length === 0) {
      if (listId === ELEMENT_IDS.OUTPUT_FILES) {
        return html`<div class="file-list-placeholder">
          No extra outputs selected. Click "Add" to choose files.
        </div>`;
      }
      return html`<div class="file-list-placeholder">No files selected.</div>`;
    }

    return html`${repeat(
      files,
      (file) => file,
      (file) => html`
        <div class="file-item" data-path=${file}>
          <span class="file-name">${file}</span>
          <span
            class="remove-button codicon codicon-trash"
            role="button"
            @click=${() => this.handleRemoveFile(listId, file)}
          ></span>
        </div>
      `,
    )}`;
  }

  private hasOptionValue(optionsHtml: string, value: string): boolean {
    if (!value) {
      return false;
    }
    return optionsHtml.includes(`value=\"${value}\"`);
  }

  private buildOptionsHtml(options: string[], selectedValue: string): string {
    const htmlOptions = [...options]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (value) => `<vscode-option value="${value}">${value}</vscode-option>`,
      )
      .join('\n');
    const withPlaceholderHtml = withPlaceholder(
      htmlOptions,
      '<vscode-option value="">None</vscode-option>',
    );
    return markOptionAsSelected(withPlaceholderHtml, selectedValue);
  }

  private buildCommitOptions(): string {
    const commits = this.fileOptions.commit ?? [];
    if (!this.isGitRepo) {
      return '<vscode-option value="">Not a Git repository</vscode-option>';
    }
    const entries = commits.some((commit) => commit.startsWith('HEAD'))
      ? commits
      : ['HEAD', ...commits];
    const optionsHtml = entries
      .map((commit) => {
        const [hash] = commit.split(': ');
        return `<vscode-option value="${hash}">${commit}</vscode-option>`;
      })
      .join('\n');
    return markOptionAsSelected(optionsHtml, this.commit);
  }

  render(): TemplateResult {
    const isToolUse = this.sessionType === SESSION_TYPES.TOOL_USE;
    const fileSelectionClasses = classMap({
      'file-selection-group': true,
      'file-selection-group--disabled': isToolUse,
    });

    const workflowOptions = markOptionAsSelected(
      withPlaceholder(
        this.workflowAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      this.workflowAgent,
    );
    const toolUseOptions = markOptionAsSelected(
      withPlaceholder(
        this.toolUseAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      this.toolUseAgent,
    );
    const modelOptions = markOptionAsSelected(
      withPlaceholder(
        this.modelOptionsHtml,
        '<vscode-option value="">Select model</vscode-option>',
      ),
      this.model,
    );

    return html`
      <div class="content-wrapper">
        <div class="main-content">
          <div class=${fileSelectionClasses}>
            ${this.renderFileSelect({
              type: 'input',
              label: 'Input',
              icon: 'file-code',
              refreshTitle: 'Refresh input files',
              currentTitle: 'Set current file as input',
              emptyTitle: 'Clear input file',
              toggleTitle: 'Show or hide additional input files',
              addOpenedLabel: 'Add opened files as input',
              emptyListLabel: 'Clear all input files',
              selectListLabel: 'Add input files',
              tooltip:
                'Primary files the agent processes, such as .tex, .txt, or .md',
              toolConfig: 'tool',
              focusInstruction: {
                key: 'inputFileSelect',
                text: 'Choose the main LaTeX file to process. Use the Current button to pick the active editor.',
              },
            })}
            ${this.renderFileSelect({
              type: 'reference',
              label: 'Reference',
              icon: 'book',
              refreshTitle: 'Refresh reference files',
              currentTitle: 'Set current file as reference',
              emptyTitle: 'Clear reference file',
              toggleTitle: 'Show or hide additional reference files',
              addOpenedLabel: 'Add opened files as reference',
              emptyListLabel: 'Clear all reference files',
              selectListLabel: 'Add reference files',
              tooltip:
                "Context files such as .bib/.bbl or other papers that guide output but won't be modified",
            })}
            ${this.renderFileSelect({
              type: 'auxiliary',
              label: 'Auxiliary',
              icon: 'archive',
              refreshTitle: 'Refresh auxiliary files',
              currentTitle: 'Set current file as auxiliary',
              emptyTitle: 'Clear auxiliary file',
              toggleTitle: 'Show or hide additional auxiliary files',
              addOpenedLabel: 'Add opened files as auxiliary',
              emptyListLabel: 'Clear all auxiliary files',
              selectListLabel: 'Add auxiliary files',
              tooltip:
                'Files such as .cls/.sty that define document structure and styles',
            })}
            ${this.renderFileSelect({
              type: 'media',
              label: 'Media',
              icon: 'device-camera-video',
              refreshTitle: 'Refresh media files',
              currentTitle: 'Set current file as media',
              emptyTitle: 'Clear media file',
              toggleTitle: 'Show or hide additional media files',
              addOpenedLabel: 'Add opened files as media',
              emptyListLabel: 'Clear all media files',
              selectListLabel: 'Add media files',
              tooltip: 'Images, figures, and media assets used by the document',
              toolConfig: 'autoExtract',
            })}
            <div
              class="file-select"
              data-expanded=${String(this.outputFilesActive)}
            >
              <div class="file-select-header">
                <div class="file-select-label-group">
                  <span
                    id="toggleOutputFiles"
                    class="toggle-icon"
                    title="Show or hide additional files for the agent's output"
                    @click=${() => this.toggleListVisibility('outputFiles')}
                  >
                    <i
                      class="codicon ${this.outputFilesActive
                        ? 'codicon-chevron-up'
                        : 'codicon-chevron-down'}"
                    ></i>
                  </span>
                  <span
                    class="optional-label"
                    title="List the files that should receive the agent’s output"
                    >Multiple Outputs</span
                  >
                </div>
                <vscode-toolbar-container class="file-select-actions">
                  <vscode-toolbar-button
                    id="emptyOutputFilesButton"
                    class="file-action-button"
                    icon="trash"
                    label="Clear all output files"
                    title="Clear all output files"
                    @click=${() => this.handleEmptyFiles('output')}
                  ></vscode-toolbar-button>
                  <vscode-toolbar-button
                    id="selectOutputFilesButton"
                    class="file-action-button"
                    icon="add"
                    label="Add output files"
                    title="Add output files"
                    @click=${() =>
                      this.handleSelectMultipleFiles('outputFiles')}
                  ></vscode-toolbar-button>
                </vscode-toolbar-container>
              </div>
              <div
                id="outputFilesContainer"
                class="multiple-files-container"
                style=${this.outputFilesActive
                  ? 'display: block'
                  : 'display: none'}
              >
                <div class="multiple-files-content">
                  <div id="outputFiles" class="multiple-files-list">
                    ${this.renderFileList('outputFiles')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="instruction-box">
            <div class="instruction-header">
              <div class="instruction-header-leading">
                <div class="instruction-session-toggle">
                  <input
                    type="hidden"
                    id="sessionType"
                    .value=${this.sessionType}
                  />
                  <vscode-radio-group
                    id="sessionTypeToggle"
                    aria-label="Choose the session type"
                    orientation="horizontal"
                    .value=${this.sessionType}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLInputElement | null;
                      this.handleSessionTypeChange(target?.value ?? '');
                    }}
                  >
                    <vscode-radio
                      value="toolUse"
                      data-session-type="toolUse"
                      ?checked=${this.sessionType === SESSION_TYPES.TOOL_USE}
                      title="Chat agents execute commands and scripts"
                    >
                      Chat
                    </vscode-radio>
                    <vscode-radio
                      value="workflow"
                      data-session-type="workflow"
                      ?checked=${this.sessionType === SESSION_TYPES.WORKFLOW}
                      title="Workflow agents automate document editing tasks"
                    >
                      Workflow
                    </vscode-radio>
                  </vscode-radio-group>
                </div>
              </div>
              <vscode-toolbar-container class="instruction-header-actions">
                <vscode-toolbar-button
                  id="packButton"
                  icon="archive"
                  label="Pack output to History"
                  title="Pack the output for this agent into the History folder"
                  style=${this.debugMode ? '' : 'display: none'}
                  @click=${() => this.handlePackClean('pack')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="cleanButton"
                  icon="trash"
                  label="Clean output"
                  title="Clean the output for this agent"
                  style=${this.debugMode ? '' : 'display: none'}
                  @click=${() => this.handlePackClean('clean')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="magicPolishButton"
                  icon="sparkle"
                  label="Polish instruction"
                  title="Polish instruction text with AI"
                  @click=${this.handlePolishInstruction}
                ></vscode-toolbar-button>
                <vscode-progress-ring
                  id="polishProgressContainer"
                  style=${this.isPolishing
                    ? 'display: block; width: 16px; height: 16px'
                    : 'display: none'}
                ></vscode-progress-ring>
                <vscode-toolbar-button
                  id="recordInstructionButton"
                  icon=${this.isRecording ? 'stop-circle' : 'mic'}
                  class=${this.isRecording ? 'recording' : ''}
                  label="Record instruction"
                  title=${this.isRecording
                    ? 'Stop recording'
                    : 'Record instruction with microphone'}
                  @click=${this.handleRecordingToggle}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="eraseInstructionButton"
                  icon="clear-all"
                  label="Erase instruction"
                  title="Erase instruction"
                  @click=${() => {
                    this.instruction = '';
                    this.saveState();
                  }}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-textarea
              id="instruction"
              rows="10"
              resize="none"
              placeholder=${this.instructionPlaceholder}
              .value=${this.instruction}
            ></vscode-textarea>
            <div class="instruction-controls">
              <div class="model-selection-footer">
                <div class="select-group agent-select-group">
                  <i
                    id="agentSettingsButton"
                    class="codicon codicon-sparkle clickable"
                    title="Agent settings"
                    @click=${() => this.handleAgentConfigAction('edit')}
                  ></i>
                  <div class="agent-select-controls">
                    <div class="agent-select-dropdowns">
                      <vscode-single-select
                        id="workflowAgent"
                        class=${classMap({
                          'agent-select': true,
                          'agent-select--hidden':
                            this.sessionType !== SESSION_TYPES.WORKFLOW,
                          'agent-select--active':
                            this.sessionType === SESSION_TYPES.WORKFLOW,
                        })}
                        data-session-type="workflow"
                        aria-label="Workflow agent"
                        tabindex=${this.sessionType === SESSION_TYPES.WORKFLOW
                          ? 0
                          : -1}
                        aria-hidden=${this.sessionType ===
                        SESSION_TYPES.WORKFLOW
                          ? 'false'
                          : 'true'}
                        position="above"
                        .value=${this.workflowAgent}
                        @focus=${() =>
                          postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
                            key: 'agentPicker',
                            text: 'Select which agent will handle your request.',
                          })}
                        @change=${(event: Event) => {
                          const target =
                            event.currentTarget as HTMLInputElement;
                          this.handleAgentChange(
                            SESSION_TYPES.WORKFLOW,
                            target.value,
                            target,
                          );
                        }}
                      >
                        ${unsafeHTML(workflowOptions)}
                      </vscode-single-select>
                      <vscode-single-select
                        id="toolUseAgent"
                        class=${classMap({
                          'agent-select': true,
                          'agent-select--hidden':
                            this.sessionType !== SESSION_TYPES.TOOL_USE,
                          'agent-select--active':
                            this.sessionType === SESSION_TYPES.TOOL_USE,
                        })}
                        data-session-type="toolUse"
                        aria-label="Tool-use agent"
                        position="above"
                        .value=${this.toolUseAgent}
                        @focus=${() =>
                          postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
                            key: 'agentPicker',
                            text: 'Select which agent will handle your request.',
                          })}
                        @change=${(event: Event) => {
                          const target =
                            event.currentTarget as HTMLInputElement;
                          this.handleAgentChange(
                            SESSION_TYPES.TOOL_USE,
                            target.value,
                            target,
                          );
                        }}
                      >
                        ${unsafeHTML(toolUseOptions)}
                      </vscode-single-select>
                    </div>
                  </div>
                </div>
                <div class="select-group">
                  <i
                    id="modelSettingsButton"
                    class="codicon codicon-robot clickable"
                    title="Model settings"
                    @click=${() =>
                      postMessage(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS)}
                  ></i>
                  <vscode-single-select
                    id="model"
                    position="above"
                    aria-label="Model"
                    .value=${this.model}
                    @focus=${() =>
                      postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
                        key: 'modelPicker',
                        text: 'Choose the AI model used by the selected agent.',
                      })}
                    @change=${(event: Event) => {
                      const target = event.currentTarget as HTMLInputElement;
                      this.handleModelChange(target.value);
                    }}
                  >
                    ${unsafeHTML(modelOptions)}
                  </vscode-single-select>
                </div>
              </div>
              <vscode-button
                id="executeButton"
                icon="play"
                title="Execute"
                appearance="primary"
                @click=${this.executeAgent}
              ></vscode-button>
            </div>
          </div>

          ${this.renderBanners()}
        </div>

        ${this.renderLatexdiffsSection()}
      </div>
    `;
  }

  private renderAutoExtractMenu(): TemplateResult {
    const hasChecked = CHECK_BOXES_AUTO_EXTRACT.some(
      (id) => this.checkboxValues[id],
    );
    const chevronClass = this.autoExtractMenuOpen
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="dropdown-container dropdown-left">
        <vscode-toolbar-button
          id="toggleAutoExtract"
          icon="wand"
          title="Auto-extract options"
          toggleable
          aria-haspopup="true"
          aria-expanded=${this.autoExtractMenuOpen ? 'true' : 'false'}
          ?checked=${hasChecked}
          @click=${() => this.toggleMenu('autoExtract')}
        >
          <i class="codicon ${chevronClass}"></i>
        </vscode-toolbar-button>
        <vscode-context-menu
          id="autoExtractOptions"
          class="dropdown-menu"
          .show=${this.autoExtractMenuOpen}
        >
          <div class="dropdown-menu-content">
            <vscode-checkbox
              id="autoExtractFigure"
              ?checked=${this.checkboxValues.autoExtractFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractFigure',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Figures
            </vscode-checkbox>
            <vscode-checkbox
              id="autoExtractTikzFigure"
              ?checked=${this.checkboxValues.autoExtractTikzFigure}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoExtractTikzFigure',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              TikZ Figures
            </vscode-checkbox>
            <vscode-checkbox
              id="autoCompileInputPdf"
              ?checked=${this.checkboxValues.autoCompileInputPdf}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'autoCompileInputPdf',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Compile Input PDF
            </vscode-checkbox>
          </div>
        </vscode-context-menu>
      </div>
    `;
  }

  private renderToolConfigMenu(): TemplateResult {
    const isToolUse = this.sessionType === SESSION_TYPES.TOOL_USE;
    const hasChecked = CHECK_BOXES_TOOL_USE.some(
      (id) => this.checkboxValues[id],
    );
    const chevronClass = this.toolConfigMenuOpen
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="dropdown-container dropdown-left">
        <vscode-toolbar-button
          id="toggleToolConfig"
          icon="tools"
          title="Tool configuration options"
          toggleable
          aria-haspopup="true"
          aria-expanded=${this.toolConfigMenuOpen ? 'true' : 'false'}
          ?checked=${hasChecked}
          @click=${() => this.toggleMenu('toolConfig')}
        >
          <i class="codicon ${chevronClass}"></i>
        </vscode-toolbar-button>
        <vscode-context-menu
          id="toolConfigOptions"
          class="dropdown-menu"
          .show=${this.toolConfigMenuOpen}
        >
          <div class="dropdown-menu-content">
            <vscode-checkbox
              id="attachTeXCount"
              ?checked=${this.checkboxValues.attachTeXCount}
              ?disabled=${isToolUse}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachTeXCount',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Attach TeX Count
            </vscode-checkbox>
            <vscode-checkbox
              id="attachDiagnostics"
              ?checked=${this.checkboxValues.attachDiagnostics}
              ?disabled=${isToolUse}
              @change=${(event: Event) =>
                this.handleCheckboxChange(
                  'attachDiagnostics',
                  (event.target as HTMLInputElement).checked,
                )}
            >
              Attach Diagnostics
            </vscode-checkbox>
          </div>
        </vscode-context-menu>
      </div>
    `;
  }

  private renderFileSelect(config: {
    type: FileType;
    label: string;
    icon: string;
    refreshTitle: string;
    currentTitle: string;
    emptyTitle: string;
    toggleTitle: string;
    addOpenedLabel: string;
    emptyListLabel: string;
    selectListLabel: string;
    tooltip: string;
    toolConfig?: 'tool' | 'autoExtract';
    focusInstruction?: { key: string; text: string };
  }): TemplateResult {
    const listId = `${config.type}Files`;
    const selectId = `${config.type}File` as keyof typeof this.singleFiles;
    const toggleId = `toggle${config.type[0].toUpperCase()}${config.type.slice(1)}Files`;
    const isVisible = this.multiFilesVisible[listId];
    const selectedValue = this.singleFiles[selectId];
    const chevronClass = isVisible
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';
    const toolConfigMenu =
      config.toolConfig === 'tool'
        ? this.renderToolConfigMenu()
        : config.toolConfig === 'autoExtract'
          ? this.renderAutoExtractMenu()
          : null;
    const focusHandler = config.focusInstruction
      ? () =>
          postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
            key: config.focusInstruction?.key,
            text: config.focusInstruction?.text,
          })
      : undefined;

    return html`
      <div class="file-select" data-expanded=${String(isVisible)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <vscode-toolbar-button
              id="refresh${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon=${config.icon}
              label=${config.refreshTitle}
              title=${config.refreshTitle}
              @click=${() => this.handleRefreshFiles(config.type)}
            ></vscode-toolbar-button>
            <label for=${selectId} title=${config.tooltip}
              >${config.label}</label
            >
            ${toolConfigMenu}
          </div>
          <vscode-toolbar-container class="file-select-actions">
            <vscode-toolbar-button
              id="current${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon="file-code"
              label=${config.currentTitle}
              title=${config.currentTitle}
              @click=${() => this.handleGetCurrentFile(config.type)}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FileButton"
              icon="close"
              label=${config.emptyTitle}
              title=${config.emptyTitle}
              @click=${() => this.handleEmptyFile(config.type)}
            ></vscode-toolbar-button>
            <span
              id=${toggleId}
              class="toggle-icon"
              title=${config.toggleTitle}
              @click=${() => this.toggleListVisibility(listId)}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <vscode-toolbar-button
              id="addOpened${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="folder-opened"
              label=${config.addOpenedLabel}
              title=${config.addOpenedLabel}
              @click=${() => this.handleAddOpenedFiles(config.type)}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="empty${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="trash"
              label=${config.emptyListLabel}
              title=${config.emptyListLabel}
              @click=${() => this.handleEmptyFiles(config.type)}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="select${config.type[0].toUpperCase()}${config.type.slice(
                1,
              )}FilesButton"
              class="file-action-button"
              icon="add"
              label=${config.selectListLabel}
              title=${config.selectListLabel}
              @click=${() => this.handleSelectMultipleFiles(listId)}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <vscode-single-select
          id=${selectId}
          .value=${selectedValue}
          @focus=${focusHandler}
          @change=${(event: Event) => {
            const target = event.currentTarget as HTMLInputElement;
            this.handleSingleFileChange(config.type, target.value);
          }}
        >
          ${unsafeHTML(
            this.buildOptionsHtml(
              this.fileOptions[selectId] ?? [],
              selectedValue,
            ),
          )}
        </vscode-single-select>
        <div
          id="${listId}Container"
          class="multiple-files-container"
          style=${isVisible ? 'display: block' : 'display: none'}
        >
          <div class="multiple-files-content">
            <div id=${listId} class="multiple-files-list">
              ${this.renderFileList(listId)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderBanners(): TemplateResult {
    const providerLabel = this.apiKeyBanner.provider
      ? `${this.apiKeyBanner.provider.charAt(0).toUpperCase()}${this.apiKeyBanner.provider.slice(1)}`
      : '';
    return html`
      <div
        id="apiKeyBanner"
        class="api-key-banner"
        style=${this.apiKeyBanner.visible ? 'display: flex' : 'display: none'}
      >
        <span>
          ${this.apiKeyBanner.provider
            ? html`<strong>${providerLabel}</strong> API key missing.`
            : 'TeXRA requires an API key to run.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="apiKeyBannerButton"
            icon="key"
            @click=${() => this.handleApiKeyBannerAction('set')}
          >
            ${this.apiKeyBanner.provider ? 'Set Key' : 'Set API Key'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="apiKeyGuideButton"
            icon="book"
            @click=${() => this.handleApiKeyBannerAction('guide')}
          >
            ${this.apiKeyBanner.provider ? 'Get Key' : 'API Key Guide'}
          </vscode-toolbar-button>
        </div>
      </div>

      <div
        id="agentConfigBanner"
        class="agent-config-banner"
        style=${this.agentConfigBanner.visible
          ? 'display: flex'
          : 'display: none'}
        data-custom-dir-set=${this.agentConfigBanner.customDirSet
          ? 'true'
          : 'false'}
      >
        <span>
          ${this.agentConfigBanner.agentName
            ? `Agent file for "${this.agentConfigBanner.agentName}" is missing.`
            : 'Agent configuration is missing.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="agentConfigEditButton"
            icon="edit"
            @click=${() => this.handleAgentConfigAction('edit')}
          >
            Edit Agents
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDirButton"
            icon="folder"
            @click=${() => this.handleAgentConfigAction('dir')}
          >
            ${this.agentConfigBanner.customDirSet
              ? 'Open Directory'
              : 'Set Directory'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDocButton"
            icon="book"
            @click=${() => this.handleAgentConfigAction('docs')}
          >
            Docs
          </vscode-toolbar-button>
        </div>
      </div>

      <div
        id="dependencyBanner"
        class="dependency-banner"
        style=${this.dependencyBanner.visible
          ? 'display: flex'
          : 'display: none'}
      >
        <span class="missing-tools"> ${this.renderDependencyContent()} </span>
        <div class="actions">
          <vscode-toolbar-button
            id="dependencyRecheckButton"
            icon="refresh"
            @click=${() => postMessage(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES)}
          >
            Re-check
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="dependencyDismissButton"
            class="btn-secondary"
            title="Dismiss (can be re-enabled in settings)"
            icon="close"
            @click=${this.handleDependencyDismiss}
          >
            Dismiss
          </vscode-toolbar-button>
        </div>
      </div>

      <div
        id="gettingStartedBanner"
        class="getting-started-banner"
        style=${this.gettingStartedVisible ? 'display: block' : 'display: none'}
      >
        <span class="getting-started-text">
          No files found in workspace. Try
          <a href="command:texra.openGettingStarted"
            >opening the getting started walkthrough</a
          >,
          <a href="command:texra.createSampleProject"
            >creating a sample project</a
          >,
          <a href="command:texra.cloneOverleafProject"
            >cloning an Overleaf project</a
          >, or
          <a href="command:texra.downloadArXivSource"
            >downloading an arXiv source</a
          >.
        </span>
      </div>

      <div
        id="loginBanner"
        class="login-banner"
        style=${this.loginBannerVisible ? 'display: flex' : 'display: none'}
      >
        <div class="login-banner-content">
          <span class="login-banner-icon"
            ><i class="codicon codicon-sparkle"></i
          ></span>
          <div class="login-banner-text">
            <span class="login-banner-title">Researcher Access Program</span>
            <span class="login-banner-description">
              Sign in to access AI models and remote agents without your own API
              keys.
            </span>
          </div>
        </div>
        <div class="actions">
          <vscode-button
            id="loginBannerButton"
            appearance="primary"
            @click=${() => postMessage(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER)}
          >
            <span slot="start" class="codicon codicon-sign-in"></span>
            Sign In
          </vscode-button>
          <vscode-toolbar-button
            id="loginBannerDismissButton"
            icon="close"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss login banner"
            @click=${() => postMessage(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER)}
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderDependencyContent(): TemplateResult {
    const missing = this.dependencyBanner.missingTools ?? [];
    if (missing.length === 0) {
      return html`Missing dependencies: none`;
    }

    const tools = missing.flatMap((tool) =>
      tool === 'gm/magick' ? ['gm', 'magick'] : [tool],
    );

    return html`${repeat(
      tools,
      (tool) => tool,
      (tool) => {
        const label =
          tool === 'gm'
            ? 'GraphicsMagick'
            : tool === 'magick'
              ? 'ImageMagick'
              : tool;
        return html`
          <div class="dependency-item">
            <span>${label}</span>
            <vscode-toolbar-button
              class="btn-secondary dependency-install-button"
              icon="cloud-download"
              @click=${() =>
                postMessage(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE, { tool })}
            >
              Install
            </vscode-toolbar-button>
          </div>
        `;
      },
    )}`;
  }

  private renderLatexdiffsSection(): TemplateResult {
    return html`
      <div
        class="latexdiffs-section"
        data-expanded=${String(this.latexdiffsVisible)}
      >
        <div class="file-select-header">
          <div class="file-select-label-group">
            <span
              id="toggleLatexdiffs"
              class="toggle-icon"
              title="LaTeXDiffs"
              @click=${() => {
                this.latexdiffsVisible = !this.latexdiffsVisible;
                this.saveState();
              }}
            >
              <i
                class="codicon ${this.latexdiffsVisible
                  ? 'codicon-chevron-up'
                  : 'codicon-chevron-down'}"
              ></i>
            </span>
            <span class="optional-label"
              ><i class="codicon codicon-source-control"></i> LaTeXDiffs</span
            >
          </div>
        </div>
        <div
          id="latexdiffsContent"
          style=${this.latexdiffsVisible ? 'display: block' : 'display: none'}
        >
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="baseFile">Base</label>
              </div>
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="currentBaseFileButton"
                  icon="file-code"
                  label="Set current file as base"
                  title="Set current file as base"
                  @click=${() => this.handleGetCurrentFile('base')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyBaseFileButton"
                  icon="close"
                  label="Clear base file"
                  title="Clear base file"
                  @click=${() => this.handleEmptyFile('base')}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="baseFile"
              .value=${this.singleFiles.baseFile}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.handleBaseFileChange(target.value);
              }}
            >
              ${unsafeHTML(
                this.buildOptionsHtml(
                  this.fileOptions.baseFile ?? [],
                  this.singleFiles.baseFile,
                ),
              )}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="editedFile">Edited</label>
              </div>
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="refreshEditedFileButton"
                  icon="edit"
                  label="Refresh edited files"
                  title="Refresh edited files"
                  @click=${this.handleRefreshEditedFiles}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="currentEditedFileButton"
                  icon="file-code"
                  label="Set current file as edited"
                  title="Set current file as edited"
                  @click=${() => this.handleGetCurrentFile('edited')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyEditedFileButton"
                  icon="close"
                  label="Clear edited file"
                  title="Clear edited file"
                  @click=${() => this.handleEmptyFile('edited')}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="editedFile"
              .value=${this.singleFiles.editedFile}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.singleFiles = {
                  ...this.singleFiles,
                  editedFile: target.value,
                };
                this.saveState();
              }}
            >
              ${unsafeHTML(
                this.buildOptionsHtml(
                  this.fileOptions.editedFile ?? [],
                  this.singleFiles.editedFile,
                ),
              )}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="commit">
                  <i class="codicon codicon-git-commit"></i> Commit
                </label>
              </div>
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="refreshCommitsButton"
                  icon="refresh"
                  label="Refresh commits"
                  title="Refresh commits"
                  @click=${() =>
                    postMessage(MAIN_VIEW_COMMANDS.REFRESH_COMMITS)}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="commit"
              .value=${this.commit}
              ?disabled=${!this.isGitRepo}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.commit = target.value;
                this.saveState();
              }}
            >
              ${unsafeHTML(this.buildCommitOptions())}
            </vscode-single-select>
          </div>
          <div class="instruction-controls">
            <vscode-toolbar-button
              id="latexdiffButton"
              icon="compare-changes"
              label="Run LaTeXDiff"
              title="Run LaTeXDiff"
              @click=${this.handleLatexdiff}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="latexdiffvcButton"
              icon="compare-changes"
              label="Run LaTeXDiff with version control"
              title="Run LaTeXDiff with version control"
              @click=${this.handleLatexdiffVC}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="packLatexdiffvcButton"
              icon="archive"
              label="Pack LaTeXDiff VC"
              title="Pack LaTeXDiff VC"
              @click=${() => this.handleLatexdiffVCPack('pack')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanLatexdiffvcButton"
              icon="trash"
              label="Clean LaTeXDiff VC"
              title="Clean LaTeXDiff VC"
              @click=${() => this.handleLatexdiffVCPack('clean')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="mergeButton"
              icon="merge"
              label="Merge edits"
              title="Merge edits"
              @click=${this.handleMerge}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="compareButton"
              icon="diff"
              label="Compare"
              title="Compare"
              @click=${() => this.handleCompare(MAIN_VIEW_COMMANDS.COMPARE)}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="acceptButton"
              icon="check"
              label="Accept"
              title="Accept"
              @click=${() =>
                this.handleCompare(MAIN_VIEW_COMMANDS.ACCEPT_EDITED)}
            ></vscode-toolbar-button>
          </div>
        </div>
      </div>
    `;
  }
}
