import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';

import {toErrorPayload} from '../errors.js';

export function toolResult(value: unknown): CallToolResult {
  const structuredContent = {result: value};
  return {
    content: [{type: 'text', text: JSON.stringify(structuredContent, null, 2)}],
    structuredContent,
  };
}

export function toolError(error: unknown): CallToolResult {
  const structuredContent = {result: toErrorPayload(error)};
  return {
    content: [{type: 'text', text: JSON.stringify(structuredContent, null, 2)}],
    structuredContent,
    isError: true,
  };
}

export async function executeTool(
  operation: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}
