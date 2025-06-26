/**
 * Anthropic Tool Module for VS Code
 *
 * This module provides implementations of Anthropic-defined tools for VS Code,
 * such as the text editor tool.
 */

// Local imports - agents
import { ValidationFixAgent } from './ValidationFixAgent';
import { BaseToolUseAgent } from './BaseToolUseAgent';

// Export individual classes
export { ValidationFixAgent, BaseToolUseAgent };

// Export shared tool implementations and types
export * from '@tools/anthropic/TextEditorTool';
export * from '@tools/anthropic/types';
export * from '@tools/anthropic/base';
