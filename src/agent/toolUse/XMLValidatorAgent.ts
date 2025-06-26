// Standard library imports
import * as vscode from 'vscode';

// Local imports - core
import { ValidationFixAgent } from './ValidationFixAgent';
import { XMLValidationError } from '@tools/anthropic/types';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with xmlValidator.
 */
export class XMLValidatorAgent extends ValidationFixAgent<XMLValidationError> {
  constructor(context: vscode.ExtensionContext) {
    super('xmlValidator', context);
  }
}
