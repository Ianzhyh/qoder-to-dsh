import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { disposeChatTransport, requestStream } from '../lib/chat-transport.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('requestStream streams SSE and reuses a keep-alive connection', async () => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 10);
      return;
    }
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', () => { connections += 1; });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await requestStream(`${base}/sse`, {
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /data: one/);
    assert.match(text, /data: two/);

    const second = await requestStream(`${base}/sse`, { body: '{}' });
    assert.match(await second.text(), /data: one/);
    assert.equal(connections, 1, 'keep-alive 应复用同一连接');

    const failed = await requestStream(`${base}/fail`, { body: '{}' });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /boom/);
  } finally {
    disposeChatTransport();
    await close(server);
  }
});

test('requestStream aborts a hanging request and releases the socket', async () => {
  const sockets = new Set();
  const server = http.createServer(() => { /* never respond */ });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const already = new AbortController();
    already.abort(new Error('already aborted'));
    await assert.rejects(
      () => requestStream(`${base}/hang`, { body: '{}', signal: already.signal }),
      /already aborted/,
    );

    const controller = new AbortController();
    const promise = requestStream(`${base}/hang`, { body: '{}', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop now')), 20);
    await assert.rejects(promise, /stop now/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.size, 0, '取消后连接应被销毁');
  } finally {
    disposeChatTransport();
    for (const socket of sockets) socket.destroy();
    await close(server);
  }
});
