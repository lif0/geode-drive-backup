/**
 * Copies the version npm just wrote into package.json over to manifest.json,
 * and records it in versions.json against the minimum Obsidian version.
 * Obsidian uses versions.json to offer older clients the last release they can run.
 *
 * Run by the `version` npm lifecycle script: npm version patch
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const targetVersion = process.env['npm_package_version'];

if (typeof targetVersion !== 'string' || targetVersion.length === 0) {
  throw new Error('npm_package_version is unset. Run via `npm version <x.y.z>`, not directly.');
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const manifest = readJson('manifest.json');
manifest.version = targetVersion;
writeJson('manifest.json', manifest);

const versions = readJson('versions.json');
versions[targetVersion] = manifest.minAppVersion;
writeJson('versions.json', versions);

console.log(`Geode ${targetVersion} (requires Obsidian >= ${manifest.minAppVersion})`);
