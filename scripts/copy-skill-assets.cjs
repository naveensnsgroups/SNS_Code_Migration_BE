// tsc only compiles .ts -> .js — it never copies non-TS files into dist/.
// Framework skill files (src/knowledge/framework-skills/<name>/skill.md, and
// any future bundled resources alongside them) are read from disk at runtime
// by registry.ts, relative to ITS OWN compiled location — so without this
// step, dist/ would have the compiled registry.js but none of the actual
// skill.md files, and resolveFrameworkSkill would silently return null for
// every framework in a production build even though it works fine in dev
// (tsx runs directly against src/, where the .md files are already present).
const fs   = require('fs-extra');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'src', 'knowledge', 'framework-skills');
const DEST = path.join(__dirname, '..', 'dist', 'knowledge', 'framework-skills');

fs.copySync(SRC, DEST, {
  filter: (src) => fs.statSync(src).isDirectory() || !src.endsWith('.ts'),
});

console.log(`[copy-skill-assets] Copied framework-skills resources to ${DEST}`);
