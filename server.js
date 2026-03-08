const http = require('http');
const fs = require('fs');

// Persistent storage for players
const DB_FILE = '/tmp/citrus_players.json';
let players = {};
try { players = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) { players = {}; }
const savePlayers = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(players)); } catch(e){} };

const mailbox = {}, online = {}, positions = {};
const publishedGames = {}; // { gameId: {id, name, author, authorId, desc, data, ts} }

const H = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
  'Content-Type':'application/json'
};
const reply = (res,code,data)=>{ res.writeHead(code,H); res.end(JSON.stringify(data)); };
const body  = req=>new Promise(ok=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>{ try{ok(JSON.parse(s))}catch{ok({})} }); });

const server = http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,H);return res.end();}
  const url=new URL('http://x'+req.url);
  const parts=url.pathname.split('/').filter(Boolean);

  if(req.method==='GET'&&parts[0]==='ping') return reply(res,200,{ok:true});

  // Players
  if(req.method==='POST'&&parts[0]==='players'&&parts[1]){
    const p=await body(req); players[parts[1]]={...p,id:parts[1],ts:Date.now()}; savePlayers(); return reply(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[0]==='players'&&parts[1]==='search'){
    const q=(url.searchParams.get('q')||'').toLowerCase();
    return reply(res,200,Object.values(players).filter(p=>p.name&&(p.name.toLowerCase().includes(q)||String(p.id).includes(q))));
  }

  // Online
  if(req.method==='POST'&&parts[0]==='online'&&parts[1]){
    const p=await body(req); online[parts[1]]={...p,id:parts[1],ts:Date.now()};
    if(!players[parts[1]])players[parts[1]]={...p,id:parts[1]};
    return reply(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[0]==='online'&&!parts[1]){
    const now=Date.now();
    return reply(res,200,Object.values(online).filter(p=>now-(p.ts||0)<2*60*1000));
  }

  // Positions
  if(req.method==='POST'&&parts[0]==='pos'&&parts[1]){
    const p=await body(req); positions[parts[1]]={...p,id:parts[1],ts:Date.now()};
    broadcastToMap(p.map,{type:'move',...p},p.id); return reply(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[0]==='pos'){
    const map=url.searchParams.get('map'),now=Date.now();
    return reply(res,200,Object.values(positions).filter(p=>now-(p.ts||0)<10000&&(!map||String(p.map)===String(map))));
  }

  // Mail
  if(req.method==='POST'&&parts[0]==='mail'&&parts[1]){
    const toId=parts[1],letter=await body(req);
    if(!letter.type||!letter.from_id)return reply(res,400,{error:'bad'});
    if(!mailbox[toId])mailbox[toId]=[];
    if(!mailbox[toId].some(l=>l.type===letter.type&&String(l.from_id)===String(letter.from_id)))
      mailbox[toId].push({...letter,ts:Date.now()});
    return reply(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[0]==='mail'&&parts[1]) return reply(res,200,mailbox[parts[1]]||[]);
  if(req.method==='DELETE'&&parts[0]==='mail'&&parts[1]){mailbox[parts[1]]=[];return reply(res,200,{ok:true});}

  // ── PUBLISHED GAMES ──
  // GET /games — все опубликованные игры
  if(req.method==='GET'&&parts[0]==='games'&&!parts[1]){
    return reply(res,200,Object.values(publishedGames).sort((a,b)=>b.ts-a.ts));
  }
  // POST /games — опубликовать игру
  if(req.method==='POST'&&parts[0]==='games'){
    const g=await body(req);
    if(!g.name||!g.authorId) return reply(res,400,{error:'bad'});
    const id = 'g_'+g.authorId+'_'+Date.now();
    publishedGames[id]={...g, id, ts:Date.now()};
    return reply(res,200,{ok:true,id});
  }
  // DELETE /games/:id?authorId=X — удалить свою игру
  if(req.method==='DELETE'&&parts[0]==='games'&&parts[1]){
    const g=publishedGames[parts[1]];
    if(!g) return reply(res,404,{error:'not found'});
    if(String(g.authorId)!==String(url.searchParams.get('authorId')))
      return reply(res,403,{error:'forbidden'});
    delete publishedGames[parts[1]];
    return reply(res,200,{ok:true});
  }

  reply(res,404,{error:'not found'});
});

// ── WebSocket
const wsClients = new Map();
function wsHandshake(req,socket){
  const accept=require('crypto').createHash('sha1')
    .update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
}
function wsRead(data){
  try{
    const masked=(data[1]&0x80)!==0;
    let len=data[1]&0x7f,offset=2;
    if(len===126){len=(data[2]<<8)|data[3];offset=4;}
    const mask=masked?data.slice(offset,offset+4):null;
    offset+=masked?4:0;
    const payload=Buffer.alloc(len);
    for(let i=0;i<len;i++)payload[i]=masked?data[offset+i]^mask[i%4]:data[offset+i];
    return JSON.parse(payload.toString());
  }catch(e){return null;}
}
function wsWrite(socket,data){
  try{
    const payload=Buffer.from(JSON.stringify(data));
    const len=payload.length;
    const header=len<126?Buffer.from([0x81,len]):Buffer.from([0x81,126,(len>>8)&0xff,len&0xff]);
    socket.write(Buffer.concat([header,payload]));
  }catch(e){}
}
function broadcastToMap(map,msg,exceptId){
  wsClients.forEach(client=>{
    if(String(client.map)===String(map)&&String(client.userId)!==String(exceptId))
      wsWrite(client.socket,msg);
  });
}
server.on('upgrade',(req,socket)=>{
  wsHandshake(req,socket);
  const cid=Math.random().toString(36).slice(2);
  const client={socket,map:null,userId:null};
  wsClients.set(cid,client);
  let buf=Buffer.alloc(0);
  socket.on('data',chunk=>{
    buf=Buffer.concat([buf,chunk]);
    while(buf.length>=2){
      const opcode=buf[0]&0x0f;
      if(opcode===0x8){wsClients.delete(cid);return;}
      let len=buf[1]&0x7f,frameLen=2+(buf[1]&0x80?4:0)+len;
      if(len===126)frameLen=4+(buf[1]&0x80?4:0)+((buf[2]<<8)|buf[3]);
      if(buf.length<frameLen)break;
      const frame=buf.slice(0,frameLen);buf=buf.slice(frameLen);
      const msg=wsRead(frame);
      if(!msg)continue;
      if(msg.type==='join'){client.userId=msg.id;client.map=msg.map;}
      if(msg.type==='move'){client.map=msg.map;positions[msg.id]={...msg,ts:Date.now()};broadcastToMap(msg.map,msg,msg.id);}
      if(msg.type==='chat'){broadcastToMap(msg.map,msg,msg._from);}
    }
  });
  socket.on('close',()=>wsClients.delete(cid));
  socket.on('error',()=>wsClients.delete(cid));
});
server.listen(process.env.PORT||3000,()=>console.log('Citrus backend OK'));
