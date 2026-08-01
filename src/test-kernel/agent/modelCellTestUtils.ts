import { ModelCell, type RunModelHandler } from '@agent/runtime/ModelCell';

/**
 * Wrap a partial model-handler stub in the `ModelCell` a services bag carries.
 * Scenarios stub only the handler members they drive, so the cast is the same
 * one the bags themselves already use.
 */
export function testModelCell<C = unknown>(
  handler: unknown,
  modelId = 'test-model',
): ModelCell<C> {
  return new ModelCell(handler as RunModelHandler<C>, modelId);
}
