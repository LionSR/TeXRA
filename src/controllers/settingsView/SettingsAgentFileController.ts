// Standard library imports
import * as path from 'node:path';

// Local imports - shared
import type { AgentCategory } from '@shared/schemas';

interface SettingsAgentTemplatePlan {
  fileName: string;
  filePath: string;
  baseName: string;
  description: string;
  templateKind: 'toolUse' | 'workflowSingle';
}

export class SettingsAgentFileController {
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
