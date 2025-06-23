/**
 * Anthropic Tool Module for VS Code
 *
 * This module provides implementations of Anthropic-defined tools for VS Code,
 * such as the text editor tool.
 */

// Local imports - agents
import { XMLValidatorAgent } from './XMLValidatorAgent';
import { TeXLinterFixAgent } from './TeXLinterFixAgent';
import { AnthropicToolAgent } from './AnthropicToolAgent';

// Export individual classes
export { XMLValidatorAgent, TeXLinterFixAgent, AnthropicToolAgent };

// Export type definitions
export * from './types';

// Export base tools
export * from './base';

// Export tool implementations
export * from './TextEditorTool';
