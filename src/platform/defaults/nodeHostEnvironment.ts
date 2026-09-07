/**
 * Node implementation of {@link HostEnvironmentPort}: the OS/arch/shell probe
 * and the packaged-Electron-resources check that used to live inline in
 * `ProbeEnvironmentTool` and `externalBinaryUtils`, respectively.
 */
import * as os from 'node:os';

import type { HostEnvironmentPort } from '../interfaces';

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

// Frozen: this module-level object is imported by every consumer of the
// port, so a mutated method would change behavior for all of them (AGENTS.md
// "Never hand out a shared mutable literal").
export const nodeHostEnvironment: HostEnvironmentPort = Object.freeze({
  hostInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    };
  },
  packagedElectronResourcesPath() {
    const electronProcess = process as ElectronProcess;
    if (electronProcess.versions.electron == null) return undefined;
    if (electronProcess.defaultApp === true) return undefined;
    return electronProcess.resourcesPath;
  },
});
