import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.argv[2] ?? path.join(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh'));
const readPackage = async directory => JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));

try {
  const runtime = await readPackage(runtimeRoot);
  if (runtime.name !== '@deepseek-ai/dsh' || runtime.version !== '0.2.1-alpha.3')
    throw new Error('Expected @deepseek-ai/dsh 0.2.1-alpha.3. Pass its installed directory as the first argument.');
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const links = [];
  for (const [name, version] of [['@deepseek-ai/cordis', '4.0.5-alpha.2'], ['@deepseek-ai/dsh-tools', '0.2.1-alpha.3']]) {
    let directory = path.dirname(require.resolve(name));
    let metadata;
    while (true) {
      try { metadata = await readPackage(directory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata?.name === name) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate package root: ${name}`);
      directory = parent;
      metadata = undefined;
    }
    if (metadata.version !== version) throw new Error(`${name}: expected ${version}, got ${metadata.version}.`);
    const source = await fs.realpath(directory);
    const destination = path.join(pluginRoot, 'node_modules', name);
    let exists = false;
    try {
      await fs.lstat(destination);
      exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists && await fs.realpath(destination) !== source)
      throw new Error(`Existing package differs from Harness runtime: ${destination}. Review it before replacing it.`);
    links.push({ name, source, destination, exists });
  }
  // Validate both peers before creating either link; never overwrite installed packages.
  for (const { name, source, destination, exists } of links) {
    if (!exists) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.symlink(source, destination, 'dir');
    }
    console.log(`${name}: linked to Harness ${runtime.version}`);
  }
} catch (error) {
  console.error(`Runtime setup failed: ${error.message}`);
  console.error('Usage: npm run setup:runtime -- "$(npm root -g)/@deepseek-ai/dsh"');
  process.exitCode = 1;
}
