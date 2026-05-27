/**
 * Shared utilities for locating external CLI binaries shipped as npm platform
 * packages (e.g. @anthropic-ai/claude-agent-sdk-*, @openai/codex-*).
 *
 * Both the Claude Code and Codex tool implementations follow the same
 * 4-strategy resolution pattern and require identical Electron-detection and
 * path-existence helpers. Centralising them here prevents silent drift.
 */

import { platform } from '@platform/platform';

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

/**
 * Returns Electron's `process.resourcesPath` when running inside a packaged
 * Electron application. Returns `undefined` in development mode
 * (`defaultApp === true`) and in non-Electron runtimes (VS Code extension
 * host, plain Node.js).
 */
export function getPackagedElectronResourcesPath(): string | undefined {
  const electronProcess = process as ElectronProcess;
  if (electronProcess.versions.electron == null) return undefined;
  if (electronProcess.defaultApp === true) return undefined;
  return electronProcess.resourcesPath;
}

/**
 * Check whether a file-system path exists using the platform FS abstraction.
 * Returns `true` if `stat()` succeeds, `false` on any error (including ENOENT).
 */
export async function pathExists(target: string): Promise<boolean> {
  return platform()
    .fs.stat(target)
    .then(() => true)
    .catch(() => false);
}
