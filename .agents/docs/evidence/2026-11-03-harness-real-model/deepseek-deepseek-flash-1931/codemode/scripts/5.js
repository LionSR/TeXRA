const { outline } = await import("builtIn:latex");
let a = null, b = null;
try { a = await outline("draft.tex"); } catch (e) { a = String(e); }
return { a };
