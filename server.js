const http = require('http');
const fs   = require('fs');
const https = require('https');

const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BIN = process.env.JSONBIN_BIN || '';

let DB = {
    players:{}, roulette:{},
    credits:{ credits:{}, borrows:{} },
    games:{}, studioSync:{}
};

function loadLocalDB(){
    try{ const d=JSON.parse(fs.readFileSync('/tmp/citrus_db.json','utf8')); if(d&&typeof d==='object'){DB={...DB,...d};if(!DB.credits)DB.credits={credits:{},borrows:{}};if(!DB.credits.credits)DB.credits.credits={};if(!DB.credits.borrows)DB.credits.borrows={};if(!DB.studioSync)DB.studioSync={};} console.log('✓ local DB loaded'); }catch(e){}
}

function loadDB(){
    if(!JSONBIN_KEY||!JSONBIN_BIN){ loadLocalDB(); return Promise.resolve(); }
    return new Promise(resolve=>{
        const req=https.request({hostname:'api.jsonbin.io',path:`/v3/b/${JSONBIN_BIN}/latest`,method:'GET',headers:{'X-Master-Key':JSONBIN_KEY}},res=>{
            let s=''; res.on('data',c=>s+=c);
            res.on('end',()=>{
                try{ const d=JSON.parse(s); if(d.record&&typeof d.record==='object'){DB={...DB,...d.record};if(!DB.credits)DB.credits={credits:{},borrows:{}};if(!DB.credits.credits)DB.credits.credits={};if(!DB.credits.borrows)DB.credits.borrows={};if(!DB.studioSync)DB.studioSync={};console.log('✓ JSONBin DB loaded');} }catch(e){loadLocalDB();}
                resolve();
            });
        });
        req.on('error',()=>{ loadLocalDB(); resolve(); }); req.end();
    });
}

let _st=null;
function saveDB(){
    try{ fs.writeFileSync('/tmp/citrus_db.json',JSON.stringify(DB)); }catch(e){}
    if(!JSONBIN_KEY||!JSONBIN_BIN)return;
    if(_st)clearTimeout(_st);
    _st=setTimeout(()=>{
        const payload=JSON.stringify(DB);
        const req=https.request({hostname:'api.jsonbin.io',path:`/v3/b/${JSONBIN_BIN}`,method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY,'Content-Length':Buffer.byteLength(payload)}},res=>{res.on('data',()=>{});res.on('end',()=>console.log('✓ saved to JSONBin'));});
        req.on('error',()=>{}); req.write(payload); req.end();
    },2000);
}

const mailbox={},online={},positions={};
const H={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};
const reply=(res,code,data)=>{ res.writeHead(code,H); res.end(JSON.stringify(data)); };
const body=req=>new Promise(ok=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>{ try{ok(JSON.parse(s))}catch{ok({})} }); });

const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,H);return res.end();}
    const url=new URL('http://x'+req.url);
    const parts=url.pathname.split('/').filter(Boolean);

    if(req.method==='GET'&&parts[0]==='ping') return reply(res,200,{ok:true});

    // Players
    if(req.method==='POST'&&parts[0]==='players'&&parts[1]){
        const p=await body(req); DB.players[parts[1]]={...p,id:parts[1],ts:Date.now()}; saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='players'&&parts[1]==='search'){
        const q=(url.searchParams.get('q')||'').toLowerCase();
        return reply(res,200,Object.values(DB.players).filter(p=>p.name&&(p.name.toLowerCase().includes(q)||String(p.id).includes(q))));
    }
    if(req.method==='GET'&&parts[0]==='players'&&parts[1]&&parts[1]!=='search'){
        const p=DB.players[parts[1]]; return p?reply(res,200,p):reply(res,404,{error:'not found'});
    }

    // Positions (HTTP fallback for poll)
    if(req.method==='GET'&&parts[0]==='pos'){
        const map=url.searchParams.get('map');
        const now=Date.now();
        const list=Object.values(positions).filter(p=>String(p.map)===String(map)&&now-(p.ts||0)<30000);
        return reply(res,200,list);
    }

    // Online
    if(req.method==='POST'&&parts[0]==='online'&&parts[1]){
        const p=await body(req); online[parts[1]]={...p,id:parts[1],ts:Date.now()};
        if(!DB.players[parts[1]]){DB.players[parts[1]]={...p,id:parts[1]};saveDB();}
        return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='online'&&!parts[1]){
        const now=Date.now(); return reply(res,200,Object.values(online).filter(p=>now-(p.ts||0)<2*60*1000));
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
    if(req.method==='DELETE'&&parts[0]==='mail'&&parts[1]){mailbox[parts[1]]=[]; return reply(res,200,{ok:true});}

    // Games
    if(req.method==='GET'&&parts[0]==='games'&&!parts[1]){
        // Восстанавливаем из профилей если DB.games пустая (после рестарта без JSONBin)
        if(Object.keys(DB.games).length===0){
            Object.values(DB.players||{}).forEach(p=>{
                (p.publishedGames||[]).forEach(g=>{ if(g.id) DB.games[g.id]=g; });
            });
        }
        return reply(res,200,Object.values(DB.games).sort((a,b)=>b.ts-a.ts));
    }
    if(req.method==='POST'&&parts[0]==='games'){
        const g=await body(req);
        if(!g.name||!g.authorId)return reply(res,400,{error:'bad'});
        const id='g_'+g.authorId+'_'+Date.now();
        DB.games[id]={...g,id,ts:Date.now()};
        // Backup в профиле автора — не потеряется при рестарте
        if(!DB.players[g.authorId]) DB.players[g.authorId]={id:g.authorId};
        if(!DB.players[g.authorId].publishedGames) DB.players[g.authorId].publishedGames=[];
        // Обновляем или добавляем
        const existing = DB.players[g.authorId].publishedGames.findIndex(x=>x.localId===g.localId);
        if(existing>=0) DB.players[g.authorId].publishedGames[existing]={...g,id,ts:Date.now()};
        else DB.players[g.authorId].publishedGames.push({...g,id,ts:Date.now()});
        saveDB();
        return reply(res,200,{ok:true,id});
    }
    if(req.method==='DELETE'&&parts[0]==='games'&&parts[1]){
        const g=DB.games[parts[1]];
        if(!g)return reply(res,404,{error:'not found'});
        if(String(g.authorId)!==String(url.searchParams.get('authorId')))return reply(res,403,{error:'forbidden'});
        delete DB.games[parts[1]]; saveDB(); return reply(res,200,{ok:true});
    }

    // Roulette
    if(req.method==='GET'&&parts[0]==='roulette-leaderboard'){
        return reply(res,200,Object.values(DB.roulette).sort((a,b)=>b.total-a.total));
    }
    if(req.method==='POST'&&parts[0]==='roulette-leaderboard'){
        const d=await body(req);
        if(!d.id||!d.prize)return reply(res,400,{ok:false});
        if(!DB.roulette[d.id])DB.roulette[d.id]={id:d.id,name:d.name,total:0};
        DB.roulette[d.id].total+=Number(d.prize);
        DB.roulette[d.id].name=d.name;
        saveDB(); return reply(res,200,{ok:true,total:DB.roulette[d.id].total});
    }

    // Credits
    if(req.method==='GET'&&parts[0]==='credits'){
        const now=Date.now();
        Object.values(DB.credits.borrows||{}).forEach(b=>{if(!b.penaltyApplied&&now>b.dueAt){b.penaltyApplied=true;saveDB();}});
        return reply(res,200,{credits:Object.values(DB.credits.credits||{}),borrows:Object.values(DB.credits.borrows||{})});
    }
    if(req.method==='POST'&&parts[0]==='credits'&&!parts[1]){
        const d=await body(req);
        if(!d.lenderId||!d.amount||!d.days)return reply(res,400,{ok:false,error:'Недостаточно данных'});
        if(d.amount<1000||d.amount>100000)return reply(res,400,{ok:false,error:'Сумма 1000–100000'});
        if(d.days<10||d.days>60)return reply(res,400,{ok:false,error:'Срок 10–60 минут'});
        const existing=Object.values(DB.credits.credits||{}).find(c=>String(c.lenderId)===String(d.lenderId));
        if(existing)return reply(res,400,{ok:false,error:'У тебя уже есть активный кредит'});
        const id='c_'+d.lenderId+'_'+Date.now();
        // Создаём кредит — баланс снимает клиент и присылает нам
        if(!DB.players[d.lenderId]) DB.players[d.lenderId]={id:d.lenderId,balance:0};
        if(d.newBalance !== undefined) DB.players[d.lenderId].balance = d.newBalance;
        DB.credits.credits[id]={id,lenderId:d.lenderId,lenderName:d.lenderName,amount:d.amount,days:d.days,borrowerId:null,borrowerName:null,createdAt:Date.now()};
        saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='POST'&&parts[0]==='credits'&&parts[1]==='borrow'){
        const d=await body(req);
        const credit=DB.credits.credits[d.creditId];
        if(!credit)return reply(res,404,{ok:false,error:'Кредит не найден'});
        if(credit.borrowerId)return reply(res,400,{ok:false,error:'Уже взят'});
        if(String(credit.lenderId)===String(d.borrowerId))return reply(res,400,{ok:false,error:'Нельзя брать свой кредит'});
        const existingDebt=Object.values(DB.credits.borrows||{}).find(b=>String(b.borrowerId)===String(d.borrowerId));
        if(existingDebt)return reply(res,400,{ok:false,error:'У тебя уже есть долг'});
        credit.borrowerId=d.borrowerId; credit.borrowerName=d.borrowerName;
        const dueAt=Date.now()+credit.days*60000;
        DB.credits.borrows[d.borrowerId]={borrowerId:d.borrowerId,borrowerName:d.borrowerName,lenderId:credit.lenderId,lenderName:credit.lenderName,amount:credit.amount,days:credit.days,dueAt,creditId:d.creditId,penaltyApplied:false};
        saveDB(); return reply(res,200,{ok:true,amount:credit.amount,days:credit.days});
    }
    if(req.method==='POST'&&parts[0]==='credits'&&parts[1]==='repay'){
        const d=await body(req);
        const borrow=DB.credits.borrows[d.borrowerId];
        if(!borrow)return reply(res,404,{ok:false,error:'Нет долга'});
        const repayAmount=borrow.amount, lenderId=borrow.lenderId;
        if(d.balance!==undefined&&DB.players[d.borrowerId]) DB.players[d.borrowerId].balance=d.balance;
        if(!DB.players[lenderId])DB.players[lenderId]={id:lenderId,balance:0};
        DB.players[lenderId].balance=(DB.players[lenderId].balance||0)+repayAmount;
        delete DB.credits.borrows[d.borrowerId];
        if(DB.credits.credits[borrow.creditId])delete DB.credits.credits[borrow.creditId];
        saveDB(); return reply(res,200,{ok:true,amount:repayAmount,lenderId,lenderBalance:DB.players[lenderId].balance});
    }
    if(req.method==='POST'&&parts[0]==='credits'&&parts[1]==='cancel'){
        const d=await body(req);
        const credit=DB.credits.credits[d.creditId];
        if(!credit||String(credit.lenderId)!==String(d.lenderId))return reply(res,404,{ok:false});
        if(credit.borrowerId)return reply(res,400,{ok:false,error:'Уже взят, нельзя отозвать'});
        const amt=credit.amount;
        // Возвращаем деньги кредитору на сервере
        if(!DB.players[d.lenderId]) DB.players[d.lenderId]={id:d.lenderId,balance:0};
        DB.players[d.lenderId].balance=(DB.players[d.lenderId].balance||0)+amt;
        delete DB.credits.credits[d.creditId]; saveDB();
        return reply(res,200,{ok:true, amount:amt, balance: DB.players[d.lenderId].balance});
    }

    // Совместная студия
    if(req.method==='POST'&&parts[0]==='studio'&&parts[1]==='invite'){
        const d=await body(req);
        if(!mailbox[d.toId])mailbox[d.toId]=[];
        mailbox[d.toId].push({type:'studio_invite',from_id:d.fromId,from_name:d.fromName,sessionId:d.sessionId,ts:Date.now()});
        return reply(res,200,{ok:true});
    }
    if(req.method==='POST'&&parts[0]==='studio'&&parts[1]==='sync'){
        const d=await body(req);
        if(!d.sessionId)return reply(res,400,{ok:false});
        if(!DB.studioSync)DB.studioSync={};
        DB.studioSync[d.sessionId]={blocks:d.blocks,ts:Date.now(),author:d.author};
        try{fs.writeFileSync('/tmp/citrus_db.json',JSON.stringify(DB));}catch(e){}
        return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='studio'&&parts[1]==='sync'){
        const sid=url.searchParams.get('sessionId');
        const d=DB.studioSync?.[sid];
        return reply(res,200,d||{blocks:null});
    }

    reply(res,404,{error:'not found'});
});

// WebSocket
const wsClients=new Map();
function wsHandshake(req,socket){
    const accept=require('crypto').createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
}
function wsRead(data){
    try{
        const masked=(data[1]&0x80)!==0;
        let len=data[1]&0x7f,offset=2;
        if(len===126){len=(data[2]<<8)|data[3];offset=4;}
        const mask=masked?data.slice(offset,offset+4):null; offset+=masked?4:0;
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
    wsClients.forEach(c=>{ if(String(c.map)===String(map)&&String(c.userId)!==String(exceptId))wsWrite(c.socket,msg); });
}
function broadcastToSession(sessionId,msg,exceptId){
    wsClients.forEach(c=>{ if(c.studioSession===sessionId&&String(c.userId)!==String(exceptId))wsWrite(c.socket,msg); });
}

server.on('upgrade',(req,socket)=>{
    wsHandshake(req,socket);
    const cid=Math.random().toString(36).slice(2);
    const client={socket,map:null,userId:null,studioSession:null};
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
            if(msg.type==='join'){
                client.userId=msg.id;client.map=msg.map;
                // Сразу отправить новому игроку позиции всех кто уже в этом мире
                const now2=Date.now();
                Object.values(positions).forEach(p=>{
                    if(String(p.id)!==String(msg.id)&&String(p.map)===String(msg.map)&&now2-(p.ts||0)<30000){
                        wsWrite(socket,p);
                    }
                });
            }
            if(msg.type==='move'){client.map=msg.map;positions[msg.id]={...msg,ts:Date.now()};broadcastToMap(msg.map,msg,msg.id);}
            if(msg.type==='studio_join'){client.studioSession=msg.sessionId;client.userId=msg.userId;}
            if(msg.type==='studio_block'||msg.type==='studio_clear'){broadcastToSession(msg.sessionId,msg,msg.userId);}
        }
    });
    socket.on('close',()=>wsClients.delete(cid));
    socket.on('error',()=>wsClients.delete(cid));
});

loadDB().then(()=>{
    server.listen(process.env.PORT||3000,()=>console.log('🍊 Citrus backend OK'));
});
