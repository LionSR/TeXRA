import { checkToolInstalled } from '@utils/system/toolUtils';

/** Returns true when a supported LaTeX-to-PDF compiler is available. */
export async function hasLatexCompiler(): Promise<boolean> {
  return (
    (await checkToolInstalled('latexmk', false)) ||
    (await checkToolInstalled('pdflatex', false))
  );
}
