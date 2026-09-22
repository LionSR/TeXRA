import { Effect } from 'effect';
// Third-party imports

// Local imports - formatter implementations
import type { SettingsStores } from '@shared/config/settingsAccess';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';

// Local file imports
import { LATEXINDENT_CONFIG_KEY, runLatexIndent } from './latexindentpt';
import { TEXFMT_CONFIG_KEY, runTexFmt } from './texfmt';
import type { FileSystem } from 'effect';

interface LatexFormatterDefinition {
  /** Setting value that selects this formatter. */
  id: string;
  /** Config key holding this formatter's optional config-file path. */
  configKey: string;
  run(
    filePath: string,
    workspaceRoot: string | undefined,
    configPath: string,
    settings: SettingsStores,
  ): Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

export interface LatexFormatter extends LatexFormatterDefinition {
  readonly configPath: string;
  /**
   * The slots this formatter was resolved from, carried with it: the run it
   * spawns names the same project's settings that chose the formatter, so a
   * caller holding only the resolved formatter never reaches for an ambient
   * one.
   */
  readonly settings: SettingsStores;
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
 * `stores` are the settings slots of the workspace the caller is formatting
 * (a session's roots), held as data, so both the formatter choice and its
 * config-file path come from that project rather than from whichever roots
 * the calling context happens to carry.
 */
export function resolveLatexFormatter(stores: SettingsStores) {
  return Effect.gen(function* () {
    const formatter = yield* readSettingFrom<string>(
      stores,
      WorkspaceStateKey.LATEX_FORMATTER,
    );
    if (formatter === 'none') {
      return null;
    }
    const selected =
      LATEX_FORMATTERS[formatter] ?? LATEX_FORMATTERS.latexindent;
    return {
      ...selected,
      configPath: stores.config.get(selected.configKey, ''),
      settings: stores,
    };
  });
}
