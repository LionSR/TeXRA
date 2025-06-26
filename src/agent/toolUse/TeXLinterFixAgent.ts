// Standard library imports
import * as vscode from 'vscode';

// Local imports - core
import { ValidationFixAgent, ValidatorType } from './ValidationFixAgent';
import { LinterMessage } from '@frontend/latex/linter';
import { BaseError } from '@tools/anthropic/types';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with latexLinter.
 */
export class TeXLinterFixAgent extends ValidationFixAgent<LinterMessage[]> {
  private constructor() {
    super('latexLinter');
  }

  public static async create<T extends BaseError | BaseError[]>(
    _type: ValidatorType,
    context: vscode.ExtensionContext,
  ): Promise<ValidationFixAgent<T>> {
    return ValidationFixAgent.create<T>('latexLinter', context);
  }
}
