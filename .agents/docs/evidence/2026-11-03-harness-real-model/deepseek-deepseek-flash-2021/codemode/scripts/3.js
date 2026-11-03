const latex = await import('builtIn:latex');
const out = await latex.outline({ path: 'draft.tex' });
return out;
