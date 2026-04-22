import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { hasMissingDependency, needsInstall } from '../../scripts/ensure-deps.mjs';

const repoNodeModules = path.join('/repo', 'node_modules');

describe('hasMissingDependency', () => {
  it('returns true when a dependency folder is missing', () => {
    const pathExists = vi.fn((targetPath: string) => targetPath !== path.join(repoNodeModules, 'jszip'));

    expect(hasMissingDependency({ jszip: '^3.10.1' }, repoNodeModules, pathExists)).toBe(true);
  });

  it('handles scoped package names', () => {
    const pathExists = vi.fn(() => true);

    expect(hasMissingDependency({ '@scope/pkg': '1.0.0' }, repoNodeModules, pathExists)).toBe(false);
    expect(pathExists).toHaveBeenCalledWith(path.join(repoNodeModules, '@scope/pkg'));
  });

  it('treats missing dependency metadata as no missing packages', () => {
    expect(hasMissingDependency(undefined, repoNodeModules, vi.fn())).toBe(false);
  });
});

describe('needsInstall', () => {
  it('returns true when node_modules is missing', () => {
    const pathExists = vi.fn((targetPath: string) => targetPath !== repoNodeModules);

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: repoNodeModules,
        lockPath: path.join('/repo', 'package-lock.json'),
        installedLock: path.join(repoNodeModules, '.package-lock.json'),
        pathExists,
      }),
    ).toBe(true);
  });

  it('returns true when lock metadata is missing', () => {
    const installedLock = path.join(repoNodeModules, '.package-lock.json');
    const pathExists = vi.fn((targetPath: string) => targetPath !== installedLock);

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: repoNodeModules,
        lockPath: path.join('/repo', 'package-lock.json'),
        installedLock,
        pathExists,
      }),
    ).toBe(true);
  });

  it('returns true when package-lock is newer than installed metadata', () => {
    const pathExists = vi.fn(() => true);
    const getStat = vi.fn((targetPath: string) => ({
      mtimeMs: targetPath === path.join('/repo', 'package-lock.json') ? 20 : 10,
    }));

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: repoNodeModules,
        lockPath: path.join('/repo', 'package-lock.json'),
        installedLock: path.join(repoNodeModules, '.package-lock.json'),
        pathExists,
        getStat,
      }),
    ).toBe(true);
  });

  it('returns false when dependencies are present and lock metadata is current', () => {
    const pathExists = vi.fn(() => true);
    const getStat = vi.fn(() => ({ mtimeMs: 10 }));

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1', '@scope/pkg': '1.0.0' },
        modulesPath: repoNodeModules,
        lockPath: path.join('/repo', 'package-lock.json'),
        installedLock: path.join(repoNodeModules, '.package-lock.json'),
        pathExists,
        getStat,
      }),
    ).toBe(false);
  });
});
