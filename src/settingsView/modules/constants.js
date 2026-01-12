/**
 * Constants for Settings View
 */

// Settings View Commands
export const SETTINGS_VIEW_COMMANDS = {
  // Common
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
  ERROR: 'error',

  // Extension → Webview
  SET_INITIAL_DATA: 'setInitialData',
  SET_MODELS_DATA: 'setModelsData',
  SET_AGENTS_DATA: 'setAgentsData',
  SET_LATEX_DATA: 'setLatexData',
  SET_MEMORY_DATA: 'setMemoryData',
  SET_HISTORY_DATA: 'setHistoryData',
  SET_ACCOUNT_DATA: 'setAccountData',
  SELECT_TAB: 'selectTab',
  HISTORY_CLEARED: 'historyCleared',

  // Webview → Extension
  GET_INITIAL_DATA: 'getInitialData',
  TAB_CHANGED: 'tabChanged',
  SAVE_ENABLED_MODELS: 'saveEnabledModels',
  SAVE_ENABLED_AGENTS: 'saveEnabledAgents',
  SAVE_SETTING: 'saveSetting',
  SET_API_KEY: 'setApiKey',
  DELETE_API_KEY: 'deleteApiKey',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  OPEN_PROVIDER_URL: 'openProviderUrl',
  BROWSE_FILE: 'browseFile',

  // History
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_HISTORY_ITEM: 'deleteHistoryItem',
  CLEAR_HISTORY: 'clearHistory',

  // Memory
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  REFRESH_MEMORY: 'refreshMemory',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',
};

// Tab identifiers
export const TABS = {
  MODELS: 'models',
  AGENTS: 'agents',
  LATEX: 'latex',
  MEMORY: 'memory',
  HISTORY: 'history',
};

// Tab index mapping
export const TAB_INDICES = {
  models: 0,
  agents: 1,
  latex: 2,
  memory: 3,
  history: 4,
};

// Provider metadata
export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    envVar: 'ANTHROPIC_API_KEY',
  },
  openai: {
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    envVar: 'OPENAI_API_KEY',
  },
  google: {
    name: 'Google',
    keyUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GOOGLE_API_KEY',
  },
  openRouter: {
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    envVar: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    envVar: 'DEEPSEEK_API_KEY',
  },
  xai: {
    name: 'xAI (Grok)',
    keyUrl: 'https://console.x.ai',
    envVar: 'XAI_API_KEY',
  },
  moonshot: {
    name: 'Moonshot (Kimi)',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    envVar: 'MOONSHOT_API_KEY',
  },
  dashscope: {
    name: 'DashScope (Qwen)',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    envVar: 'DASHSCOPE_API_KEY',
  },
};

// Capability icons
export const CAPABILITY_ICONS = {
  reasoning: { icon: '🧠', title: 'Reasoning' },
  vision: { icon: '👁', title: 'Vision' },
  pdf: { icon: '📄', title: 'PDF' },
  audio: { icon: '🎧', title: 'Audio' },
  tools: { icon: '💬', title: 'Tools' },
  caching: { icon: '⚡', title: 'Caching' },
};

// Agent type icons (codicons)
export const AGENT_TYPE_ICONS = {
  CoT: { icon: 'lightbulb', title: 'Chain-of-Thought' },
  direct: { icon: 'zap', title: 'Direct' },
  toolUse: { icon: 'tools', title: 'Tool-Use' },
  merge: { icon: 'git-merge', title: 'Merge' },
  reflect: { icon: 'sync', title: 'Reflect' },
};

// Default replacement categories
export const REPLACEMENT_CATEGORIES = [
  'latex_spacing',
  'latex_forbidden_commands',
  'latex_xml',
  'latex_document',
  'latex_math',
  'latex_text',
  'latex_bibtex',
  'latex_comments',
  'latex_environments',
  'latex_commands',
  'latex_packages',
  'latex_misc',
  'latexdiff',
  'custom',
];

// Default regex replacement categories
export const REGEX_REPLACEMENTS = [
  'latexdiff_markup',
  'math_mode',
  'citations',
  'references',
  'environments',
  'commands',
];

// Element IDs
export const ELEMENT_IDS = {
  // Header
  SETTINGS_HEADER: 'settingsHeader',
  ACCOUNT_INFO: 'accountInfo',
  USER_EMAIL: 'userEmail',
  USER_TIER: 'userTier',
  SIGN_IN_BTN: 'signInBtn',
  SIGN_OUT_BTN: 'signOutBtn',
  MANAGE_BTN: 'manageBtn',
  NOT_LOGGED_IN_BANNER: 'notLoggedInBanner',

  // Tabs
  SETTINGS_TABS: 'settingsTabs',

  // Models Tab
  RECOMMENDED_MODELS_LIST: 'recommendedModelsList',
  PROVIDERS_LIST: 'providersList',
  MODEL_COUNT: 'modelCount',

  // Agents Tab
  BUILT_IN_AGENTS_LIST: 'builtInAgentsList',
  CUSTOM_AGENTS_LIST: 'customAgentsList',
  REMOTE_AGENTS_LIST: 'remoteAgentsList',
  REMOTE_AGENTS_SECTION: 'remoteAgentsSection',

  // History Tab
  HISTORY_LIST: 'historyList',
  HISTORY_SEARCH: 'historySearch',
  CLEAR_HISTORY_BTN: 'clearHistoryBtn',
  NO_HISTORY_MESSAGE: 'noHistoryMessage',

  // Memory Tab
  MEMORY_FILES_LIST: 'memoryFilesList',
  REFRESH_MEMORY_BTN: 'refreshMemoryBtn',
  MEMORY_STATS: 'memoryStats',
};
