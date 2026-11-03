const list = await tools.executions({ path: "/executions", limit: 20 });
const cur = await tools.executions({ path: "/executions/current" });
return { list, cur };
