declare module '@progressView/modules/constants.js' {
  export const STATUS: {
    RUNNING: 'running';
    ERROR: 'error';
    STOPPED: 'stopped';
    READY: 'ready';
    WAITING: 'waiting';
    RESUMING: 'resuming';
  };

  export const ELEMENT_IDS: Record<string, string>;
  export const SPLIT_SIZES: { CONTENT: number; TABS: number };
  export const MAX_HEIGHT: number;
  export const COMMANDS: Record<string, string>;
  export const TOOLBAR_BUTTONS: Record<string, unknown>;
  export const ALL_TOOLBAR_BUTTON_IDS: string[];
  export const SORT_BUTTONS: Array<{
    id: string;
    icon: string;
    sort: string;
    title: string;
  }>;
  export const FILTER_BUTTONS: Array<{
    id: string;
    label: string;
    filter: string;
  }>;
}

declare module '*modules/constants.js' {
  export * from '@progressView/modules/constants.js';
}
