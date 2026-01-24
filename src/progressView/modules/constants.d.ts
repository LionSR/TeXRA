export declare const STREAM_STATUS: {
  readonly RUNNING: 'running';
  readonly ERROR: 'error';
  readonly STOPPED: 'stopped';
  readonly READY: 'ready';
  readonly WAITING: 'waiting';
  readonly RESUMING: 'resuming';
};

export declare const ELEMENT_IDS: Record<string, string>;
export declare const GROUP_DOM_IDS: Readonly<{
  DETAILS_PREFIX: string;
  HEADER_PREFIX: string;
  CONTENT_PREFIX: string;
}>;
export declare const MAX_HEIGHT: number;
export declare const COMMANDS: Record<string, string>;
export declare const WORKFLOW_TOOLBAR: ReadonlyArray<Record<string, unknown>>;
export declare const TOOL_USE_TOOLBAR: ReadonlyArray<Record<string, unknown>>;
export declare const TOOLBAR_BUTTONS: Record<string, unknown>;
export declare const ALL_TOOLBAR_BUTTON_IDS: readonly string[];
export declare const SORT_BUTTONS: ReadonlyArray<{
  id: string;
  icon: string;
  sort: string;
  title: string;
}>;
export declare const FILTER_BUTTONS: ReadonlyArray<{
  id: string;
  label: string;
  filter: string;
}>;

export interface CategoryUIConfig {
  readonly showRunSelector: boolean;
  readonly showRoundHeaders: boolean;
  readonly showInstructionPanel: boolean;
  readonly taskGroupsAreSwitchable: boolean;
  readonly hasFileFields: boolean;
  readonly toolbar: ReadonlyArray<Record<string, unknown>>;
}

export declare const CATEGORY_UI_CONFIG: Readonly<{
  workflow: CategoryUIConfig;
  toolUse: CategoryUIConfig;
}>;

export declare function getCategoryUIConfig(
  category: string,
): CategoryUIConfig;
