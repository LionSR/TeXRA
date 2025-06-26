// Standard library imports
import * as vscode from 'vscode';

// Local imports - core
import { ValidationFixAgent, ValidatorType } from './ValidationFixAgent';
import { XMLValidationError, BaseError } from '@tools/anthropic/types';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with xmlValidator.
 */
export class XMLValidatorAgent extends ValidationFixAgent<XMLValidationError> {
  private constructor() {
    super('xmlValidator');
  }

  public static async create<T extends BaseError | BaseError[]>(
    _type: ValidatorType,
    context: vscode.ExtensionContext,
  ): Promise<ValidationFixAgent<T>> {
    return ValidationFixAgent.create<T>('xmlValidator', context);
  }
}
