import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initLibrary } from '../src/node/library.js';
import { main } from '../src/cli/main.js';
import { encodePNG } from '../src/render/png.js';
import { hanaIllustration } from './fixtures/avatar-hana.js';

it('runs all eleven library/avatar MCP tools with real files, images and a built avatar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-library-mcp-')),
    server = createMcpServer({ cwd: dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  try {
    await initLibrary(path.join(dir, 'library'));
    const { image, doc } = hanaIllustration(0.25);
    await writeFile(path.join(dir, 'hana.png'), encodePNG(image));
    const names = [
      'library_search',
      'library_validate',
      'library_import',
      'library_request',
      'library_sheet',
      'avatar_new',
      'avatar_validate',
      'avatar_grid',
      'avatar_overlay',
      'avatar_build',
      'avatar_poses',
    ].map((n) => 'rev2d_' + n);
    const discovery = await client.listTools();
    for (const name of names) {
      const tool = discovery.tools.find((t) => t.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.description!.length).toBeLessThan(2048);
      expect(tool.description!.length).toBeGreaterThan(80);
    }
    expect((await call('rev2d_avatar_new', { path: 'hana.png', out: 'avatar', name: 'hana' })).isError).toBeFalsy();
    expect((await call('rev2d_avatar_validate', { path: 'avatar' })).isError).toBe(true);
    await writeFile(path.join(dir, 'avatar/avatar.json'), JSON.stringify(doc));
    expect((await call('rev2d_avatar_validate', { path: 'avatar' })).isError).toBeFalsy();
    for (const name of ['rev2d_avatar_grid', 'rev2d_avatar_overlay']) {
      const r = await call(name, { path: 'avatar' });
      expect(r.isError).toBeFalsy();
      expect(r.content.some((c) => c.type === 'image')).toBe(true);
    }
    expect((await call('rev2d_avatar_build', { path: 'avatar' })).isError).toBeFalsy();
    const poses = await call('rev2d_avatar_poses', { path: 'avatar', scale: 0.25 });
    expect(poses.isError).toBeFalsy();
    expect(poses.content.filter((c) => c.type === 'image')).toHaveLength(4);
    expect((await call('rev2d_library_validate', { path: 'library' })).isError).toBeFalsy();
    expect(
      (
        await call('rev2d_library_import', {
          path: 'library',
          image: 'hana.png',
          kind: 'character',
          character: 'hana',
          pose: 'standing',
          tags: ['standing'],
          trim: false,
        })
      ).isError,
    ).toBeFalsy();
    const found = await call('rev2d_library_search', { path: 'library', tags: ['standing'] });
    expect(JSON.stringify(found)).toContain('standing');
    expect((await call('rev2d_library_validate', { path: 'library' })).isError).toBe(true);
    expect(
      (
        await call('rev2d_library_request', {
          path: 'library',
          out: 'request',
          kind: 'character',
          character: 'hana',
          pose: 'sitting with phone',
        })
      ).isError,
    ).toBeFalsy();
    expect(await readFile(path.join(dir, 'request/prompt.txt'), 'utf8')).toContain('#00FF00');
    const sheet = await call('rev2d_library_sheet', { path: 'library' });
    expect(sheet.isError).toBeFalsy();
    expect(sheet.content.some((c) => c.type === 'image')).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('exercises the library CLI JSON contract and exit codes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-library-cli-'));
  async function run(args: string[]) {
    let stdout = '',
      stderr = '';
    const code = await main(args, {
      cwd: dir,
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          stderr += s;
        },
      },
    });
    return { code, stdout, stderr };
  }
  try {
    expect((await run(['library', 'init', 'lib', '--json'])).code).toBe(0);
    expect(JSON.parse((await run(['library', 'validate', 'lib', '--json'])).stdout)).toEqual({
      ok: true,
      diagnostics: [],
    });
    const fixture = hanaIllustration(0.25);
    await writeFile(path.join(dir, 'hana.png'), encodePNG(fixture.image));
    const imported = await run([
      'library',
      'import',
      'hana.png',
      '--into',
      'lib',
      '--kind',
      'character',
      '--character',
      'hana',
      '--pose',
      'standing',
      '--no-trim',
      '--tags',
      'standing',
      '--json',
    ]);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout).needsLandmarks).toBe(true);
    const invalid = await run(['library', 'validate', 'lib', '--json']);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).ok).toBe(false);
    expect(JSON.parse((await run(['library', 'search', 'lib', '--tags', 'standing', '--json'])).stdout)).toHaveLength(
      1,
    );
    expect(JSON.parse((await run(['library', 'list', 'lib', '--kind', 'characters', '--json'])).stdout)).toHaveLength(
      1,
    );
    expect(
      (
        await run([
          'library',
          'request',
          'lib',
          '--kind',
          'character',
          '--character',
          'hana',
          '--pose',
          'sitting',
          '-o',
          'request',
          '--json',
        ])
      ).code,
    ).toBe(0);
    expect((await run(['library', 'sheet', 'lib', '-o', 'sheet.png', '--json'])).code).toBe(0);
    expect((await run(['library', 'rig', 'lib', '--character', 'hana', '--pose', 'standing', '--json'])).code).toBe(1);
    expect((await run(['library', 'request', 'lib', '--kind', 'character', '--json'])).code).toBe(2);
    await writeFile(
      path.join(dir, 'lib/characters/hana/standing/avatar.json'),
      JSON.stringify({ ...fixture.doc, name: 'hana_standing' }),
    );
    expect((await run(['library', 'rig', 'lib', '--character', 'hana', '--pose', 'standing', '--json'])).code).toBe(0);
    expect((await run(['library', 'validate', 'lib', '--json'])).code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
