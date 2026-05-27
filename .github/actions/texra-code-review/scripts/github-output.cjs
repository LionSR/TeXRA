const crypto = require('node:crypto');
const fs = require('node:fs');

function writeOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const delimiter = `__texra_${name}_${crypto.randomBytes(16).toString('hex')}__`;
  fs.appendFileSync(
    outputPath,
    `${name}<<${delimiter}\n${value ?? ''}\n${delimiter}\n`,
  );
}

module.exports = {
  writeOutput,
};
