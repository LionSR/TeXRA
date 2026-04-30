// Local imports - formatter implementations
import { getWorkspaceState } from '@agent/core/stateStore';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';

// Local file imports
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = getWorkspaceState().get<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
    LATEX_CONFIG_DEFAULTS.latexFormatter,
  );

  switch (formatter) {
    case 'none':
      return true;
    case 'tex-fmt':
      return runTexFmt(filePath);
    default:
      return runLatexIndent(filePath);
  }
}
