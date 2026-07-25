import WebSocket from 'ws';
const PORT = 4613;
const url = 'ws://localhost:' + PORT;
process.env.PORT = PORT;
await import('./server.js');
await new Promise(r => setTimeout(r, 200));

const send = (ws, o) => ws.send(JSON.stringify(o));
const recv = (ws, ms = 2500) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('recv timeout ' + ms)), ms);
  ws.once('message', d => { clearTimeout(t); res(JSON.parse(d.toString())); });
});
const drain = async (ws, ms) => {
  const out = [];
  const h = (d) => out.push(JSON.parse(d.toString()));
  ws.on('message', h);
  await new Promise(r => setTimeout(r, ms));
  ws.off('message', h);
  return out;
};

try {
  // Host creates a room and gets a reconnectKey.
  const host = new WebSocket(url);
  await new Promise(r => host.on('open', r));
  send(host, { t: 'create', name: 'Alice', mode: 'classic', rounds: 3 });
  const joined = await recv(host);
  const key = joined.reconnectKey;
  const code = joined.code;
  console.log('host joined, has reconnectKey:', !!key);

  // Start the game.
  send(host, { t: 'start' });
  await recv(host); // round message
  console.log('host got round 1');

  // Host makes a guess (so they have a score this round).
  send(host, { t: 'guess', x: 100, z: 200 });
  await drain(host, 200);

  // Host disconnects "accidentally".
  host.close();
  await new Promise(r => setTimeout(r, 300));
  console.log('host dropped mid-round');

  // Reconnect using the saved key. Attach the drain BEFORE sending so we
  // capture every message the server sends in response (joined, lobby, round).
  const host2 = new WebSocket(url);
  await new Promise(r => host2.on('open', r));
  const after = [];
  const h = (d) => after.push(JSON.parse(d.toString()));
  host2.on('message', h);
  send(host2, { t: 'reconnect', code, reconnectKey: key });
  await new Promise(r => setTimeout(r, 500));
  host2.off('message', h);
  const rejoined = after.find(m => m.t === 'joined');
  const round = after.find(m => m.t === 'round');
  const result = after.find(m => m.t === 'roundresult');
  console.log('reconnected: t=', rejoined && rejoined.t, 'reconnected=', rejoined && rejoined.reconnected,
    'same clientId=', rejoined && rejoined.clientId === joined.clientId);
  console.log('messages after reconnect:', after.map(m => m.t).join(', '));
  // Host had already guessed + dropped -> round revealed -> roundover. Reconnect
  // should replay the roundresult (not 'round'), with their score preserved.
  const me = result && result.results && result.results.find(r => r.clientId === joined.clientId);
  console.log('got roundresult replay:', !!result, 'my score:', me && me.score, 'my guess preserved:', !!me?.guess);

  host2.close();
  console.log('RECONNECT SMOKE OK');
} catch (e) {
  console.error('RECONNECT SMOKE FAIL:', e.message);
}
setTimeout(() => process.exit(0), 300);
