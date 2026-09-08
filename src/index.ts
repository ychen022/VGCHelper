#!/usr/bin/env node

import {AppContext} from './app/context.js';
import {errorMessage} from './errors.js';
import {startMcpServer} from './mcp/server.js';

const databasePath=process.env['VGC_HELPER_DATABASE'];
const context = new AppContext(databasePath?{databasePath}:{});
let server:Awaited<ReturnType<typeof startMcpServer>>|undefined;
let stopping=false;

async function main(): Promise<void> {
  server=await startMcpServer(context,shutdown);
  if(stopping) await server.close();
}

function shutdown(): void {
  if(stopping) return;
  stopping=true;
  context.close();
  void server?.close().catch((error:unknown)=>{
    console.error(`VGCHelper MCP transport close failed: ${errorMessage(error)}`);
    process.exitCode=1;
  });
}

process.stdin.once('end',shutdown);
process.stdin.once('close',shutdown);
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
