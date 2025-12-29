/**
 * Shared code between extension host and webview.
 *
 * This module provides types, schemas, and utilities that can be imported
 * from both the VS Code extension host (Node.js) and webview (browser) contexts.
 *
 * @example
 * // In extension host code:
 * import { MAIN_VIEW_COMMANDS, PolishInstructionMessageSchema } from '@shared';
 *
 * // In webview client code:
 * import { MAIN_VIEW_COMMANDS, type PolishInstructionMessage } from '@shared';
 *
 * @module @shared
 */

export * from './constants';
export * from './schemas';
