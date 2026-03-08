// Local imports - formatter implementations
import { readConfig } from '@utils/configBridge';

// Local file imports
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = readConfig<string>('texra.latex.formatter', 'latexindent');

  switch (formatter) {
    case 'none':
      return true;
    case 'tex-fmt':
      return runTexFmt(filePath);
    default:
      return runLatexIndent(filePath);
  }
}
