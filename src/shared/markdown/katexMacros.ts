/**
 * KaTeX macros for LaTeX shortcuts in markdown rendered to HTML
 * (progress view, HTML chat export).
 * Based on patterns from src/replacement/maxRules.ts
 */

export const katexMacros = {
  // Calculus shortcuts
  '\\der': '\\partial',
  '\\na': '\\nabla',
  '\\dd': '\\mathrm{d}',

  // Arrow shortcuts
  '\\ra': '\\rightarrow',
  '\\lar': '\\leftarrow',
  '\\lra': '\\leftrightarrow',
  '\\Ra': '\\Rightarrow',
  '\\La': '\\Leftarrow',
  '\\LRa': '\\Leftrightarrow',

  // Common Greek letter shortcuts
  '\\al': '\\alpha',
  '\\bt': '\\beta',
  '\\ga': '\\gamma',
  '\\de': '\\delta',
  '\\eps': '\\epsilon',
  '\\ta': '\\theta',
  '\\la': '\\lambda',
  '\\sg': '\\sigma',
  '\\om': '\\omega',
  '\\Om': '\\Omega',
  '\\Ga': '\\Gamma',
  '\\De': '\\Delta',
  '\\Sig': '\\Sigma',
  '\\vphi': '\\varphi',
  '\\ze': '\\zeta',

  // Common math operators
  '\\ha': '\\frac{1}{2}',
  '\\Id': '\\mathds{1}',
  '\\ddt': '\\frac{\\partial}{\\partial t}',
  '\\ddx': '\\frac{\\partial}{\\partial x}',
  '\\nn': '\\nonumber',
  '\\da': '\\dagger',

  // Bold symbols
  '\\bzero': '\\boldsymbol{0}',
  '\\bone': '\\boldsymbol{1}',
  '\\bna': '\\boldsymbol{\\nabla}',
  '\\bSig': '\\boldsymbol{\\Sigma}',
  '\\bsg': '\\boldsymbol{\\sigma}',
  '\\bal': '\\boldsymbol{\\alpha}',
  '\\bbt': '\\boldsymbol{\\beta}',
  '\\bga': '\\boldsymbol{\\gamma}',
  '\\beps': '\\boldsymbol{\\epsilon}',
  '\\bze': '\\boldsymbol{\\zeta}',
  '\\bxi': '\\boldsymbol{\\xi}',
  '\\bet': '\\boldsymbol{\\eta}',
  '\\bmu': '\\boldsymbol{\\mu}',
  '\\bnu': '\\boldsymbol{\\nu}',
  '\\bom': '\\boldsymbol{\\omega}',
  '\\bphi': '\\boldsymbol{\\phi}',
  '\\bvphi': '\\boldsymbol{\\varphi}',
  '\\bpsi': '\\boldsymbol{\\psi}',
  '\\bchi': '\\boldsymbol{\\chi}',
  '\\bpi': '\\boldsymbol{\\pi}',
  '\\brho': '\\boldsymbol{\\rho}',
  '\\btau': '\\boldsymbol{\\tau}',
  '\\bla': '\\boldsymbol{\\lambda}',
  '\\bGa': '\\boldsymbol{\\Gamma}',
  '\\bLa': '\\boldsymbol{\\Lambda}',
  '\\bta': '\\boldsymbol{\\theta}',

  // Mathcal shortcuts
  '\\cH': '\\mathcal{H}',
  '\\cL': '\\mathcal{L}',
  '\\cO': '\\mathcal{O}',
  '\\cN': '\\mathcal{N}',
  '\\cP': '\\mathcal{P}',
  '\\cS': '\\mathcal{S}',
  '\\cF': '\\mathcal{F}',
  '\\cM': '\\mathcal{M}',
  '\\cT': '\\mathcal{T}',
  '\\cW': '\\mathcal{W}',

  // Mathbb shortcuts
  '\\eR': '\\mathbb{R}',
  '\\eC': '\\mathbb{C}',
  '\\eN': '\\mathbb{N}',
  '\\eZ': '\\mathbb{Z}',
  '\\eQ': '\\mathbb{Q}',
  '\\eE': '\\mathbb{E}',
  '\\eP': '\\mathbb{P}',

  // Mathbf shortcuts (lowercase vectors)
  '\\bx': '\\mathbf{x}',
  '\\by': '\\mathbf{y}',
  '\\bz': '\\mathbf{z}',
  '\\ba': '\\mathbf{a}',
  '\\bb': '\\mathbf{b}',
  '\\bc': '\\mathbf{c}',
  '\\bd': '\\mathbf{d}',
  // '\\be': '\\mathbf{e}',
  // '\\bf': '\\mathbf{f}',
  '\\bg': '\\mathbf{g}',
  '\\bh': '\\mathbf{h}',
  '\\bj': '\\mathbf{j}',
  '\\bn': '\\mathbf{n}',
  '\\bp': '\\mathbf{p}',
  '\\bq': '\\mathbf{q}',
  '\\br': '\\mathbf{r}',
  '\\bs': '\\mathbf{s}',
  '\\bv': '\\mathbf{v}',
  '\\bw': '\\mathbf{w}',
  '\\bu': '\\mathbf{u}',

  // Mathbf shortcuts (uppercase)
  '\\bA': '\\mathbf{A}',
  '\\bB': '\\mathbf{B}',
  '\\bC': '\\mathbf{C}',
  '\\bD': '\\mathbf{D}',
  '\\bE': '\\mathbf{E}',
  '\\bF': '\\mathbf{F}',
  '\\bG': '\\mathbf{G}',
  '\\bI': '\\mathbf{I}',
  '\\bJ': '\\mathbf{J}',
  '\\bK': '\\mathbf{K}',
  '\\bM': '\\mathbf{M}',
  '\\bQ': '\\mathbf{Q}',
  '\\bR': '\\mathbf{R}',
  '\\bU': '\\mathbf{U}',
  '\\bV': '\\mathbf{V}',
  '\\bW': '\\mathbf{W}',
  '\\bX': '\\mathbf{X}',
  '\\bY': '\\mathbf{Y}',
  '\\bZ': '\\mathbf{Z}',

  // Vector shortcuts
  '\\vx': '\\vec{x}',
  '\\vy': '\\vec{y}',
  '\\vz': '\\vec{z}',
  '\\vp': '\\vec{p}',
  '\\vq': '\\vec{q}',
  '\\vv': '\\vec{v}',

  // Tilde shortcuts
  '\\tx': '\\tilde{x}',
  '\\tz': '\\tilde{z}',
  '\\tB': '\\tilde{B}',
  '\\tF': '\\tilde{F}',
  '\\tga': '\\tilde{\\gamma}',
  '\\tphi': '\\tilde{\\phi}',
  '\\tpsi': '\\tilde{\\psi}',
  '\\tSig': '\\tilde{\\Sigma}',

  // Hat shortcuts
  '\\hH': '\\hat{H}',
  '\\hF': '\\hat{F}',
  '\\hP': '\\hat{P}',
  '\\hsg': '\\hat{\\sigma}',
  '\\hSig': '\\hat{\\Sigma}',
  '\\hrho': '\\hat{\\rho}',

  // Bar shortcuts
  '\\barH': '\\bar{H}',
  '\\barS': '\\bar{S}',
  '\\barrho': '\\bar{\\rho}',
  '\\baral': '\\bar{\\alpha}',
  '\\barbv': '\\bar{\\mathbf{v}}',

  // Special shortcuts
  '\\tauf': '\\tau_f',
  '\\tf': 't_f',
  '\\sha': '\\frac{1}{\\sqrt{2}}',
  '\\tzero': '\\tilde{0}',
  '\\tone': '\\tilde{1}',
  '\\tit': '\\tilde{t}',
  '\\tif': '\\tilde{f}',

  // Physics and thermodynamics
  '\\effH': 'H^{\\text{eff}}',
  '\\ceffH': '\\mathcal{H}^{\\text{eff}}',
  '\\peq': 'p^{\\text{eq}}',
  '\\qeq': 'q^{\\text{eq}}',
  '\\pst': 'p^{\\text{st}}',
  '\\qst': 'q^{\\text{st}}',
  '\\rhoeq': '\\rho^{\\text{eq}}',
  '\\rhost': '\\rho^{\\text{st}}',

  // Common subscripts
  '\\tot': '\\text{tot}',
  '\\sys': '\\text{sys}',
  '\\bath': '\\text{bath}',
  '\\const': '\\text{const}',
  '\\data': '\\text{data}',
  '\\model': '\\text{model}',
  '\\prior': '\\text{prior}',
  '\\target': '\\text{target}',
  '\\aux': '\\text{aux}',
  '\\eq': '\\text{eq}',
  '\\st': '\\text{st}',
  '\\exc': '\\text{exc}',
  '\\hkp': '\\text{hkp}',
  '\\nadi': '\\text{nadi}',
  '\\adi': '\\text{adi}',

  // Tilde
  '\\ttau': '\\tilde{\\tau}',
  '\\tp': '\\tilde{p}',
  '\\tv': '\\tilde{v}',
  '\\trho': '\\tilde{\\rho}',

  // More special symbols
  '\\bksl': '\\backslash',
  '\\nimplies': '\\not\\implies',
  '\\bdiv': '\\text{div}',
  '\\dddt': '\\frac{\\mathrm{d}}{\\mathrm{d} t}',

  // Tilde with bold
  '\\tbx': '\\tilde{\\mathbf{x}}',
  '\\tbz': '\\tilde{\\mathbf{z}}',
  '\\tbM': '\\tilde{\\mathbf{M}}',
  '\\tbze': '\\tilde{\\boldsymbol{\\zeta}}',
  '\\tbga': '\\tilde{\\boldsymbol{\\gamma}}',

  // Hat with bold
  '\\hbn': '\\hat{\\mathbf{n}}',
  '\\hbv': '\\hat{\\mathbf{v}}',
  '\\hbze': '\\hat{\\boldsymbol{\\zeta}}',

  // Special mathbf case
  '\\bbf': '\\mathbf{f}',

  // Tilde mathcal
  '\\tcH': '\\tilde{\\mathcal{H}}',
  '\\tcS': '\\tilde{\\mathcal{S}}',
  '\\tcW': '\\tilde{\\mathcal{W}}',

  // Common operators (that aren't built-in)
  '\\tr': '\\operatorname{tr}',
  '\\Tr': '\\operatorname{Tr}',
  '\\sign': '\\operatorname{sign}',
  '\\Cov': '\\operatorname{Cov}',
  '\\Unif': '\\operatorname{Unif}',
  '\\Bern': '\\operatorname{Bern}',
  '\\ReLU': '\\operatorname{ReLU}',
  '\\Concat': '\\operatorname{Concat}',
  '\\Skip': '\\operatorname{Skip}',
  '\\Upsample': '\\operatorname{Upsample}',
  '\\Softmax': '\\operatorname{Softmax}',
  '\\Conv': '\\operatorname{Conv}',
  '\\BatchNorm': '\\operatorname{BatchNorm}',
  '\\LayerNorm': '\\operatorname{LayerNorm}',
  '\\MaxPool': '\\operatorname{MaxPool}',
};
