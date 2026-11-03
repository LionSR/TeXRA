let mod = null, err = null;
try {
  mod = await import("builtIn:latex");
} catch (e) {
  err = String(e);
}
return { keys: mod ? Object.keys(mod) : null, err };
