import WebSocket from 'ws';
const PORT = 4617;
const url = 'ws://localhost:' + PORT;
process.env.PORT = PORT;
await import('./server.js');
await new Promise(r => setTimeout(r, 200));

const send = (ws, o) => ws.send(JSON.stringify(o));
const recv = (ws, ms = 2500) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  ws.once('message', d => { clearTimeout(t); res(JSON.parse(d.toString())); });
});
const drop = (ws) => { ws.close(); return new Promise(r => setTimeout(r, 250)); };

try {
  // Two players, 60s round, no guess yet. Capture the original deadline, then
  // have one drop+reconnect and confirm the reconnect deadline matches (not a
  // fresh 60s).
  const host = new WebSocket(url); await new Promise(r => host.on('open', r));
  send(host, { t: 'create', name: 'Host', mode: 'classic', rounds: 2, roundTime: 60 });
  const jh = await recv(host);
  const code = jh.code;

  const guest = new WebSocket(url); await new Promise(r => guest.on('open', r));
  send(guest, { t: 'join', code, name: 'Guest' });
  await recv(guest);

  send(host, { t: 'start' });
  // Attach listener BEFORE relying on recv ordering.
  const startMsgs = [];
  const sh = (d) => startMsgs.push(JSON.parse(d.toString()));
  host.on('message', sh);
  await new Promise(r => setTimeout(r, 300));
  host.off('message', sh);
  const roundMsg = startMsgs.find(m => m.t === 'round');
  const origDeadline = roundMsg.deadline;
  console.log('original deadline:', origDeadline, 'now:', Date.now(),
    '->', Math.round((origDeadline - Date.now()) / 1000), 's left');

  // Host guesses (so they have a recorded guess to restore on reconnect).
  send(host, { t: 'guess', x: 42, z: 17 });
  await new Promise(r => setTimeout(r, 150));

  // Host drops + reconnects.
  await drop(host);
  const host2 = new WebSocket(url); await new Promise(r => host2.on('open', r));
  const msgs = [];
  const h = (d) => msgs.push(JSON.parse(d.toString()));
  host2.on('message', h);
  send(host2, { t: 'reconnect', code, reconnectKey: jh.reconnectKey });
  await new Promise(r => setTimeout(r, 500));
  host2.off('message', h);

  const round2 = msgs.find(m => m.t === 'round');
  console.log('reconnect deadline:', round2 && round2.deadline,
    '->', round2 && Math.round((round2.deadline - Date.now()) / 1000), 's left');
  console.log('deadline preserved (not reset):',
    round2 && round2.deadline === origDeadline ? 'PASS' : 'FAIL');
  console.log('myGuess restored:', JSON.stringify(round2 && round2.myGuess));
  console.log('myGuess correct:', round2 && round2.myGuess &&
    round2.myGuess.x === 42 && round2.myGuess.z === 17 ? 'PASS' : 'FAIL');

  host2.close(); guest.close();
  console.log('DESYNC SMOKE OK');
} catch (e) {
  console.error('FAIL:', e.message, e.stack);
}
setTimeout(() => process.exit(0), 300);
