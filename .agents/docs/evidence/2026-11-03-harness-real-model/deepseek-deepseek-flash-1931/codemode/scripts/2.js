const found = await searchTools("latex", { limit: 10 });
const files = await tools.executions({ path: "/executions", limit: 1 }).catch(e => String(e));
return { found, files };
