#!/usr/bin/env node
// Calls one tool on a running chatgpt-desktop-mcp server.
// Usage: CDM_URL=http://127.0.0.1:8723/mcp CDM_TOKEN=cdm_... node scripts/call-tool.mjs <tool|--list> ['{"json":"args"}']
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.CDM_URL ?? 'http://127.0.0.1:8723/mcp';
const token = process.env.CDM_TOKEN;
if (!token) {
  console.error('Set CDM_TOKEN to a token from: chatgpt-desktop-mcp token create');
  process.exit(1);
}
const [tool, rawArgs] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'call-tool', version: '0.1.0' });
await client.connect(transport);
if (!tool || tool === '--list') {
  const { tools } = await client.listTools();
  for (const entry of tools) console.log(`${entry.name}: ${entry.description}`);
} else {
  const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} }, undefined, { timeout: 330_000 });
  for (const part of result.content ?? []) console.log(part.type === 'text' ? part.text : JSON.stringify(part));
  if (result.isError) process.exitCode = 2;
}
await client.close();
