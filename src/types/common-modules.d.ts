declare module '@common/modules/domUtils.js' {
  export function getRadioChangeValue(
    event: Event,
    radioGroup?: HTMLElement | null,
  ): string;
  export function setRadioGroupValue(
    radioGroup: HTMLElement,
    value: string,
    selector?: string,
  ): void;
  export function scrollToBottom(element: HTMLElement | null): void;
  export function setChevronIconHorizontal(
    element: HTMLElement | null,
    expanded: boolean,
  ): void;
  export function safeGetElementById(id: string): HTMLElement | null;
}

declare module '@common/modules/RecordingButtonManager.js' {
  export class RecordingButtonManager {
    constructor(
      vscode: { postMessage(message: unknown): void },
      config: {
        buttonId: string;
        root?: HTMLElement;
        startCommand: string;
        stopCommand: string;
        startTitle?: string;
        stopTitle?: string;
        startIcon?: string;
        stopIcon?: string;
        recordingClass?: string;
      },
    );
    setup(): void;
    setRecording(recording: boolean): void;
    dispose(): void;
  }
}

declare module '@common/modules/iconConstants.js' {
  export const CHEVRON_UP_CLASS: string;
  export const CHEVRON_DOWN_CLASS: string;
  export const CHEVRON_RIGHT_CLASS: string;
  export const AGENT_DECORATORS: {
    properties: {
      remote: { icon: string; hint: string };
      multipleOutputs: { icon: string; hint: string };
    };
  };
  export function getAgentCategoryDecorator(category: string): {
    icon: string;
    label: string;
  };
}

declare module '@common/modules/templateUtils.js' {
  export function createFromTemplate(
    templateId: string,
    parent?: HTMLElement | null,
  ): HTMLElement | null;
}

