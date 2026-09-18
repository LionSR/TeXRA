// Third-party imports

// Local imports - formatter implementations
import type { ConfigProvider } from '@platform/interfaces';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readConfig } from '@utils/config/configUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';

// Local file imports
import { LATEXINDENT_CONFIG_KEY, runLatexIndent } from './latexindentpt';
import { TEXFMT_CONFIG_KEY, runTexFmt } from './texfmt';
import type { Effect, FileSystem } from 'effect';

interface LatexFormatterDefinition {
  /** Setting value that selects this formatter. */
  id: string;
  /** Config key holding this formatter's optional config-file path. */
  configKey: string;
  run(
    filePath: string,
    workspaceRoot: string | undefined,
    configPath: string,
  ): Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

export interface LatexFormatter extends LatexFormatterDefinition {
  readonly configPath: string;
}

const LATEX_FORMATTERS: Record<string, LatexFormatterDefinition> = {
  'tex-fmt': {
    id: 'tex-fmt',
    configKey: TEXFMT_CONFIG_KEY,
    run: runTexFmt,
  },
  latexindent: {
    id: 'latexindent',
    configKey: LATEXINDENT_CONFIG_KEY,
    run: runLatexIndent,
  },
};

/**
 * Resolve the configured LaTeX formatter, or null when formatting is
 * disabled. Unrecognized settings fall back to latexindent. Sole owner of the
 * formatter → runner + config-key mapping.
 *
 * `config` is the configuration of the workspace the caller is formatting,
 * held as data, so the formatter's config-file path comes from that project
 * rather than from whichever roots the calling context happens to carry.
 */
export function resolveLatexFormatter(
  config: ConfigProvider,
): LatexFormatter | null {
  const formatter = readPlatformSetting<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
  );
  if (formatter === 'none') {
    return null;
  }
  const selected = LATEX_FORMATTERS[formatter] ?? LATEX_FORMATTERS.latexindent;
  return {
    ...selected,
    configPath: readConfig<string>(config, selected.configKey, ''),
  };
}
