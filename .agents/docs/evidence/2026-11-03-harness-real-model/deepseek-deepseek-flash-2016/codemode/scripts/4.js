const latex = await import("builtIn:latex");
let out;
try { out = await latex.outline("draft.tex"); }
catch (e) { out = { err: String(e) }; }
return out;
