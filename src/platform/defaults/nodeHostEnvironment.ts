/**
 * Node implementation of {@link HostEnvironmentPort} — the one place raw
 * `process`/`os` environment facts get read, so business logic (setup
 * probes, native-binary resolution) never touches them directly.
 */
import * as os from 'node:os';

import type { HostEnvironmentPort } from '../interfaces';

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

export const nodeHostEnvironment: HostEnvironmentPort = {
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
};
