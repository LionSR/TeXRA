// Local imports - formatter implementations
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { getConfig } from '@utils/config/configUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';

// Local file imports
import { LATEXINDENT_CONFIG_KEY, runLatexIndent } from './latexindentpt';
import { TEXFMT_CONFIG_KEY, runTexFmt } from './texfmt';

interface LatexFormatterDefinition {
  /** Setting value that selects this formatter. */
  id: string;
  /** Config key holding this formatter's optional config-file path. */
  configKey: string;
  run(
    filePath: string,
    workspaceRoot?: string,
    configPath?: string,
  ): Promise<boolean>;
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
 */
export function resolveLatexFormatter(): LatexFormatter | null {
  const formatter = readPlatformSetting<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
  );
  if (formatter === 'none') {
    return null;
  }
  const selected = LATEX_FORMATTERS[formatter] ?? LATEX_FORMATTERS.latexindent;
  return { ...selected, configPath: getConfig<string>(selected.configKey, '') };
}

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = resolveLatexFormatter();
  return formatter
    ? formatter.run(filePath, undefined, formatter.configPath)
    : true;
}
