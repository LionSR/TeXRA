const found = await searchTools("bash shell run command list files", { limit: 10 });
const m = await import("builtIn:latex");
return { found: found.map(f => f.name), outlineSrc: String(m.outline).slice(0, 400) };
