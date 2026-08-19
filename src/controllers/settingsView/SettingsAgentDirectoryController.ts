// Standard library imports
import * as path from 'node:path';

// Local imports - shared
import type { AgentCategory, AgentSource } from '@shared/schemas';

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

interface SettingsAgentDirectoryControllerDeps {
  state: SettingsAgentDirectoryState;
}

interface SettingsCustomAgentDirStatus {
  path: string;
  isDefault: boolean;
}

type SettingsOpenAgentYamlResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missingAgent' | 'missingPath' };

type SettingsRevealAgentFileResult =
  { ok: true; path: string } | { ok: false; reason: 'missingFile' };

type SettingsOpenAgentFolderResult =
  { ok: true; path: string } | { ok: false; reason: 'missingLocalDirectory' };

interface SettingsAgentTemplatePlan {
  fileName: string;
  filePath: string;
  baseName: string;
  description: string;
  templateKind: 'toolUse' | 'workflowSingle';
}

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

  /** Rejection reason for a proposed custom-agent file name, or null. */
  validateTemplateName(value: string): string | null {
    if (!value) return 'Name cannot be empty';
    if (value.includes('/') || value.includes('\\')) {
      return 'Name cannot contain path separators';
    }
    if (value.includes(' ')) return 'Use underscores instead of spaces';
    if (/[:#[\]{}|>&*!%@`]/.test(value)) {
      return 'Name cannot contain YAML-special characters';
    }
    return null;
  }

  planTemplateAgent(input: {
    category: AgentCategory;
    name: string;
    customDir: string;
  }): SettingsAgentTemplatePlan {
    const fileName = input.name.endsWith('.yaml')
      ? input.name
      : `${input.name}.yaml`;
    const baseName = input.name.replace(/\.yaml$/, '');
    const isToolUse = input.category === 'toolUse';
    const description = isToolUse
      ? `${baseName} — interactive tool-use agent`
      : `${baseName} — workflow agent`;

    return {
      fileName,
      filePath: path.join(input.customDir, fileName),
      baseName,
      description,
      templateKind: isToolUse ? 'toolUse' : 'workflowSingle',
    };
  }
}
