/**
 * TypeScript interfaces for webview message types
 * These interfaces replace generic 'any' types with proper type definitions
 */

/**
 * Polish instruction text message from webview
 */
export interface PolishInstructionMessage {
  command: string;
  text: string;
  agent?: string;
  inputFile?: string;
  referenceFile?: string;
  auxiliaryFile?: string;
  mediaFile?: string;
  inputFiles?: string[];
  inputFilesActive?: boolean;
  referenceFiles?: string[];
  referenceFilesActive?: boolean;
  auxiliaryFiles?: string[];
  auxiliaryFilesActive?: boolean;
  mediaFiles?: string[];
  mediaFilesActive?: boolean;
  outputFiles?: string[];
  outputFilesActive?: boolean;
}

/**
 * Clipboard image message from webview
 */
export interface ClipboardImageMessage {
  command: string;
  base64: string;
  mediaType: string;
  fileName: string;
}

/**
 * File selection message from webview
 */
export interface FileSelectionMessage {
  command: string;
}

/**
 * Input file selected message from webview
 */
export interface InputFileSelectedMessage {
  command: string;
  filePath: string;
}

/**
 * Generic file selected message from webview
 */
export interface GenericFileSelectedMessage {
  command: string;
  filePath: string;
}

/**
 * Request input file message from webview
 */
export interface RequestInputFileMessage {
  command: string;
  notifyWhenEmpty?: boolean;
}

/**
 * Request file message from webview
 */
export interface RequestFileMessage {
  command: string;
  notifyWhenEmpty?: boolean;
}

/**
 * Request edited file message from webview
 */
export interface RequestEditedFileMessage {
  command: string;
  baseFile?: string;
  notifyWhenEmpty?: boolean;
}

/**
 * Request base file message from webview
 */
export interface RequestBaseFileMessage {
  command: string;
  notifyWhenEmpty?: boolean;
  preserveBaseFile?: boolean;
}

/**
 * Request default output files message from webview
 */
export interface RequestDefaultOutputFilesMessage {
  command: string;
  agent?: string;
}

/**
 * Set multiple files message from webview
 */
export interface SetMultipleFilesMessage {
  command: string;
  files?: string[];
}

/**
 * Select multiple files message from webview
 */
export interface SelectMultipleFilesMessage {
  command: string;
  fileType: string;
  currentFile?: string;
}

/**
 * Get current file message from webview
 */
export interface GetCurrentFileMessage {
  command: string;
  fileType?: string;
  baseFile?: string;
}

/**
 * Update files message from webview
 */
export interface UpdateFilesMessage {
  command: string;
  files?: string[];
}
