const http = require('http');
const mailbox = {}, players = {}, online = {}, positions = {};

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};
const reply = (res, code, data) => { res.writeHead(code, H); res.end(JSON.stringify(data)); };
const body  = req => new Promise(ok => {
  let s=''; req.on('data',c=>s+=c); req.on('end',()=>{ try{ok(JSON.parse(s))}catch{ok({})} });
});

const server = http.createServer(async (req, res) => {
  if (req.method==='OPTIONS') { res.writeHead(204,H); return res.end(); }
  const url = new URL('http://x'+req.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method==='GET' && parts[0]==='ping') return reply(res, 200, {ok:true});

  if (req.method==='POST' && parts[0]==='players' && parts[1]) {
    const p = await body(req);
    players[parts[1]] = {...p, id:parts[1], ts:Date.now()};
    return reply(res, 200, {ok:true});
  }
  if (req.method==='GET' && parts[0]==='players' && parts[1]==='search') {
    const q = (url.searchParams.get('q')||'').toLowerCase();
    return reply(res, 200, Object.values(players).filter(p=>p.name&&(p.name.toLowerCase().includes(q)||String(p.id).includes(q))));
  }
  if (req.method==='POST' && parts[0]==='online' && parts[1]) {
    const p = await body(req);
    online[parts[1]] = {...p, id:parts[1], ts:Date.now()};
    if(!players[parts[1]]) players[parts[1]] = {...p, id:parts[1]};
    // Уведомляем всех подключённых по WS
    broadcast({type:'online_update', player: online[parts[1]]});
    return reply(res, 200, {ok:true});
  }
  if (req.method==='GET' && parts[0]==='online' && !parts[1]) {
    const now = Date.now();
    return reply(res, 200, Object.values(online).filter(p=>now-(p.ts||0)<2*60*1000));
  }
  if (req.method==='POST' && parts[0]==='pos' && parts[1]) {
    const p = await body(req);
    positions[parts[1]] = {...p, id:parts[1], ts:Date.now()};
    // Рассылаем позицию всем в той же карте по WS
    broadcastToMap(p.map, {type:'move', ...p});
    return reply(res, 200, {ok:true});
  }
  if (req.method==='GET' && parts[0]==='pos') {
    const map = url.searchParams.get('map');
    const now = Date.now();
    return reply(res, 200, Object.values(positions).filter(p=>now-(p.ts||0)<10000&&(!map||String(p.map)===String(map))));
  }
  if (req.method==='POST' && parts[0]==='mail' && parts[1]) {
    const toId = parts[1], letter = await body(req);
    if(!letter.type||!letter.from_id) return reply(res, 400, {error:'bad'});
    if(!mailbox[toId]) mailbox[toId]=[];
    if(!mailbox[toId].some(l=>l.type===letter.type&&String(l.from_id)===String(letter.from_id)))
      mailbox[toId].push({...letter, ts:Date.now()});
    return reply(res, 200, {ok:true});
  }
  if (req.method==='GET' && parts[0]==='mail' && parts[1]) return reply(res, 200, mailbox[parts[1]]||[]);
  if (req.method==='DELETE' && parts[0]==='mail' && parts[1]) { mailbox[parts[1]]=[]; return reply(res, 200, {ok:true}); }

  reply(res, 404, {error:'not found'});
});

// ── WebSocket сервер (без доп. зависимостей)
const wsClients = new Map(); // id -> {ws, map, userId}

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = require('crypto').createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsRead(data) {
  try {
    const fin = (data[0] & 0x80) !== 0;
    const opcode = data[0] & 0x0f;
    if (opcode === 0x8) return null; // close
    const masked = (data[1] & 0x80) !== 0;
    let len = data[1] & 0x7f, offset = 2;
    if (len === 126) { len = (data[2]<<8)|data[3]; offset = 4; }
    const mask = masked ? data.slice(offset, offset+4) : null;
    offset += masked ? 4 : 0;
    const payload = Buffer.alloc(len);
    for (let i=0; i<len; i++) payload[i] = masked ? data[offset+i]^mask[i%4] : data[offset+i];
    return JSON.parse(payload.toString());
  } catch(e) { return null; }
}

function wsWrite(socket, data) {
  try {
    const payload = Buffer.from(JSON.stringify(data));
    const len = payload.length;
    const header = len < 126
      ? Buffer.from([0x81, len])
      : Buffer.from([0x81, 126, (len>>8)&0xff, len&0xff]);
    socket.write(Buffer.concat([header, payload]));
  } catch(e) {}
}

function broadcast(msg) {
  wsClients.forEach(({socket}) => wsWrite(socket, msg));
}

function broadcastToMap(map, msg) {
  wsClients.forEach(client => {
    if (String(client.map) === String(map) && String(client.userId) !== String(msg.id))
      wsWrite(client.socket, msg);
  });
}

server.on('upgrade', (req, socket) => {
  wsHandshake(req, socket);
  const clientId = Math.random().toString(36).slice(2);
  const client = {socket, map: null, userId: null};
  wsClients.set(clientId, client);

  socket.on('data', data => {
    const msg = wsRead(data);
    if (!msg) { wsClients.delete(clientId); return; }
    if (msg.type === 'join') { client.userId = msg.id; client.map = msg.map; }
    if (msg.type === 'move') {
      client.map = msg.map;
      positions[msg.id] = {...msg, ts: Date.now()};
      broadcastToMap(msg.map, msg);
    }
  });

  socket.on('close', () => wsClients.delete(clientId));
  socket.on('error', () => wsClients.delete(clientId));
});

server.listen(process.env.PORT||3000, ()=>console.log('Citrus backend OK'));
