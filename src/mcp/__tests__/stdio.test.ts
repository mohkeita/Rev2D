import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { blankModel } from '../../api/templates.js';
import { formatModelJson } from '../../core/format.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-stdio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('startMcpServer (stdio)', () => {
  it('serves tools over stdio and lets the process exit when the client disconnects', async () => {
    writeFileSync(path.join(dir, 'm.r2d.json'), formatModelJson(blankModel({ name: 'm', width: 64, height: 64 })));
    const serverModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.ts')).href;
    const entry = path.join(dir, 'entry.mjs');
    // No process.exit: the process must end on its own once the client closes stdin.
    writeFileSync(
      entry,
      `import { startMcpServer } from ${JSON.stringify(serverModule)};\n` +
        `process.on('exit', () => process.stderr.write('mcp server stopped\\n'));\n` +
        `await startMcpServer({ cwd: ${JSON.stringify(dir)} });\n` +
        `process.stderr.write('mcp server started\\n');\n`,
    );
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', entry], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    const client = new Client({ name: 'rev2d-stdio-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      await expect.poll(() => stderr, { timeout: 10_000 }).toMatch(/mcp server started/);
      expect(client.getServerVersion()?.name).toBe('rev2d');
      const r = (await client.callTool({ name: 'rev2d_validate', arguments: { path: 'm.r2d.json' } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect((r.content[0] as { text: string }).text).toMatch(/m\.r2d\.json: valid/);
    } finally {
      await client.close();
    }
    await expect.poll(() => stderr, { timeout: 10_000 }).toMatch(/mcp server stopped/);
  });
});
