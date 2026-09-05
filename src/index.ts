#!/usr/bin/env node

import {AppContext} from './app/context.js';
import {errorMessage} from './errors.js';
import {startMcpServer} from './mcp/server.js';

const context = new AppContext();

async function main(): Promise<void> {
  await startMcpServer(context);
}

function shutdown(): void {
  context.close();
}

process.once('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.once('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

main().catch((error: unknown) => {
  console.error(`VGCHelper MCP server failed: ${errorMessage(error)}`);
  shutdown();
  process.exit(1);
});
