// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports - platform
import type {
  AgentDirectoriesFailed,
  StateWriteFailed,
} from '@platform/interfaces';

// Local imports - shared
import type { AgentCategory, AgentSource } from '@shared/schemas';

import type { TemplateAgentFilePlan } from './backend/templateAgentCreation';

interface SettingsAgentDirectoryEntry {
  path?: string;
}

interface SettingsAgentDirectoryState {
  getConfiguredCustomDir(): string | undefined;
  setConfiguredCustomDir(path: string): Effect.Effect<void, StateWriteFailed>;
  getCustomDir(): Effect.Effect<string, AgentDirectoriesFailed>;
  getSourceDir(
    source: AgentSource,
  ): Effect.Effect<string | undefined, AgentDirectoriesFailed>;
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

export class SettingsAgentDirectoryController {
  constructor(private readonly deps: SettingsAgentDirectoryControllerDeps) {}

  getCustomDirStatus(): Effect.Effect<
    SettingsCustomAgentDirStatus,
    AgentDirectoriesFailed
  > {
    return Effect.gen({ self: this }, function* () {
      const configuredPath =
        this.deps.state.getConfiguredCustomDir()?.trim() ?? '';
      return {
        path: yield* this.deps.state.getCustomDir(),
        isDefault: configuredPath === '',
      };
    });
  }

  resetCustomDir(): Effect.Effect<void, StateWriteFailed> {
    return this.deps.state.setConfiguredCustomDir('');
  }

  setCustomDir(path: string): Effect.Effect<void, StateWriteFailed> {
    return this.deps.state.setConfiguredCustomDir(path);
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

  planOpenAgentFolder(
    source: AgentSource,
  ): Effect.Effect<SettingsOpenAgentFolderResult, AgentDirectoriesFailed> {
    return Effect.map(this.deps.state.getSourceDir(source), (sourceDir) =>
      sourceDir
        ? { ok: true, path: sourceDir }
        : { ok: false, reason: 'missingLocalDirectory' },
    );
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
  }): TemplateAgentFilePlan {
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
