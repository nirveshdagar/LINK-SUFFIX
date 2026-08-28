import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
const webRoot = new URL('../web/', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
const targetPort = 3199;
const controlPort = 3198;
const webPort = 3197;
const children = [];
const target = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>production smoke target</title>');
});

const stop = () => {
  for (const child of children) child.kill();
  target.close();
};

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* service is starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  target.listen(targetPort, '127.0.0.1');
  await once(target, 'listening');
  children.push(spawn(process.execPath, ['web/server/control.mjs'], {
    cwd: root,
    env: { ...process.env, WS_PORT: String(controlPort), CONTROL_HOST: '127.0.0.1', CONTROL_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`, TAH_ALLOWED_TARGETS: '127.0.0.1', TAH_NO_PROXY: '1' },
    stdio: 'inherit',
  }));
  children.push(spawn(process.execPath, ['../node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: webRoot, stdio: 'inherit' }));
  await Promise.all([waitFor(`http://127.0.0.1:${controlPort}/health`), waitFor(`http://127.0.0.1:${webPort}/control`)]);

  const socket = new WebSocket(`ws://127.0.0.1:${controlPort}`, ['tah-control'], { origin: `http://127.0.0.1:${webPort}` });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'create_run', payload: {
    scenarioId: 'production-smoke', tier: 'trivial-http', seedUrl: `http://127.0.0.1:${targetPort}/`, proxyMode: 'rotating-residential', expectedVerdict: 'allow', geo: { country: 'US' }, repeats: 1, concurrent: 1, authorized: true,
  } }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Production run did not complete')), 20_000);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.payload?.message)); }
      if (message.type === 'run_ended') { clearTimeout(timer); resolve(); }
    });
  });
  socket.close();
} finally {
  stop();
}
