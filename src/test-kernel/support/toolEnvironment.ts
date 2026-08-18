import {
  createRunContext,
  withRunContext,
  type CreateRunContextOptions,
} from '@agent/runtime/RunContext';
import {
  withToolFileInteractionContext,
  type ToolCallContext,
} from '@agent/followUp/ToolFileInteractionContext';

/**
 * Test helper: install a RunContext and a tool-call frame in one call.
 *
 * Tests that exercise tools-side code typically need both an active run
 * (for `tryUseRunContext()` consumers) and a tool-call frame (for tracker
 * and callbacks). This wraps the two stack pushes in one composer.
 */
export function withToolEnvironment<T>(
  env: { run: CreateRunContextOptions; call: ToolCallContext },
  fn: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(
    withRunContext(createRunContext(env.run), () =>
      withToolFileInteractionContext(env.call, fn),
    ),
  );
}
