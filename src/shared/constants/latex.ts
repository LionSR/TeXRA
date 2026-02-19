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

export const PERL_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Perl is pre-installed on macOS.\n' +
    'If missing, reinstall via:\n' +
    '  brew install perl',
  linux:
    'Install Perl:\n' +
    '  sudo apt-get install perl',
  win32:
    'Install Strawberry Perl (recommended):\n' +
    '  https://strawberryperl.com/',
};

export const GHOSTSCRIPT_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install Ghostscript:\n' +
    '  brew install ghostscript',
  linux:
    'Install Ghostscript:\n' +
    '  sudo apt-get install ghostscript',
  win32:
    'Install Ghostscript:\n' +
    '  https://ghostscript.com/releases/gsdnld.html',
};

export const GRAPHICSMAGICK_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install GraphicsMagick:\n' +
    '  brew install graphicsmagick',
  linux:
    'Install GraphicsMagick:\n' +
    '  sudo apt-get install graphicsmagick',
  win32:
    'Install GraphicsMagick:\n' +
    '  http://www.graphicsmagick.org/download.html',
};

export const IMAGEMAGICK_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install ImageMagick:\n' +
    '  brew install imagemagick',
  linux:
    'Install ImageMagick:\n' +
    '  sudo apt-get install imagemagick',
  win32:
    'Install ImageMagick:\n' +
    '  https://imagemagick.org/script/download.php',
};

export const LATEXMK_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install latexmk:\n' +
    '  brew install latexmk\n\n' +
    'Also included with MacTeX.',
  linux:
    'Install latexmk:\n' +
    '  sudo apt-get install latexmk',
  win32:
    'MiKTeX: Open MiKTeX Console → Packages → search "latexmk" → Install\n\n' +
    'TeX Live: tlmgr install latexmk',
};

export const TEXFMT_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install tex-fmt:\n' +
    '  brew install tex-fmt\n\n' +
    'Or via Cargo:\n' +
    '  cargo install tex-fmt',
  linux:
    'Install tex-fmt:\n' +
    '  apt install tex-fmt\n\n' +
    'Or via Cargo:\n' +
    '  cargo install tex-fmt',
  win32:
    'Install tex-fmt via Cargo:\n' +
    '  cargo install tex-fmt',
};

export const WOLFRAM_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install Wolfram Engine:\n' +
    '  brew install --cask wolfram-engine\n\n' +
    'Or download from:\n' +
    '  https://www.wolfram.com/engine/',
  linux:
    'Install Wolfram Engine:\n' +
    '  https://www.wolfram.com/engine/\n\n' +
    'Follow the Linux installation guide on the Wolfram site.',
  win32:
    'Install Wolfram Engine:\n' +
    '  https://www.wolfram.com/engine/',
};

export const PANDOC_INSTALL_GUIDE: Record<Platform, string> = {
  darwin:
    'Install pandoc:\n' +
    '  brew install pandoc',
  linux:
    'Install pandoc:\n' +
    '  sudo apt-get install pandoc',
  win32:
    'Install pandoc:\n' +
    '  https://pandoc.org/installing.html',
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
