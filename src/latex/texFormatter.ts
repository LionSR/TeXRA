// Local imports - formatter implementations
import { getWorkspaceState } from '@agent/core/stateStore';
import { WorkspaceStateKey } from '@common/state';

// Local file imports
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = getWorkspaceState().get<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
    'latexindent',
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
