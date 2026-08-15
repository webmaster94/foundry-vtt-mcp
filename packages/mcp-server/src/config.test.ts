import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, config } from './config.js';

describe('server runtime identity', () => {
  it('matches the package version', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    expect(config.server.version).toBe(packageJson.version);
  });

  it('refuses a remotely bound listener without a nontrivial auth token', () => {
    const parsed = ConfigSchema.safeParse({
      foundry: { remoteMode: true, authToken: 'short' },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message)).toContain(
        'remoteMode requires an authToken of at least 16 characters'
      );
    }
  });
});
