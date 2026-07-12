// Standard library imports
import * as path from 'node:path';

// Local imports - shared
import type { AgentCategory } from '@shared/schemas/agent';
import { isStrictlyWithin } from '@utils/core/pathCore';

export interface SettingsAgentFileEntry {
  path: string;
}

interface SettingsAgentCustomizePlan {
  targetPath: string;
}

export type SettingsAgentCustomizeResult =
  | {
      ok: true;
      plan: SettingsAgentCustomizePlan;
    }
  | {
      ok: false;
      reason: 'targetEscapesCustomDir';
    };

interface SettingsAgentDeletePlan {
  path: string;
}

export type SettingsAgentDeleteResult =
  | {
      ok: true;
      plan: SettingsAgentDeletePlan;
    }
  | {
      ok: false;
      reason: 'fileOutsideCustomDir';
    };

export interface SettingsAgentTemplatePlan {
  fileName: string;
  filePath: string;
  baseName: string;
  description: string;
  templateKind: 'toolUse' | 'workflowSingle';
}

export class SettingsAgentFileController {
  planCustomizeAgent(input: {
    entry: SettingsAgentFileEntry;
    customDir: string;
    sourceDir?: string;
  }): SettingsAgentCustomizeResult {
    const targetPath = this.resolveCustomTargetPath({
      customDir: input.customDir,
      sourceDir: input.sourceDir,
      sourcePath: input.entry.path,
    });

    if (!this.isInside(input.customDir, targetPath)) {
      return { ok: false, reason: 'targetEscapesCustomDir' };
    }

    return { ok: true, plan: { targetPath } };
  }

  planDeleteCustomAgent(input: {
    entry: SettingsAgentFileEntry;
    customDir: string;
  }): SettingsAgentDeleteResult {
    if (!this.isInside(input.customDir, input.entry.path)) {
      return { ok: false, reason: 'fileOutsideCustomDir' };
    }

    return { ok: true, plan: { path: input.entry.path } };
  }

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

  private resolveCustomTargetPath(input: {
    customDir: string;
    sourceDir?: string;
    sourcePath: string;
  }): string {
    const relativePath = input.sourceDir
      ? path.relative(input.sourceDir, input.sourcePath)
      : path.basename(input.sourcePath);
    return path.join(input.customDir, relativePath);
  }

  private isInside(parentDir: string, candidatePath: string): boolean {
    return isStrictlyWithin(
      path.resolve(parentDir),
      path.resolve(candidatePath),
    );
  }
}
