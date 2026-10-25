/**
 * MCP server (stdio) exposing Rev2D to AI agents: validate, info, render (inline images), sheets,
 * inspect, analyze, hit-test, ops, Spine / Live2D import and export, schema/docs and the live editor bridge.
 * OWNER: mcp agent.
 *
 * stdout carries the protocol: nothing in this module (or the tools) may print to it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PACKAGE_ROOT } from '../api/templates.js';
import type { ToolContext } from './context.js';
import { registerDocResources, registerDocTools } from './tools/docs.js';
import { registerEditTools } from './tools/edit.js';
import { registerEditorTools } from './tools/editor.js';
import { registerInteropTools } from './tools/interop.js';
import { registerModelTools } from './tools/model.js';
import { registerLibraryTools } from './tools/library.js';
import { registerSceneTools } from './tools/scene.js';

export interface McpServerOptions {
  /** Base directory for relative model paths (default process.cwd()). */
  cwd?: string;
}

const INSTRUCTIONS = [
  'Rev2D: author, inspect and verify 2D rigged models (*.r2d.json, Live2D/Spine-like) as text.',
  'Call rev2d_guide first: it explains the format, the property address grammar and recipes.',
  'Coordinates: setup space = canvas px, origin top-left, +y down; angles in degrees, clockwise-positive.',
  'Verify every edit: rev2d_validate -> rev2d_render (look) -> rev2d_inspect (exact numbers) -> rev2d_sheet (motion) -> rev2d_analyze (animation problems: loop seam, IK reach, physics clamping).',
  'Animation layers take options: ["idle", "talk@0.8,add", "wink,once,start=2"]. Explicit params beat animation and physics.',
  'Edit with rev2d_apply_ops (atomic, validated). If the user has `rev2d edit <model>` open, the rev2d_editor_* tools show and drive what they see.',
  'Spine / Live2D: rev2d_import (Spine skeleton -> model; Live2D motions, physics -> a model) and rev2d_export (Spine JSON + atlas; Live2D motion3 / physics3 JSON).',
].join('\n');

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Build the configured server without connecting a transport (tests use InMemoryTransport). */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const ctx: ToolContext = { cwd: path.resolve(opts.cwd ?? process.cwd()) };
  const server = new McpServer({ name: 'rev2d', title: 'Rev2D', version: packageVersion() }, { instructions: INSTRUCTIONS });
  registerDocTools(server);
  registerModelTools(server, ctx);
  registerEditTools(server, ctx);
  registerInteropTools(server, ctx);
  registerEditorTools(server, ctx);
  registerLibraryTools(server, ctx);
  registerSceneTools(server, ctx);
  registerDocResources(server);
  return server;
}

/**
 * Start serving over stdio; resolves once connected. The server closes itself when stdin ends (the
 * client disconnected), which releases stdin so the process can exit; callers may also exit earlier
 * (e.g. on SIGINT).
 */
export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  // The SDK's stdio transport does not react to end-of-input by itself.
  const onEnd = () => void server.close();
  process.stdin.once('end', onEnd);
  transport.onclose = () => process.stdin.off('end', onEnd);
  await server.connect(transport);
}
