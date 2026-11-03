const { outline } = await import("builtIn:latex");
const sections = await outline({ path: "draft.tex" });
return sections;
