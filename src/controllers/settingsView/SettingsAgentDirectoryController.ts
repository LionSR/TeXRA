// Local imports - shared
import type { AgentSource } from '@shared/schemas/agent';

export interface SettingsAgentDirectoryEntry {
  path?: string;
}

interface SettingsAgentDirectoryState {
  getConfiguredCustomDir(): string | undefined;
  setConfiguredCustomDir(path: string): Promise<void>;
  getCustomDir(): Promise<string>;
  getSourceDir(source: AgentSource): Promise<string | undefined>;
  getAgent(
    source: AgentSource,
    name: string,
  ): SettingsAgentDirectoryEntry | null;
}

export interface SettingsAgentDirectoryControllerDeps {
  state: SettingsAgentDirectoryState;
}

export interface SettingsCustomAgentDirStatus {
  path: string;
  isDefault: boolean;
}

export type SettingsOpenAgentYamlResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missingAgent' | 'missingPath' };

export type SettingsRevealAgentFileResult =
  { ok: true; path: string } | { ok: false; reason: 'missingFile' };

export type SettingsOpenAgentFolderResult =
  { ok: true; path: string } | { ok: false; reason: 'missingLocalDirectory' };

export class SettingsAgentDirectoryController {
  constructor(private readonly deps: SettingsAgentDirectoryControllerDeps) {}

  async getCustomDirStatus(): Promise<SettingsCustomAgentDirStatus> {
    const configuredPath =
      this.deps.state.getConfiguredCustomDir()?.trim() ?? '';
    return {
      path: await this.deps.state.getCustomDir(),
      isDefault: configuredPath === '',
    };
  }

  async resetCustomDir(): Promise<void> {
    await this.deps.state.setConfiguredCustomDir('');
  }

  async setCustomDir(path: string): Promise<void> {
    await this.deps.state.setConfiguredCustomDir(path);
  }

  planOpenAgentYaml(input: {
    source: AgentSource;
    name: string;
  }): SettingsOpenAgentYamlResult {
    const entry = this.deps.state.getAgent(input.source, input.name);
    if (!entry) return { ok: false, reason: 'missingAgent' };

    if (!entry.path) return { ok: false, reason: 'missingPath' };

    return { ok: true, path: entry.path };
  }

  planRevealAgentFile(input: {
    source: AgentSource;
    name: string;
  }): SettingsRevealAgentFileResult {
    const entry = this.deps.state.getAgent(input.source, input.name);
    if (!entry?.path) return { ok: false, reason: 'missingFile' };

    return { ok: true, path: entry.path };
  }

  async planOpenAgentFolder(
    source: AgentSource,
  ): Promise<SettingsOpenAgentFolderResult> {
    const sourceDir = await this.deps.state.getSourceDir(source);
    if (!sourceDir) return { ok: false, reason: 'missingLocalDirectory' };

    return { ok: true, path: sourceDir };
  }
}
