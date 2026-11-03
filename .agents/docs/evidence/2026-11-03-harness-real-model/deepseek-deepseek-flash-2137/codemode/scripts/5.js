const latex = await import('builtIn:latex');
const out = await latex.outline('draft.tex');
return out;

