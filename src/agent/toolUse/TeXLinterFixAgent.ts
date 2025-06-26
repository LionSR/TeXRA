// Standard library imports
import * as vscode from 'vscode';

// Local imports - core
import { ValidationFixAgent } from './ValidationFixAgent';
import { LinterMessage } from '@frontend/latex/linter';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with latexLinter.
 */
export class TeXLinterFixAgent extends ValidationFixAgent<LinterMessage[]> {
  constructor(context: vscode.ExtensionContext) {
    super('latexLinter', context);
  }
}
