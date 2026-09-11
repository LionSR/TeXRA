/**
 * Reads of the current process's raw OS/runtime environment: the
 * `probe_environment` tool's OS/arch/shell summary, and the packaged-Electron
 * check native-binary resolution uses to locate `app.asar.unpacked`
 * resources.
 */
import * as os from 'node:os';

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

// Frozen: this module-level object is imported by every consumer of these
// reads, so a mutated method would change behavior for all of them (AGENTS.md
// "Never hand out a shared mutable literal").
export const nodeHostEnvironment = Object.freeze({
  hostInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    };
  },
  /**
   * `process.resourcesPath` when running inside a packaged Electron app;
   * undefined in development mode (`defaultApp === true`) and in
   * non-Electron runtimes (VS Code extension host, CLI, plain Node.js).
   */
  packagedElectronResourcesPath(): string | undefined {
    const electronProcess = process as ElectronProcess;
    if (electronProcess.versions.electron == null) return undefined;
    if (electronProcess.defaultApp === true) return undefined;
    return electronProcess.resourcesPath;
  },
});
