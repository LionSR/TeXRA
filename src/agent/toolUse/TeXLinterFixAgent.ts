// Local imports - core
import { ValidationFixAgent } from './ValidationFixAgent';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with latexLinter.
 */
export class TeXLinterFixAgent extends ValidationFixAgent<'latexLinter'> {
  private constructor() {
    super('latexLinter');
  }
}
