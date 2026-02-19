/** Extension ID for the LaTeX Workshop VS Code extension. */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

/** Supported platform keys for install guides. */
export type Platform = 'darwin' | 'win32' | 'linux';

/**
 * Per-tool, per-platform install instructions.
 *
 * These are the single source of truth consumed by both:
 *   - `toolUtils.ts` TOOL_CONFIGS (runtime error messages)
 *   - `LaTeXTab.ts` dependency cards (settings UI)
 */
export const PDFLATEX_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install MacTeX (recommended):\n' +
    '  brew install --cask mactex\n\n' +
    'Or lightweight alternative:\n' +
    '  brew install texlive\n\n' +
    'After installing, restart VS Code so TeXRA can detect\n' +
    'the new binaries on your PATH.',
  linux:
    'Install TeX Live:\n' +
    '  sudo apt-get install texlive-full\n\n' +
    'After installing, restart VS Code so TeXRA can detect\n' +
    'the new binaries on your PATH.',
  win32:
    'Install MiKTeX:\n' +
    '  https://miktex.org/download\n\n' +
    'Or TeX Live:\n' +
    '  https://tug.org/texlive/\n\n' +
    'After installing, restart VS Code so TeXRA can detect\n' +
    'the new binaries on your PATH.',
};

export const LATEXDIFF_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install latexdiff:\n' +
    '  brew install latexdiff\n\n' +
    'Also included with MacTeX (texlive-extra-utils).',
  linux:
    'Install latexdiff:\n' +
    '  sudo apt-get install latexdiff\n\n' +
    'Part of most TeX Live distributions (texlive-extra-utils).',
  win32:
    'MiKTeX: Open MiKTeX Console → Packages → search "latexdiff" → Install\n\n' +
    'TeX Live: tlmgr install latexdiff\n\n' +
    'Part of most TeX Live distributions (texlive-extra-utils).',
};

export const LATEXINDENT_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install latexindent:\n' +
    '  brew install latexindent\n\n' +
    'Also included with MacTeX. Requires Perl (pre-installed on macOS).',
  linux:
    'Install latexindent:\n' +
    '  sudo apt-get install texlive-extra-utils\n\n' +
    'Requires Perl:\n' +
    '  sudo apt-get install perl',
  win32:
    'MiKTeX: Open MiKTeX Console → Packages → search "latexindent" → Install\n\n' +
    'TeX Live: tlmgr install latexindent\n\n' +
    'Also requires Perl (Strawberry Perl recommended):\n' +
    '  https://strawberryperl.com/',
};

export const TEXCOUNT_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install TeXcount:\n' +
    '  brew install texcount\n\n' +
    'Also included with MacTeX and most TeX Live distributions.',
  linux:
    'Install TeXcount:\n' +
    '  sudo apt-get install texlive-extra-utils\n\n' +
    'Part of most TeX Live distributions.',
  win32:
    'MiKTeX: Open MiKTeX Console → Packages → search "texcount" → Install\n\n' +
    'TeX Live: tlmgr install texcount\n\n' +
    'Part of most TeX Live distributions.',
};

export const IMAGE_PROCESSING_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Ghostscript:\n' +
    '  brew install ghostscript\n\n' +
    'GraphicsMagick (recommended):\n' +
    '  brew install graphicsmagick\n\n' +
    'Or ImageMagick:\n' +
    '  brew install imagemagick',
  linux:
    'Ghostscript:\n' +
    '  sudo apt-get install ghostscript\n\n' +
    'GraphicsMagick (recommended):\n' +
    '  sudo apt-get install graphicsmagick\n\n' +
    'Or ImageMagick:\n' +
    '  sudo apt-get install imagemagick',
  win32:
    'Ghostscript:\n' +
    '  https://ghostscript.com/releases/gsdnld.html\n\n' +
    'GraphicsMagick (recommended):\n' +
    '  http://www.graphicsmagick.org/download.html\n\n' +
    'Or ImageMagick:\n' +
    '  https://imagemagick.org/script/download.php',
};

/**
 * Normalize a raw platform string to one of the three supported values.
 * Falls back to 'linux' for unrecognized platforms (e.g. 'freebsd').
 */
export function normalizePlatform(raw: string): Platform {
  return raw === 'darwin' || raw === 'win32' ? raw : 'linux';
}

/**
 * Select the install guide for the given platform.
 * Falls back to linux if the platform is unrecognized.
 */
export function getInstallGuide(
  guide: Record<Platform, string>,
  platform: string,
): string {
  return guide[normalizePlatform(platform)] ?? guide.linux;
}
