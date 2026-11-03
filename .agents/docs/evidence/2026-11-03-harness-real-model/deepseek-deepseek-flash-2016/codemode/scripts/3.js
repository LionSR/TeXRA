const latex = await import("builtIn:latex");
const res = await latex.outline({ path: "draft.tex" });
return res;
