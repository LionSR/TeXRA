declare module '@webview/modules/constants.js' {
  export const ELEMENT_IDS: Record<string, string>;
  export const SESSION_TYPES: Record<string, string>;
  export const SESSION_TYPE_INPUT: string;
}

declare module '@webview/modules/mainViewState.js' {
  export const mainViewState: any;
}

declare module '@webview/modules/state/currentContext.js' {
  export function collectCurrentContext(options?: any): any;
}

declare module '@webview/modules/uiManagers/FileList.js' {
  export const fileList: any;
}
