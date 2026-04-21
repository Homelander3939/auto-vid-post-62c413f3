import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const nodeModulesPath = path.join(rootDir, 'node_modules');
const installedLockPath = path.join(nodeModulesPath, '.package-lock.json');

function hasMissingDependency() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const dependencyNames = Object.keys(packageJson.dependencies || {});
  return dependencyNames.some((name) => !existsSync(path.join(nodeModulesPath, name)));
}

function needsInstall() {
  if (!existsSync(nodeModulesPath)) return true;
  if (hasMissingDependency()) return true;
  if (!existsSync(packageLockPath) || !existsSync(installedLockPath)) return false;
  return statSync(packageLockPath).mtimeMs > statSync(installedLockPath).mtimeMs;
}

if (!needsInstall()) {
  process.exit(0);
}

console.log('[setup] Frontend dependencies changed. Running npm install...');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCommand, ['install'], {
  cwd: rootDir,
  stdio: 'inherit',
});

if (install.status !== 0) {
  process.exit(install.status ?? 1);
}
