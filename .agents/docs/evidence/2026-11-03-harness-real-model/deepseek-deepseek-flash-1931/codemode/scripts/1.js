const mem = await tools.memory({ command: "view", path: "/memories" });
const ls = await tools.script ? null : null;
return mem;
