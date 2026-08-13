let deferDepth = 0;
let deferredWork: Array<() => Promise<void>> = [];

export function isAgentCatalogAuthRefreshDeferred(): boolean {
  return deferDepth > 0;
}

export function runAfterAgentCatalogAuthRefresh(
  work: () => Promise<void>,
): void {
  if (deferDepth === 0) {
    void work();
    return;
  }
  deferredWork.push(work);
}

/** Keep auth listeners from racing the team preflight's single catalog fetch. */
export async function withAgentCatalogAuthRefreshDeferred<T>(
  work: () => Promise<T>,
): Promise<T> {
  deferDepth += 1;
  try {
    return await work();
  } finally {
    deferDepth -= 1;
    if (deferDepth === 0) {
      const pending = deferredWork;
      deferredWork = [];
      await Promise.allSettled(pending.map((refresh) => refresh()));
    }
  }
}

export function resetAgentCatalogAuthRefreshScopeForTests(): void {
  deferDepth = 0;
  deferredWork = [];
}
