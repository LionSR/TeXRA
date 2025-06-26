// Local imports - core
import { ValidationFixAgent } from './ValidationFixAgent';
import { XMLValidationError } from '@tools/anthropic/types';

/**
 * Wrapper for backward compatibility. Uses ValidationFixAgent with xmlValidator.
 */
export class XMLValidatorAgent extends ValidationFixAgent<'xmlValidator'> {
  private constructor() {
    super('xmlValidator');
  }
}
