// Local imports - formatter implementations
import { getConfig } from '@utils/config';

// Local file imports
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = getConfig<string>('texra.latex.formatter', 'latexindent');
  if (formatter === 'none') {
    return true;
  }
  if (formatter === 'tex-fmt') {
    return runTexFmt(filePath);
  }
  return runLatexIndent(filePath);
}
