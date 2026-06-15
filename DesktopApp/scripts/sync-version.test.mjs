import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVersion } from './sync-version.mjs';

describe('syncVersion', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syncver-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2));
    writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'X', version: '0.0.0' }, null, 2));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.0"\nedition = "2021"\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('propagates package.json version into tauri.conf.json and Cargo.toml', () => {
    syncVersion({
      packageJson: join(dir, 'package.json'),
      tauriConf: join(dir, 'tauri.conf.json'),
      cargoToml: join(dir, 'Cargo.toml'),
    });
    expect(JSON.parse(readFileSync(join(dir, 'tauri.conf.json'), 'utf8')).version).toBe('1.2.3');
    expect(readFileSync(join(dir, 'Cargo.toml'), 'utf8')).toContain('version = "1.2.3"');
  });

  it('only rewrites the [package] version, not other version keys', () => {
    writeFileSync(join(dir, 'Cargo.toml'),
      '[package]\nname = "x"\nversion = "0.0.0"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n');
    syncVersion({
      packageJson: join(dir, 'package.json'),
      tauriConf: join(dir, 'tauri.conf.json'),
      cargoToml: join(dir, 'Cargo.toml'),
    });
    const cargo = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('version = "1.2.3"');
    expect(cargo).toContain('foo = { version = "9.9.9" }');
  });
});
