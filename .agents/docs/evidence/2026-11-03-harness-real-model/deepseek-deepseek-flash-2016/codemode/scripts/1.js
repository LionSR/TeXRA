const [ls, mod] = await Promise.all([
  tools.executions({ path: "/executions", limit: 5 }),
  Promise.resolve(null),
]);
const fs = await import("builtIn:latex");
console.log(Object.keys(fs));
return { ls: ls.rows ?? ls.output };
