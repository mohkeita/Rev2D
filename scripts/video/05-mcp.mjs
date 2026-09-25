/**
 * Step 5 - MCP: a real stdio MCP client talks to `node bin/rev2d.js mcp`.
 *
 *   node scripts/video/05-mcp.mjs
 *
 * 1. tools/list -> tool names + the first sentence of each description
 * 2. tools/call rev2d_render on examples/hana (AngleX=-20, MouthOpen=0.5) -> the PNG it returns
 *    inline + its text summary
 * 3. the registration command for Claude Code (as documented in docs/MCP.md), with this checkout's
 *    path in a neutral form
 *
 * Output: out/video/assets/mcp/{tools.json, tools.txt, render-hana.png, render-hana.txt,
 * register.txt, session.json}.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ASSETS, BIN, ROOT, bytesOf, ensureDir, log, pngSize, rel, sandboxEnv, updateManifest } from './lib.mjs';

const dir = ensureDir(path.join(ASSETS, 'mcp'));
/** First sentence: up to the first . ! ? that ends a sentence (not "e.g." / "incl." / "i.e." / "etc."). */
const firstSentence = (s) => {
  const text = s.trim().replace(/\s+/g, ' ');
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index + 1);
    if (/(^|[^\w])(e\.g|i\.e|incl|etc|vs)\.$/i.test(before)) continue;
    return before;
  }
  return text;
};
/** A caption-length version (first clause, at most ~100 characters). */
const short = (s) => {
  const clause = s.split(/: /)[0];
  const c = clause.length < s.length ? `${clause}…` : s;
  return c.length > 100 ? `${c.slice(0, 99).replace(/\s+\S*$/, '')}…` : c;
};

const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: ROOT, env: sandboxEnv(), stderr: 'pipe' });
let serverStderr = '';
transport.stderr?.on('data', (d) => (serverStderr += d));
const client = new Client({ name: 'rev2d-video-capture', version: '1.0.0' });
const t0 = new Date();
await client.connect(transport);
const serverInfo = client.getServerVersion();
log('connected to', JSON.stringify(serverInfo));

const listed = await client.listTools();
const tools = listed.tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? null, summary: firstSentence(t.description ?? ''), short: short(firstSentence(t.description ?? '')) }));
writeFileSync(path.join(dir, 'tools.json'), JSON.stringify({ server: serverInfo, count: tools.length, tools, raw: listed }, null, 2));
const toolsTxt = [`${tools.length} tools from "node bin/rev2d.js mcp" (tools/list):`, ...tools.map((t) => `  ${t.name.padEnd(22)} ${t.summary}`)].join('\n') + '\n';
writeFileSync(path.join(dir, 'tools.txt'), toolsTxt);
log(`${tools.length} tools`);

const renderTool = listed.tools.find((t) => t.name === 'rev2d_render');
const callArgs = { path: 'examples/hana/hana.r2d.json', params: { AngleX: -20, MouthOpen: 0.5 } };
const tCall = new Date();
const res = await client.callTool({ name: 'rev2d_render', arguments: callArgs });
const tDone = new Date();
const texts = res.content.filter((c) => c.type === 'text').map((c) => c.text);
const images = res.content.filter((c) => c.type === 'image');
if (res.isError || !images.length) throw new Error(`rev2d_render failed: ${texts.join('\n')}`);
const png = path.join(dir, 'render-hana.png');
writeFileSync(png, Buffer.from(images[0].data, 'base64'));
writeFileSync(path.join(dir, 'render-hana.txt'), texts.join('\n') + '\n');
log('render:', texts[0].split('\n')[0]);
await client.close();

const register = [
  '# Register the Rev2D MCP server with Claude Code (docs/MCP.md):',
  'claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp',
  '# add --scope project to write .mcp.json for everyone on the project; check with: claude mcp list',
  '# any other MCP client: command "node", args ["/absolute/path/to/Rev2D/bin/rev2d.js", "mcp"] (stdio)',
  '',
].join('\n');
writeFileSync(path.join(dir, 'register.txt'), register);

const session = {
  transport: 'stdio',
  command: 'node bin/rev2d.js mcp',
  cwd: '.',
  client: '@modelcontextprotocol/sdk Client + StdioClientTransport',
  server: serverInfo,
  startedAt: t0.toISOString(),
  requests: [
    { method: 'tools/list', result: `${tools.length} tools` },
    { method: 'tools/call', name: 'rev2d_render', arguments: callArgs, startedAt: tCall.toISOString(), endedAt: tDone.toISOString(), isError: !!res.isError, content: res.content.map((c) => (c.type === 'image' ? { type: 'image', mimeType: c.mimeType, bytes: Buffer.from(c.data, 'base64').length, savedAs: rel(png) } : c)) },
  ],
  renderInputSchema: renderTool?.inputSchema ?? null,
  serverStderr,
};
writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));

updateManifest('05-mcp', [
  { id: 'mcp/tools', kind: 'mcp-output', path: rel(path.join(dir, 'tools.txt')), bytes: bytesOf(path.join(dir, 'tools.txt')), count: tools.length, tools: tools.map((t) => t.name), note: 'tools/list over stdio: names + first sentence (full list incl. schemas in tools.json)' },
  { id: 'mcp/tools-json', kind: 'mcp-output', path: rel(path.join(dir, 'tools.json')), bytes: bytesOf(path.join(dir, 'tools.json')) },
  { id: 'mcp/render-hana', kind: 'image', path: rel(png), bytes: bytesOf(png), ...pngSize(png), request: { tool: 'rev2d_render', arguments: callArgs }, text: texts.join('\n'), startedAt: tCall.toISOString(), endedAt: tDone.toISOString(), note: 'PNG returned inline by the MCP tool (base64 image content), saved verbatim' },
  { id: 'mcp/render-hana-text', kind: 'mcp-output', path: rel(path.join(dir, 'render-hana.txt')), bytes: bytesOf(path.join(dir, 'render-hana.txt')) },
  { id: 'mcp/register', kind: 'text', path: rel(path.join(dir, 'register.txt')), bytes: bytesOf(path.join(dir, 'register.txt')), command: 'claude mcp add rev2d -- node /absolute/path/to/Rev2D/bin/rev2d.js mcp', note: 'registration command as documented in docs/MCP.md / CLAUDE.md' },
  { id: 'mcp/session', kind: 'mcp-log', path: rel(path.join(dir, 'session.json')), bytes: bytesOf(path.join(dir, 'session.json')) },
]);
log('done');
console.log(toolsTxt);
console.log(texts.join('\n'));
