#!/usr/bin/env node
const HealthCheck = require("../src/index.js");

const cwd = process.cwd();
const glob = process.argv.slice(2);

console.log(`Starting: cwd: '${cwd}'; glob: '${glob}'`);

const healthCheck = new HealthCheck(cwd, glob);

(async () => {
  await healthCheck.scan();

  // Now to output our results nicely
  for (const packName in healthCheck.results.packages) {
    const pack = healthCheck.results.packages[packName];
    const hasErrors = pack.errs.length > 0;
    console.group(`\x1b[1m${packName}\x1b[0m: ${pack.dir}`);
    // Basic Values
    console.table({
      has_duplicates: pack.hasDups,
      has_en_locale: pack.hasEnLocale,
      has_errors: hasErrors
    });
    if (hasErrors) {
      console.error(`\x1b[1mErrors\x1b[0m`);
      console.table(pack.errs);
    }
    console.log(`\x1b[1mKeyPaths Popularity in Package\x1b[0m`);
    console.table(pack.usedKeyPaths);
    console.groupEnd();
  }

  console.group("Pulsar Commons");
  console.table(healthCheck.results.commonsKeyMapsUsed);
  console.groupEnd();
})();
