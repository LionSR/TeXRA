import { Effect } from 'effect';
// Third-party imports

// Local imports - formatter implementations
import { Settings, type SettingsStores } from '@texra-ai/harness/plugins';
import type { LatexFormatterValue } from '@texra/shared/constants/latexConfig';

// Local file imports
import type { ToolMissing } from '@texra/utils/system/toolChecks';
import { runLatexIndent } from './latexindentpt';
import { runTexFmt } from './texfmt';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { FileSystem } from 'effect';
import type { SettingRow } from '@texra-ai/harness/schemas';
import {
  LATEX_FORMATTER_SETTING,
  LATEXINDENT_CONFIG_SETTING,
  TEXFMT_CONFIG_SETTING,
} from '@texra/shared/settingsView/texraSettings';

interface LatexFormatterDefinition {
  /** Setting value that selects this formatter. */
  id: string;
  /** The row holding this formatter's optional config-file path. */
  configFile: SettingRow<string>;
  run(
    filePath: string,
    workspaceRoot: string | undefined,
    configPath: string,
    settings: SettingsStores,
  ): Effect.Effect<
    boolean,
    ToolMissing,
    FileSystem.FileSystem | ChildProcessSpawner
  >;
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

// Keyed by every selectable formatter, so the setting's validated value
// always names one.
const LATEX_FORMATTERS: Record<
  Exclude<LatexFormatterValue, 'none'>,
  LatexFormatterDefinition
> = {
  'tex-fmt': {
    id: 'tex-fmt',
    configFile: TEXFMT_CONFIG_SETTING,
    run: runTexFmt,
  },
  latexindent: {
    id: 'latexindent',
    configFile: LATEXINDENT_CONFIG_SETTING,
    run: runLatexIndent,
  },
};

/**
 * Resolve the configured LaTeX formatter, or null when formatting is
 * disabled. Unrecognized settings fall back to latexindent. Sole owner of the
 * formatter → runner + config-file row mapping.
 *
 * `stores` are the settings slots of the workspace the caller is formatting
 * (a session's roots), held as data, so both the formatter choice and its
 * config-file path come from that project rather than from whichever roots
 * the calling context happens to carry.
 */
export const resolveLatexFormatter = Effect.fn('resolveLatexFormatter')(
  function* (stores: SettingsStores) {
    const formatter = yield* Settings.get(stores, LATEX_FORMATTER_SETTING);
    if (formatter === 'none') {
      return null;
    }
    const selected = LATEX_FORMATTERS[formatter];
    return {
      ...selected,
      configPath: yield* Settings.get(stores, selected.configFile),
      settings: stores,
    };
  },
);
