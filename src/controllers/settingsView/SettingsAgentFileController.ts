// Standard library imports
import * as path from 'path';

// Local imports - shared
import type { AgentCategory } from '@shared/schemas/agent';

export interface SettingsAgentFileEntry {
  path: string;
  multiplePath?: string;
}

export interface SettingsAgentCustomizePlan {
  targetPath: string;
  multipleCopy?: {
    sourcePath: string;
    targetPath: string;
  };
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

export interface SettingsAgentDeletePlan {
  path: string;
  multiplePath?: string;
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

    const multipleCopy = this.planMultipleCopy({
      customDir: input.customDir,
      sourceDir: input.sourceDir,
      sourcePath: input.entry.multiplePath,
    });

    return {
      ok: true,
      plan: {
        targetPath,
        ...(multipleCopy ? { multipleCopy } : {}),
      },
    };
  }

  planDeleteCustomAgent(input: {
    entry: SettingsAgentFileEntry;
    customDir: string;
  }): SettingsAgentDeleteResult {
    if (!this.isInside(input.customDir, input.entry.path)) {
      return { ok: false, reason: 'fileOutsideCustomDir' };
    }

    const multiplePath =
      input.entry.multiplePath &&
      this.isInside(input.customDir, input.entry.multiplePath)
        ? input.entry.multiplePath
        : undefined;

    return {
      ok: true,
      plan: {
        path: input.entry.path,
        ...(multiplePath ? { multiplePath } : {}),
      },
    };
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
    const description =
      input.category === 'toolUse'
        ? `${baseName} — interactive tool-use agent`
        : `${baseName} — workflow agent`;

    return {
      fileName,
      filePath: path.join(input.customDir, fileName),
      baseName,
      description,
      templateKind: input.category === 'toolUse' ? 'toolUse' : 'workflowSingle',
    };
  }

  private planMultipleCopy(input: {
    customDir: string;
    sourceDir?: string;
    sourcePath?: string;
  }): SettingsAgentCustomizePlan['multipleCopy'] | undefined {
    if (!input.sourcePath) return undefined;

    const targetPath = this.resolveCustomTargetPath({
      customDir: input.customDir,
      sourceDir: input.sourceDir,
      sourcePath: input.sourcePath,
    });

    if (!this.isInside(input.customDir, targetPath)) return undefined;

    return {
      sourcePath: input.sourcePath,
      targetPath,
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
    const relativePath = path.relative(
      path.resolve(parentDir),
      path.resolve(candidatePath),
    );
    return (
      relativePath !== '' &&
      !relativePath.startsWith('..') &&
      !path.isAbsolute(relativePath)
    );
  }
}
