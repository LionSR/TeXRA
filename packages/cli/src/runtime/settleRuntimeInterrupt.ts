/**
 * Translate process-runtime disposal into a settled result. ManagedRuntime
 * `runPromise` rejects with an interrupt Error when `dispose()` runs; CLI
 * callers that fire-and-forget (`void copyQuestion()`) must not see that
 * rejection.
 */
export async function settleRuntimeInterrupt<A>(
  run: () => Promise<A>,
  onInterrupt: () => Promise<A>,
): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error) || !/interrupted/i.test(error.message)) {
      throw error;
    }
    return onInterrupt();
  }
}
