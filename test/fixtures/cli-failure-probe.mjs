// Run inside the pinned worker image with --network none. No external provider is reachable.
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const status = Number(process.argv[2]);
assert.ok([200, 401, 429].includes(status));
let requests = 0;
const server = http.createServer((request, response) => {
  request.resume(); requests++;
  if (status === 200) {
    // Same synthetic SSE envelope as fake-provider.mjs, always asking for another read.
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const block = { type: 'tool_use', id: `toolu_${requests}`, name: 'Read', input: { file_path: '/bundle/probe.txt' } };
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('message_start', { message: { id: `msg_${requests}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { ...block, input: {} } });
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
    send('message_stop', {}); response.end(); return;
  }
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1',
    'anthropic-ratelimit-unified-reset': '2000000000' });
  response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'rate_limit_error', message: 'Synthetic failure.' } }));
});
await new Promise(resolve => server.listen(8080, '127.0.0.1', resolve));
const args = ['--print', '--restricted', '--safe-mode', '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '/worker/mcp.json',
  '--settings', '/worker/settings.json', '--no-session-persistence', '--model', 'claude-opus-5-5', '--output-format', 'json', '--max-turns', '1'];
const child = spawn('claude', args, { env: { PATH: process.env.PATH, HOME: '/tmp', CLAUDE_CONFIG_DIR: '/tmp/probe-claude',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-unused-oauth',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_UPDATES: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_MAX_RETRIES: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
const chunks = [];
child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume();
const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
child.stdin.end('Synthetic failure probe.');
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timer); await new Promise(resolve => server.close(resolve));
const stdout = Buffer.concat(chunks).toString();
assert.ok(!stdout.includes('synthetic-unused-oauth'));
assert.equal(code, 1);
const envelope = JSON.parse(stdout);
assert.equal(envelope.type, 'result'); assert.equal(envelope.is_error, true);
if (status === 200) assert.equal(envelope.subtype, 'error_max_turns');
else { assert.equal(envelope.terminal_reason, 'api_error'); assert.equal(envelope.api_error_status, status); }
process.stdout.write(JSON.stringify({ status, code, requests, subtype: envelope.subtype, is_error: envelope.is_error,
  terminal_reason: envelope.terminal_reason, api_error_status: envelope.api_error_status,
  modelNames: Object.keys(envelope.modelUsage ?? {}), hasStructured: envelope.structured_output !== undefined }) + '\n');
