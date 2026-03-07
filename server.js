const http = require('http');
const mailbox = {}; // { userId: [letters] }
const players = {}; // { userId: {id,name,tag,color,ts} }

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
  const parts = req.url.split('/').filter(Boolean);

  // GET  /ping
  if (req.method==='GET' && parts[0]==='ping')
    return reply(res, 200, {ok:true});

  // POST /players/:id  — регистрация игрока
  if (req.method==='POST' && parts[0]==='players' && parts[1]) {
    const p = await body(req);
    players[parts[1]] = {...p, ts: Date.now()};
    return reply(res, 200, {ok:true});
  }

  // GET  /players/search?q=...  — поиск игроков
  if (req.method==='GET' && parts[0]==='players' && parts[1]==='search') {
    const q = new URL('http://x'+req.url).searchParams.get('q')||'';
    const found = Object.values(players).filter(p =>
      p.name && p.name.toLowerCase().includes(q.toLowerCase())
    );
    return reply(res, 200, found);
  }

  // POST /mail/:toId  — отправить письмо
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

  // GET  /mail/:userId  — получить письма
  if (req.method==='GET' && parts[0]==='mail' && parts[1])
    return reply(res, 200, mailbox[parts[1]] || []);

  // DELETE /mail/:userId  — очистить после прочтения
  if (req.method==='DELETE' && parts[0]==='mail' && parts[1]) {
    mailbox[parts[1]] = [];
    return reply(res, 200, {ok:true});
  }

  reply(res, 404, {error:'not found'});

}).listen(process.env.PORT||3000, ()=>console.log('Citrus backend OK'));
