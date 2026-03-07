const http = require('http');
const mailbox = {};
const players = {};
const online  = {};
const positions = {}; // { userId: {id,name,color,x,y,z,ry,map,ts} }

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

http.createServer(async (req, res) => {
  if (req.method==='OPTIONS') { res.writeHead(204,H); return res.end(); }
  const url = new URL('http://x'+req.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method==='GET' && parts[0]==='ping')
    return reply(res, 200, {ok:true});

  // POST /players/:id
  if (req.method==='POST' && parts[0]==='players' && parts[1]) {
    const p = await body(req);
    players[parts[1]] = {...p, id:parts[1], ts: Date.now()};
    return reply(res, 200, {ok:true});
  }

  // GET /players/search?q=
  if (req.method==='GET' && parts[0]==='players' && parts[1]==='search') {
    const q = (url.searchParams.get('q')||'').toLowerCase();
    const found = Object.values(players).filter(p =>
      p.name && (p.name.toLowerCase().includes(q) || String(p.id).includes(q))
    );
    return reply(res, 200, found);
  }

  // POST /online/:id
  if (req.method==='POST' && parts[0]==='online' && parts[1]) {
    const p = await body(req);
    online[parts[1]] = {...p, id:parts[1], ts: Date.now()};
    if (!players[parts[1]]) players[parts[1]] = {...p, id:parts[1]};
    return reply(res, 200, {ok:true});
  }

  // GET /online
  if (req.method==='GET' && parts[0]==='online' && !parts[1]) {
    const now = Date.now();
    const list = Object.values(online).filter(p => now - (p.ts||0) < 2*60*1000);
    return reply(res, 200, list);
  }

  // POST /pos/:id — сохранить позицию игрока
  if (req.method==='POST' && parts[0]==='pos' && parts[1]) {
    const p = await body(req);
    positions[parts[1]] = {...p, id:parts[1], ts: Date.now()};
    return reply(res, 200, {ok:true});
  }

  // GET /pos?map=X — получить всех игроков в этой карте
  if (req.method==='GET' && parts[0]==='pos') {
    const map = url.searchParams.get('map');
    const now = Date.now();
    const list = Object.values(positions).filter(p =>
      now - (p.ts||0) < 10000 && // активны последние 10 сек
      (!map || String(p.map) === String(map))
    );
    return reply(res, 200, list);
  }

  // POST /mail/:toId
  if (req.method==='POST' && parts[0]==='mail' && parts[1]) {
    const toId = parts[1];
    const letter = await body(req);
    if (!letter.type || !letter.from_id) return reply(res, 400, {error:'bad'});
    if (!mailbox[toId]) mailbox[toId] = [];
    const dup = mailbox[toId].some(l =>
      l.type===letter.type && String(l.from_id)===String(letter.from_id)
    );
    if (!dup) mailbox[toId].push({...letter, ts: Date.now()});
    return reply(res, 200, {ok:true});
  }

  // GET /mail/:userId
  if (req.method==='GET' && parts[0]==='mail' && parts[1])
    return reply(res, 200, mailbox[parts[1]] || []);

  // DELETE /mail/:userId
  if (req.method==='DELETE' && parts[0]==='mail' && parts[1]) {
    mailbox[parts[1]] = [];
    return reply(res, 200, {ok:true});
  }

  reply(res, 404, {error:'not found'});

}).listen(process.env.PORT||3000, ()=>console.log('Citrus backend OK'));
