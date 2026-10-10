import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// server.js connects a real stdio transport at import time (top-level
// `await server.connect(transport)`), so it can't be imported directly in a
// unit test without a lot of unrelated mocking. Read its source instead --
// this is a regression check for the BADGR_BASE_URL default specifically,
// not a test of server.js's behavior.
const serverSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/server.js'),
  'utf-8',
);

describe('BADGR_BASE_URL default', () => {
  it('defaults to the real aibadgr.com endpoint, not the dead api.badgr.ai domain', () => {
    expect(serverSource).toContain("|| 'https://aibadgr.com/v1'");
    expect(serverSource).not.toContain('api.badgr.ai');
    expect(serverSource).not.toContain('api.aibadgr.com');
  });
});
