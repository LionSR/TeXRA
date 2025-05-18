// Standard library imports
// (none needed)

/**
 * Asynchronously wait for the specified number of milliseconds.
 * @param ms Number of milliseconds to sleep
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
