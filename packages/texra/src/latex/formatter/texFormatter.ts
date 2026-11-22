import { Effect } from 'effect';
// Third-party imports

// Local imports - formatter implementations
import { Settings, type SettingsStores } from '@texra-ai/worldline/plugins';
import type { LatexFormatterValue } from '@texra/shared/constants/latexConfig';

// Local file imports
import type { ToolMissing } from '@texra/utils/system/toolChecks';
import { runLatexIndent } from './latexindentpt';
import { runTexFmt } from './texfmt';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { FileSystem } from 'effect';
import type { SettingRow } from '@texra-ai/worldline/schemas';
import {
  LATEX_FORMATTER_SETTING,
  LATEXINDENT_CONFIG_SETTING,
  TEXFMT_CONFIG_SETTING,
} from '@texra/shared/settings/texraSettings';

interface LatexFormatterDefinition {
  /** The row holding this formatter's optional config-file path. */
  configFile: SettingRow<string>;
  run(
    filePath: string,
    workspaceRoot: string | undefined,
    configPath: string,
  ): Effect.Effect<
    boolean,
    ToolMissing,
    FileSystem.FileSystem | ChildProcessSpawner
  >;
}

export interface LatexFormatter extends LatexFormatterDefinition {
  /** The setting value that selected it. */
  readonly id: Exclude<LatexFormatterValue, 'none'>;
  readonly configPath: string;
}

// Keyed by every selectable formatter, so the setting's validated value
// always names one.
const LATEX_FORMATTERS: Record<
  Exclude<LatexFormatterValue, 'none'>,
  LatexFormatterDefinition
> = {
  'tex-fmt': {
    configFile: TEXFMT_CONFIG_SETTING,
    run: runTexFmt,
  },
  latexindent: {
    configFile: LATEXINDENT_CONFIG_SETTING,
    run: runLatexIndent,
  },
};

/**
 * Resolve the configured LaTeX formatter, or null when formatting is
 * disabled. An unset setting reads as latexindent (the row's default). Sole
 * owner of the formatter → runner + config-file row mapping.
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
      id: formatter,
      ...selected,
      configPath: yield* Settings.get(stores, selected.configFile),
    };
  },
);
