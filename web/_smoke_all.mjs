import WebSocket from 'ws';
const PORT = 4619;
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
const drop = (ws) => { ws.close(); return new Promise(r => setTimeout(r, 250)); };

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log('PASS', label); } else { fail++; console.log('FAIL', label); } };

try {
  // Basic reconnect still works: drop without guessing -> round replay.
  const h = new WebSocket(url); await new Promise(r => h.on('open', r));
  send(h, { t: 'create', name: 'A', mode: 'classic', rounds: 2, roundTime: 0 });
  const j = await recv(h);
  send(h, { t: 'start' }); await recv(h);
  await drop(h);
  const h2 = new WebSocket(url); await new Promise(r => h2.on('open', r));
  const m = await (async () => { const o=[]; const hd=(d)=>o.push(JSON.parse(d.toString())); h2.on('message',hd);
    send(h2,{t:'reconnect',code:j.code,reconnectKey:j.reconnectKey}); await new Promise(r=>setTimeout(r,400)); h2.off('message',hd); return o; })();
  check(!!m.find(x=>x.t==='joined' && x.reconnected), 'reconnect joined');
  check(!!m.find(x=>x.t==='round'), 'round replayed (no guess)');
  h2.close();

  // Guess-then-drop: guess preserved + restored, round NOT auto-revealed.
  const g = new WebSocket(url); await new Promise(r => g.on('open', r));
  send(g, { t: 'create', name: 'B', mode: 'classic', rounds: 2, roundTime: 0 });
  const jg = await recv(g);
  // add a second player so allGuessed isn't trivially satisfied
  const p2 = new WebSocket(url); await new Promise(r => p2.on('open', r));
  send(p2, { t: 'join', code: jg.code, name: 'P2' }); await recv(p2);
  send(g, { t: 'start' }); await recv(g); await recv(p2); // round 1 to both
  send(g, { t: 'guess', x: 10, z: 20 });
  await capture(g, 150);
  await drop(g);
  // p2 should NOT have received a roundresult (round must not auto-reveal).
  const p2m = await capture(p2, 300);
  check(!p2m.find(x=>x.t==='roundresult'), 'round not auto-revealed on drop');
  const g2 = new WebSocket(url); await new Promise(r => g2.on('open', r));
  const gm = await (async () => { const o=[]; const hd=(d)=>o.push(JSON.parse(d.toString())); g2.on('message',hd);
    send(g2,{t:'reconnect',code:jg.code,reconnectKey:jg.reconnectKey}); await new Promise(r=>setTimeout(r,400)); g2.off('message',hd); return o; })();
  const gr = gm.find(x=>x.t==='round');
  check(gr && gr.myGuess && gr.myGuess.x===10 && gr.myGuess.z===20, 'guess restored on reconnect');
  g2.close(); p2.close();

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) { console.error('ERR', e.message); }
setTimeout(() => process.exit(0), 300);
