// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS } from '@latex/latexdiff/diffCommandExecutor';
import { MATH_MARKUP_OPTIONS } from '@latex/latexdiff/mathMarkup';
import { STATUS_DISPLAY, STATUS_ICONS, TODO_STATUS } from '@shared/schemas';
import {
  CORE_LATEX_TOOLS,
  IMAGE_TOOLS,
} from '@shared/constants/latexToolchain';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';
import { ARXIV_CONSTANTS, CROSSREF_CONSTANTS } from '@tools/citation/constants';
import { DEFAULT_POLLING_BACKOFF_CONFIG } from '@tools/github/PollingSourceBase';
import { GoalStore } from '@tools/goal/goalStore';
import {
  LEAN_FILE_COMMANDS,
  LEAN_PROJECT_COMMANDS,
  LEAN_SERVER_MODE_LABELS,
} from '@tools/lean/leanTypes';
import {
  SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
  setupSecrets,
  texraScopedConfig,
} from '@tools/setup/platform';

const SHARED_LITERALS = [
  ['DEFAULT_POLLING_BACKOFF_CONFIG', DEFAULT_POLLING_BACKOFF_CONFIG],
  ['GoalStore', GoalStore],
  ['setupSecrets', setupSecrets],
  ['setupSecrets.providers', setupSecrets.providers],
  ['texraScopedConfig', texraScopedConfig],
  ['ARXIV_CONSTANTS', ARXIV_CONSTANTS],
  ['CROSSREF_CONSTANTS', CROSSREF_CONSTANTS],
  ['LEAN_SERVER_MODE_LABELS', LEAN_SERVER_MODE_LABELS],
  ['WORKSPACE_STORAGE_LAYOUT', WORKSPACE_STORAGE_LAYOUT],
  ['LEAN_FILE_COMMANDS', LEAN_FILE_COMMANDS],
  ['LEAN_FILE_COMMANDS entry', LEAN_FILE_COMMANDS.restart],
  ['LEAN_PROJECT_COMMANDS', LEAN_PROJECT_COMMANDS],
  ['LEAN_PROJECT_COMMANDS entry', LEAN_PROJECT_COMMANDS.build],
  ['CORE_LATEX_TOOLS', CORE_LATEX_TOOLS],
  ['IMAGE_TOOLS', IMAGE_TOOLS],
  [
    'SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES',
    SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
  ],
  [
    'LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS',
    LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS,
  ],
  ['MATH_MARKUP_OPTIONS', MATH_MARKUP_OPTIONS],
  ['API_KEY_PROVIDER_IDS', API_KEY_PROVIDER_IDS],
  ['TOOL_JSON_SCHEMA_OPTIONS', TOOL_JSON_SCHEMA_OPTIONS],
  ['STATUS_ICONS', STATUS_ICONS],
  ['STATUS_DISPLAY', STATUS_DISPLAY],
  ['STATUS_DISPLAY entry', STATUS_DISPLAY[TODO_STATUS.IN_PROGRESS]],
] as const;

describe('shared literal exports', () => {
  it.each(SHARED_LITERALS)('%s is frozen', (name, value) => {
    expect(Object.isFrozen(value)).toBe(true);
  });
});
