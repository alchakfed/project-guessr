import WebSocket from 'ws';
const PORT = 4615;
const url = 'ws://localhost:' + PORT;
process.env.PORT = PORT;
await import('./server.js');
await new Promise(r => setTimeout(r, 200));

const send = (ws, o) => ws.send(JSON.stringify(o));
const recv = (ws, ms = 2500) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  ws.once('message', d => { clearTimeout(t); res(JSON.parse(d.toString())); });
});
const capture = async (ws, ms) => {
  const out = [];
  const h = (d) => out.push(JSON.parse(d.toString()));
  ws.on('message', h);
  await new Promise(r => setTimeout(r, ms));
  ws.off('message', h);
  return out;
};
const drop = (ws) => { ws.close(); return new Promise(r => setTimeout(r, 250)); };

try {
  // ---- Scenario A: reconnect while in LOBBY ----
  const a = new WebSocket(url); await new Promise(r => a.on('open', r));
  send(a, { t: 'create', name: 'Al', mode: 'classic', rounds: 2 });
  const ja = await recv(a);
  await drop(a);
  const a2 = new WebSocket(url); await new Promise(r => a2.on('open', r));
  const aMsgs = await (async () => {
    const out = []; const h = (d) => out.push(JSON.parse(d.toString()));
    a2.on('message', h);
    send(a2, { t: 'reconnect', code: ja.code, reconnectKey: ja.reconnectKey });
    await new Promise(r => setTimeout(r, 400));
    a2.off('message', h);
    return out;
  })();
  const aJoined = aMsgs.find(m => m.t === 'joined');
  console.log('A lobby: roomState=', aJoined.roomState, 'types=', aMsgs.map(m => m.t).join(','));
  a2.close();

  // ---- Scenario B: reconnect while PLAYING (no guess) ----
  const b = new WebSocket(url); await new Promise(r => b.on('open', r));
  send(b, { t: 'create', name: 'Bo', mode: 'classic', rounds: 2, roundTime: 0 });
  const jb = await recv(b);
  send(b, { t: 'start' }); await recv(b); // round 1
  await drop(b);
  const b2 = new WebSocket(url); await new Promise(r => b2.on('open', r));
  const bMsgs = await (async () => {
    const out = []; const h = (d) => out.push(JSON.parse(d.toString()));
    b2.on('message', h);
    send(b2, { t: 'reconnect', code: jb.code, reconnectKey: jb.reconnectKey });
    await new Promise(r => setTimeout(r, 400));
    b2.off('message', h);
    return out;
  })();
  const bJoined = bMsgs.find(m => m.t === 'joined');
  console.log('B playing: roomState=', bJoined.roomState, 'types=', bMsgs.map(m => m.t).join(','));
  b2.close();

  // ---- Scenario C: reconnect while ROUNDOVER (guessed then dropped) ----
  const c = new WebSocket(url); await new Promise(r => c.on('open', r));
  send(c, { t: 'create', name: 'Cy', mode: 'classic', rounds: 2, roundTime: 0 });
  const jc = await recv(c);
  send(c, { t: 'start' }); await recv(c);
  send(c, { t: 'guess', x: 5, z: 5 });
  await capture(c, 300); // wait for roundresult
  await drop(c);
  const c2 = new WebSocket(url); await new Promise(r => c2.on('open', r));
  const cMsgs = await (async () => {
    const out = []; const h = (d) => out.push(JSON.parse(d.toString()));
    c2.on('message', h);
    send(c2, { t: 'reconnect', code: jc.code, reconnectKey: jc.reconnectKey });
    await new Promise(r => setTimeout(r, 400));
    c2.off('message', h);
    return out;
  })();
  const cJoined = cMsgs.find(m => m.t === 'joined');
  console.log('C roundover: roomState=', cJoined.roomState, 'types=', cMsgs.map(m => m.t).join(','));
  c2.close();

  console.log('RECONNECT-STATES SMOKE OK');
} catch (e) {
  console.error('FAIL:', e.message);
}
setTimeout(() => process.exit(0), 300);
