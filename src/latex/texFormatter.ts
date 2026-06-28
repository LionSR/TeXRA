// Local imports - formatter implementations
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

// Local file imports
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = readPlatformSetting<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
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
