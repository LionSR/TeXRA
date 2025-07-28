/**
 * Anthropic Tool Module for VS Code
 *
 * This module provides implementations of Anthropic-defined tools for VS Code,
 * such as the text editor tool.
 */

// Local imports - agents
import { GenericToolUseAgent } from './GenericToolUseAgent';
import { ToolUseAgent } from './ToolUseAgent';
import type { IToolUseAgent } from './IToolUseAgent';

// Export individual classes
export { GenericToolUseAgent, ToolUseAgent };
export type { IToolUseAgent };

// Export shared tool implementations and types
export * from '@tools/anthropic/TextEditorTool';
export * from '@tools/anthropic/types';
export * from '@tools/anthropic/base';
