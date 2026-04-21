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

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

export function hasMissingDependency(dependencies = {}, modulesPath = nodeModulesPath, pathExists = existsSync) {
  return Object.keys(dependencies || {}).some((name) => !pathExists(path.join(modulesPath, name)));
}

export function needsInstall({
  dependencies = readPackageJson().dependencies,
  modulesPath = nodeModulesPath,
  lockPath = packageLockPath,
  installedLock = installedLockPath,
  pathExists = existsSync,
  getStat = statSync,
} = {}) {
  if (!pathExists(modulesPath)) return true;
  if (hasMissingDependency(dependencies, modulesPath, pathExists)) return true;
  if (!pathExists(lockPath) || !pathExists(installedLock)) return true;
  return getStat(lockPath).mtimeMs > getStat(installedLock).mtimeMs;
}

export function ensureDeps(runInstall = () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCommand, ['install'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
}) {
  if (!needsInstall()) {
    return 0;
  }

  console.log('[setup] Frontend dependencies changed. Running npm install...');
  const install = runInstall();
  return install.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(ensureDeps());
}
