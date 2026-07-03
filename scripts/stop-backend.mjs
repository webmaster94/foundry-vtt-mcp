#!/usr/bin/env node
/**
 * Stop the persistent Foundry MCP backend daemon (npm run stop).
 * The next AI client session starts a fresh one automatically.
 */
import * as net from 'net';

const socket = net.createConnection({ host: '127.0.0.1', port: 31414 }, () => {
  socket.write(JSON.stringify({ id: 'stop', method: 'shutdown' }) + '\n');
});
socket.setEncoding('utf8');
socket.on('data', () => {
  console.log('Backend shutdown requested.');
  socket.destroy();
  process.exit(0);
});
socket.on('error', () => {
  console.log('No backend running (nothing to stop).');
  process.exit(0);
});
setTimeout(() => {
  console.log('No response from backend; it may already be stopping.');
  process.exit(0);
}, 3000);
