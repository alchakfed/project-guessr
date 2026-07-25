import WebSocket from 'ws';
const PORT = 4621;
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
  const out = []; const h = (d) => out.push(JSON.parse(d.toString()));
  ws.on('message', h); await new Promise(r => setTimeout(r, ms)); ws.off('message', h); return out;
};
let pass=0, fail=0;
const check = (c,l) => { if(c){pass++;console.log('PASS',l);}else{fail++;console.log('FAIL',l);} };

try {
  // Two players. P1 drops + reconnects. Then P2 guesses. We verify:
  //  (a) P1 (reconnected) receives P2's 'guessed' broadcast.
  //  (b) When P1 then guesses, the round reveals and P1 gets 'roundresult'.
  // The stale-close bug would make P1 receive NOTHING after reconnect.
  const p1 = new WebSocket(url);  await new Promise(r => p1.on('open', r));
  send(p1, { t: 'create', name: 'P1', mode: 'classic', rounds: 2, roundTime: 0 });
  const j1 = await recv(p1);
  const code = j1.code;
  const p2 = new WebSocket(url);
  await new Promise(r => p2.on('open', r));
  send(p2, { t: 'join', code, name: 'P2' });
  await recv(p2);
  send(p1, { t: 'start' });
  await capture(p1, 200);
  await capture(p2, 200); // both get round 1

  // P1 drops, then reconnects on a NEW socket (like a refresh + Reconnect click).
  p1.close();
  await new Promise(r => setTimeout(r, 250));
  const p1b = new WebSocket(url);
  await new Promise(r => p1b.on('open', r));
  send(p1b, { t: 'reconnect', code, reconnectKey: j1.reconnectKey });
  await recv(p1b); // joined
  await capture(p1b, 250); // round replay
  // Give any stale close from the old socket plenty of time to arrive AFTER the
  // new socket is live (the Render ordering that caused the desync).
  await new Promise(r => setTimeout(r, 400));

  // Now P2 guesses. P1b should receive the 'guessed' broadcast.
  const p1bAfter = [];
  const h1b = (d) => p1bAfter.push(JSON.parse(d.toString()));
  p1b.on('message', h1b);
  send(p2, { t: 'guess', x: 100, z: 100 });
  await new Promise(r => setTimeout(r, 400));
  p1b.off('message', h1b);
  check(!!p1bAfter.find(m => m.t === 'guessed'), 'P1(reconnected) received P2 guessed broadcast');

  // P1 guesses -> round should reveal, P1b gets roundresult.
  const p1bAfter2 = [];
  const h1b2 = (d) => p1bAfter2.push(JSON.parse(d.toString()));
  p1b.on('message', h1b2);
  send(p1b, { t: 'guess', x: 5, z: 5 });
  await new Promise(r => setTimeout(r, 400));
  p1b.off('message', h1b2);
  check(!!p1bAfter2.find(m => m.t === 'roundresult'), 'P1(reconnected) received roundresult after both guessed');

  p1b.close(); p2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) { console.error('ERR', e.message, e.stack); }
setTimeout(() => process.exit(0), 300);
