#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';
import { BackendControlClient } from './control-client.js';

async function startWrapper() {
  const backend = new BackendControlClient();

  // Pre-connect to backend BEFORE initializing MCP server
  // This ensures tools/list requests respond immediately without timeout
  try {
    await backend.ensure();
    try {
      backend.log('startWrapper(): pre-connected to backend');
    } catch {}
  } catch (e) {
    try {
      backend.log('startWrapper(): pre-connection failed, will retry on demand', {
        error: (e as any)?.message,
      });
    } catch {}
  }

  const mcp = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {} } }
  );

  // Setup cleanup handlers - cross-platform approach

  // When stdin closes (Claude Desktop exits), clean up the backend

  process.stdin.on('end', () => {
    backend.cleanup();

    process.exit(0);
  });

  // Also handle process termination signals

  process.on('SIGTERM', () => {
    backend.cleanup();

    process.exit(0);
  });

  process.on('SIGINT', () => {
    backend.cleanup();

    process.exit(0);
  });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const res = await backend.send('list_tools', {});

      try {
        backend.log('ListTools handler: received from backend', {
          hasTools: !!res.tools,
          toolCount: res.tools?.length || 0,
        });
      } catch {}

      return { tools: res.tools || [] };
    } catch (e) {
      // Log but return empty to remain MCP-compliant

      try {
        backend.log('ListTools failed; returning empty', { error: (e as any)?.message });
      } catch {}

      return { tools: [] };
    }
  });

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as any;

    try {
      const res = await backend.send('call_tool', { name, args: args ?? {} });

      return res;
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `Error: ${e?.message || 'Backend unavailable'}` }],
        isError: true,
      } as any;
    }
  });

  const transport = new StdioServerTransport();

  await mcp.connect(transport);
}

startWrapper().catch(err => {
  console.error('Wrapper failed:', err);

  process.exit(1);
});
