import type { ProviderError } from '@shared/schemas';

/**
 * Error thrown when an agent flow fails due to a provider error.
 *
 * Carries the full ProviderError (status code, request ID, provider,
 * relay flag, stream diagnostics) through the call stack, eliminating
 * the information loss that occurs when re-wrapping as `new Error(message)`.
 */
export class AgentFlowError extends Error {
  override readonly name = 'AgentFlowError';

  constructor(readonly providerError: ProviderError) {
    super(providerError.message);
  }
}
