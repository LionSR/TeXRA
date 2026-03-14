/**
 * Robust ESM/CJS interop helper for importing the Codex class from
 * @openai/codex-sdk.
 *
 * The SDK is ESM-only but the extension is bundled as CJS. In some
 * Electron/Node.js versions the module namespace object from `import()`
 * wraps named exports under a `default` property, causing a bare
 * `{ Codex }` destructure to yield `undefined` and the subsequent
 * `new Codex()` to throw "e is not a constructor" (minified name).
 *
 * This helper probes multiple export shapes so it works regardless of
 * the runtime's interop behavior.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexConstructor = new (options?: any) => any;

export async function importCodexClass(): Promise<CodexConstructor> {
  const mod: Record<string, unknown> = await import('@openai/codex-sdk');

  // Normal named export
  if (typeof mod.Codex === 'function') {
    console.log('[Codex] Imported via named export (mod.Codex)');
    return mod.Codex as CodexConstructor;
  }

  // Wrapped under default (some ESM/CJS interop scenarios)
  const def = mod.default as Record<string, unknown> | undefined;
  if (def && typeof def.Codex === 'function') {
    console.log('[Codex] Imported via default wrapper (mod.default.Codex)');
    return def.Codex as CodexConstructor;
  }

  // Default export IS the class (unlikely, but defensive)
  if (typeof def === 'function') {
    console.log('[Codex] Imported via default export (mod.default)');
    return def as unknown as CodexConstructor;
  }

  const keys = Object.keys(mod).join(', ');
  console.log(`[Codex] Import failed. Module keys: [${keys}]`);
  throw new Error(
    `Failed to import Codex class from @openai/codex-sdk. Module keys: [${keys}]`,
  );
}
