// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS } from '@latex/latexdiff/diffCommandExecutor';
import { MATH_MARKUP_OPTIONS } from '@latex/latexdiff/mathMarkup';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
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
import { CORE_LATEX_TOOLS, IMAGE_TOOLS } from '@tools/setup/toolProbing';

const SHARED_LITERALS = [
  ['noopAgentRuntimeHost', noopAgentRuntimeHost],
  ['DEFAULT_POLLING_BACKOFF_CONFIG', DEFAULT_POLLING_BACKOFF_CONFIG],
  ['GoalStore', GoalStore],
  ['setupSecrets', setupSecrets],
  ['texraScopedConfig', texraScopedConfig],
  ['ARXIV_CONSTANTS', ARXIV_CONSTANTS],
  ['CROSSREF_CONSTANTS', CROSSREF_CONSTANTS],
  ['LEAN_SERVER_MODE_LABELS', LEAN_SERVER_MODE_LABELS],
  ['WORKSPACE_STORAGE_LAYOUT', WORKSPACE_STORAGE_LAYOUT],
  ['LEAN_FILE_COMMANDS', LEAN_FILE_COMMANDS],
  ['LEAN_PROJECT_COMMANDS', LEAN_PROJECT_COMMANDS],
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
] as const;

describe('shared literal exports', () => {
  it.each(SHARED_LITERALS)('%s is frozen', (_name, value) => {
    expect(Object.isFrozen(value)).toBe(true);
  });
});
