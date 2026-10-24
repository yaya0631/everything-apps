/**
 * Fails the build when a production dependency is not under a permissive
 * open-source license. Run by `npm run build` (and `npm run check:licenses`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0']);
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const seen = new Set();
const problems = [];
function visit(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const file = join(root, 'node_modules', name, 'package.json');
  if (!existsSync(file)) {
    problems.push(`${name}: not installed`);
    return;
  }
  const dep = JSON.parse(readFileSync(file, 'utf8'));
  const license = typeof dep.license === 'string' ? dep.license : dep.license?.type;
  if (!ALLOWED.has(license)) problems.push(`${name}@${dep.version}: ${license || 'no license'}`);
  for (const child of Object.keys(dep.dependencies || {})) visit(child);
}
for (const name of Object.keys(pkg.dependencies || {})) visit(name);

if (problems.length) {
  console.error('Dependencies with licenses outside the allowed list:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Licenses OK (${seen.size} production ${seen.size === 1 ? 'package' : 'packages'})`);
