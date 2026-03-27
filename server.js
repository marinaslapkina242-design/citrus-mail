const http = require('http');
const fs   = require('fs');
const https = require('https');

const GIST_TOKEN      = process.env.GIST_TOKEN      || '';
const GIST_ID         = process.env.GIST_ID         || '';
const GROQ_KEY        = process.env.GROQ_KEY        || '';

let DB = {
    players:{}, roulette:{},
    credits:{ credits:{}, borrows:{} },
    games:{}, studioSync:{}, bans:{},
    nfts:{}, support:{}, // id -> {id,emoji,name,desc,price,rarity,minReward,maxReward,by,ts,priceHistory:[],ownerId,ownerName,opened}
    stats:{
        totalRegistered: 0,
        totalSessions: 0,
        worldPlays: {},
        dailyActive: {},
        firstSeenDates: []
    }
};

function fixDB(){
    if(!DB.credits) DB.credits={credits:{},borrows:{}};
    if(!DB.credits.credits) DB.credits.credits={};
    if(!DB.credits.borrows) DB.credits.borrows={};
    if(!DB.studioSync) DB.studioSync={};
    if(!DB.bans) DB.bans={};
    if(!DB.nfts) DB.nfts={};
    if(!DB.pendingEarnings) DB.pendingEarnings={};
    if(!DB.support) DB.support={};
    if(!DB.dm) DB.dm={};
    if(!DB.stats) DB.stats={totalRegistered:0,totalSessions:0,worldPlays:{},dailyActive:{},firstSeenDates:[]};
    if(!DB.devmail) DB.devmail={};
    if(!DB.aiHelper) DB.aiHelper={};
}

function loadLocalDB(){
    try{
        const d=JSON.parse(fs.readFileSync('/tmp/citrus_db.json','utf8'));
        if(d&&typeof d==='object'){ DB={...DB,...d}; fixDB(); }
        console.log('✓ local DB loaded, players:'+Object.keys(DB.players).length);
    }catch(e){}
}

function loadDB(){
    if(!GIST_TOKEN||!GIST_ID){ loadLocalDB(); return Promise.resolve(); }
    return new Promise(resolve=>{
        const req=https.request({
            hostname:'api.github.com',
            path:`/gists/${GIST_ID}`,
            method:'GET',
            headers:{'Authorization':'token '+GIST_TOKEN,'User-Agent':'citrus-game','Accept':'application/vnd.github.v3+json'}
        }, res=>{
            let s=''; res.on('data',c=>s+=c);
            res.on('end',()=>{
                try{
                    const gist=JSON.parse(s);
                    const content=gist.files&&gist.files['citrus_db.json']&&gist.files['citrus_db.json'].content;
                    if(content){
                        const d=JSON.parse(content);
                        if(d&&typeof d==='object'){ DB={...DB,...d}; fixDB(); }
                        console.log('✅ Gist DB loaded, players:'+Object.keys(DB.players).length);
                    }
                }catch(e){ console.error('❌ Gist load error:',e.message); loadLocalDB(); }
                resolve();
            });
        });
        req.on('error',()=>{ console.error('❌ Gist unreachable'); loadLocalDB(); resolve(); });
        req.end();
    });
}

let _st=null;
function saveDB(){
    // Всегда пишем локально
    try{ fs.writeFileSync('/tmp/citrus_db.json',JSON.stringify(DB)); }catch(e){}
    if(!GIST_TOKEN||!GIST_ID) return;
    if(_st) clearTimeout(_st);
    _st=setTimeout(()=>{
        // Не сохраняем studioSync — он большой и временный
        const toSave={...DB, studioSync:{}};
        const payload=JSON.stringify(toSave);
        const kb=(Buffer.byteLength(payload)/1024).toFixed(1);
        console.log(`💾 saving to Gist: ${kb}KB`);
        const gistBody=JSON.stringify({files:{'citrus_db.json':{content:payload}}});
        const req=https.request({
            hostname:'api.github.com',
            path:`/gists/${GIST_ID}`,
            method:'PATCH',
            headers:{
                'Authorization':'token '+GIST_TOKEN,
                'User-Agent':'citrus-game',
                'Accept':'application/vnd.github.v3+json',
                'Content-Type':'application/json',
                'Content-Length':Buffer.byteLength(gistBody)
            }
        }, res=>{
            let s=''; res.on('data',c=>s+=c);
            res.on('end',()=>{
                if(res.statusCode===200) console.log('✅ Gist saved OK, '+kb+'KB');
                else console.error('❌ Gist save error:',res.statusCode,s.slice(0,300));
            });
        });
        req.on('error',e=>console.error('❌ Gist request error:',e.message));
        req.write(gistBody); req.end();
    }, 3000);
}

const mailbox={},online={},positions={};
const H={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,PATCH,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};
const reply=(res,code,data)=>{ res.writeHead(code,H); res.end(JSON.stringify(data)); };
const body=req=>new Promise(ok=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>{ try{ok(JSON.parse(s))}catch{ok({})} }); });

const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,H);return res.end();}
    const url=new URL('http://x'+req.url);
    const parts=url.pathname.split('/').filter(Boolean);

    if(req.method==='GET'&&parts[0]==='ping') return reply(res,200,{ok:true, players:Object.keys(DB.players).length, storage: (GIST_TOKEN&&GIST_ID)?'gist':'local' });

    // Бэкап БД (только с adminKey)
    if(req.method==='GET'&&parts[0]==='backup'){
        const key=url.searchParams.get('key');
        if(key!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        return reply(res,200,{
            players: Object.keys(DB.players).length,
            stats: DB.stats,
            bans: Object.keys(DB.bans).length,
            roulette: Object.keys(DB.roulette).length,
            db: DB
        });
    }

    // Players
    if(req.method==='POST'&&parts[0]==='players'&&parts[1]){
        const p=await body(req);
        const isNew = !DB.players[parts[1]];
        const existing = DB.players[parts[1]] || {};

        // Баланс — берём от клиента если он явно передал число, иначе берём из БД
        const safeBalance = (typeof p.balance === 'number') ? p.balance : (existing.balance || 0);

        // Инвентарь — доверяем клиенту если он прислал массив (даже пустой после снятия вещей)
        // Мёрдж убран — он возвращал снятые предметы обратно
        const safeInv = Array.isArray(p.inventory) ? p.inventory : (existing.inventory || []);

        // Друзья — объединяем по id
        const friendMap = {};
        [...(existing.friends||[]),...(p.friends||[])].forEach(f=>{
            const id=String(typeof f==='object'?f.id:f); if(id) friendMap[id]=f;
        });

        // Запросы в друзья
        const frMap = {};
        [...(existing.friendRequests||[]),...(p.friendRequests||[])].forEach(f=>{
            const id=String(typeof f==='object'?f.id:f); if(id) frMap[id]=f;
        });

        // Уровень — берём максимальный, XP берём от максимального уровня
        const safeLevel = Math.max(p.level||1, existing.level||1);
        const safeXP = (p.level||1) >= (existing.level||1) ? (p.xp||0) : (existing.xp||0);

        // Ежедневная серия — берём максимальный стрик
        const safeStreak = Math.max(p.dailyStreak||0, existing.dailyStreak||0);
        // dailyItemClaimed — берём самый свежий (большее число = позже забрали)
        const safeClaimed = String(Math.max(
            parseInt(p.dailyItemClaimed||'0'),
            parseInt(existing.dailyItemClaimed||'0')
        )) || null;

        // Посещённые миры — объединяем
        const mergedMaps = Array.from(new Set([...(existing.visitedMaps||[]),...(p.visitedMaps||[])]));

        // Кастомные карты — объединяем
        const mapMap = {};
        [...(existing.customMaps||[]),...(p.customMaps||[])].forEach(m=>{ if(m&&m.id) mapMap[m.id]=m; });

        DB.players[parts[1]] = {
            ...existing,
            ...p,
            id: parts[1],
            ts: Date.now(),
            // Защищённые поля (берём максимум/слияние):
            balance: safeBalance,
            inventory: safeInv,
            friends: Object.values(friendMap),
            friendRequests: Object.values(frMap),
            level: safeLevel,
            xp: safeXP,
            dailyStreak: safeStreak,
            dailyItemClaimed: safeClaimed,
            visitedMaps: mergedMaps,
            customMaps: Object.values(mapMap),
            // hubTime только через /hub-time — не затираем
            hubTime: existing.hubTime || 0,
        };

        if(isNew){
            if(!DB.stats) DB.stats={totalRegistered:0,totalSessions:0,worldPlays:{},dailyActive:{},firstSeenDates:[]};
            DB.stats.totalRegistered = Object.keys(DB.players).length;
            const today = new Date().toISOString().slice(0,10);
            DB.stats.firstSeenDates = DB.stats.firstSeenDates||[];
            DB.stats.firstSeenDates.push(today);
        }
        saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='players'&&parts[1]==='search'){
        const q=(url.searchParams.get('q')||'').toLowerCase();
        return reply(res,200,Object.values(DB.players).filter(p=>p.name&&(p.name.toLowerCase().includes(q)||String(p.id).includes(q))));
    }
    if(req.method==='GET'&&parts[0]==='players'&&parts[1]&&parts[1]!=='search'){
        const p=DB.players[parts[1]]; return p?reply(res,200,p):reply(res,404,{error:'not found'});
    }
if(req.method==='GET'&&parts[0]==='devmail'&&!parts[1]){
    if(!DB.devmail)DB.devmail={};
    return reply(res,200,Object.values(DB.devmail).sort((a,b)=>b.ts-a.ts));
}
 
// POST /devmail — создать письмо (только разраб)
if(req.method==='POST'&&parts[0]==='devmail'&&!parts[1]){
    const d=await body(req);
    if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
    const id='devmail_'+Date.now();
    if(!DB.devmail)DB.devmail={};
    DB.devmail[id]={
        id,
        emoji:   d.emoji   || '📬',
        title:   d.title   || 'Без заголовка',
        body:    d.body     || '',
        version: d.version || '',
        by:      d.by      || 'Разраб',
        ts:      Date.now()
    };
    saveDB();
    return reply(res,200,{ok:true,id});
}
 
// DELETE /devmail/:id — удалить письмо (только разраб)
if(req.method==='DELETE'&&parts[0]==='devmail'&&parts[1]){
    const d=await body(req);
    if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
    if(!DB.devmail||!DB.devmail[parts[1]]) return reply(res,404,{error:'not found'});
    delete DB.devmail[parts[1]];
    saveDB();
    return reply(res,200,{ok:true});
}

    // Online
    if(req.method==='POST'&&parts[0]==='online'&&parts[1]){
        const p=await body(req);
        const wasOffline = !online[parts[1]] || Date.now()-(online[parts[1]].ts||0) > 3*60*1000;
        online[parts[1]]={...p,id:parts[1],ts:Date.now()};
        if(!DB.players[parts[1]]){DB.players[parts[1]]={...p,id:parts[1]};saveDB();}
        // Считаем уникальные дневные сессии
        if(wasOffline){
            if(!DB.stats) DB.stats={totalRegistered:0,totalSessions:0,worldPlays:{},dailyActive:{},firstSeenDates:[]};
            DB.stats.totalSessions = (DB.stats.totalSessions||0) + 1;
            const today = new Date().toISOString().slice(0,10);
            if(!DB.stats.dailyActive) DB.stats.dailyActive={};
            DB.stats.dailyActive[today] = (DB.stats.dailyActive[today]||0) + 1;
            saveDB();
        }
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
        // Дедупликация ТОЛЬКО для заявок в друзья — подарки и поздравления всегда добавляем
        const DEDUP_TYPES = ['friend_req','friend_acc'];
        if(DEDUP_TYPES.includes(letter.type)){
            if(!mailbox[toId].some(l=>l.type===letter.type&&String(l.from_id)===String(letter.from_id)))
                mailbox[toId].push({...letter,ts:Date.now()});
        } else {
            // Подарки, поздравления и прочее — всегда добавляем
            mailbox[toId].push({...letter,id:Date.now()+'_'+Math.random().toString(36).slice(2,5),ts:Date.now()});
        }
        return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='mail'&&parts[1]) return reply(res,200,mailbox[parts[1]]||[]);
    if(req.method==='DELETE'&&parts[0]==='mail'&&parts[1]){mailbox[parts[1]]=[]; return reply(res,200,{ok:true});}

    // Games
    // GET /games/:id — получить конкретную карту по ID
    if(req.method==='GET'&&parts[0]==='games'&&parts[1]){
        const g=DB.games[parts[1]];
        if(!g){
            // Ищем в резервных копиях профилей
            let found=null;
            Object.values(DB.players||{}).forEach(p=>{
                (p.publishedGames||[]).forEach(pg=>{ if(pg.id===parts[1]) found=pg; });
            });
            if(found){ DB.games[parts[1]]=found; saveDB(); return reply(res,200,found); }
            return reply(res,404,{error:'not found'});
        }
        return reply(res,200,g);
    }
    // GET /games — список всех карт
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
        // Разраб может удалять любые игры
        const isAdminDel = url.searchParams.get('adminKey')==='citrus_admin_2025';
        if(!isAdminDel && String(g.authorId)!==String(url.searchParams.get('authorId')))return reply(res,403,{error:'forbidden'});
        delete DB.games[parts[1]]; saveDB(); return reply(res,200,{ok:true});
    }
    // POST /games/:id/verify — подтвердить/снять подтверждение (только разраб)
    if(req.method==='POST'&&parts[0]==='games'&&parts[2]==='verify'){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        const g=DB.games[parts[1]];
        if(!g) return reply(res,404,{error:'not found'});
        g.verified = !!d.verified;
        g.verifiedAt = d.verified ? Date.now() : null;
        saveDB();
        return reply(res,200,{ok:true, verified:g.verified});
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
        // НЕ трогаем серверный баланс — клиент сам прибавит сумму локально
        delete DB.credits.credits[d.creditId]; saveDB();
        return reply(res,200,{ok:true, amount:amt});
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

    // Positions HTTP fallback
    if(req.method==='GET'&&parts[0]==='pos'){
        const map=url.searchParams.get('map');
        const now=Date.now();
        return reply(res,200,Object.values(positions).filter(p=>String(p.map)===String(map)&&now-(p.ts||0)<30000));
    }
    // HTTP fallback для позиций (когда WS недоступен)
    if(req.method==='POST'&&parts[0]==='pos'&&parts[1]){
        const p=await body(req);
        if(p&&p.map){
            positions[parts[1]]={...p,id:parts[1],ts:Date.now(),type:'move'};
            broadcastToMap(p.map,{...p,id:parts[1],type:'move'},parts[1]);
        }
        return reply(res,200,{ok:true});
    }

    // ══════════ NFT ПОДАРКИ ══════════

    if(req.method==='GET'&&parts[0]==='nfts'&&!parts[1]){
        if(!DB.nfts) DB.nfts={};
        return reply(res,200, Object.values(DB.nfts));
    }
    if(req.method==='POST'&&parts[0]==='nfts'&&!parts[1]){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        const id='nft_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
        const nft={
            id, emoji:d.emoji||'🎁', name:d.name||'Подарок',
            desc:d.desc||'', price:d.price||0, rarity:d.rarity||'common',
            reward:d.reward||100, maxReward:d.reward||100,
            by:d.by||'Разраб', ts:Date.now(),
            priceHistory:[{price:d.price||0, ts:Date.now()}],
            ownerId: d.giftTo||null, ownerName: d.giftToName||null,
            opened:false, onMarket: !d.giftTo
        };
        DB.nfts[id]=nft; saveDB();
        return reply(res,200,{ok:true,nft});
    }
    if(req.method==='PATCH'&&parts[0]==='nfts'&&parts[2]==='price'){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        const nft=DB.nfts[parts[1]];
        if(!nft) return reply(res,404,{error:'not found'});
        nft.price=d.price;
        nft.priceHistory=nft.priceHistory||[];
        nft.priceHistory.push({price:d.price, ts:Date.now()});
        if(nft.priceHistory.length>50) nft.priceHistory=nft.priceHistory.slice(-50);
        saveDB(); return reply(res,200,{ok:true,nft});
    }
    if(req.method==='POST'&&parts[0]==='nfts'&&parts[2]==='buy'){
        const d=await body(req);
        const nft=DB.nfts[parts[1]];
        if(!nft) return reply(res,404,{error:'not found'});
        if(!nft.onMarket) return reply(res,400,{error:'not on market'});
        if(nft.opened) return reply(res,400,{error:'already opened'});
        if(String(nft.ownerId)===String(d.buyerId)) return reply(res,400,{error:'your own nft'});
        if(!DB.players[d.buyerId]) DB.players[d.buyerId]={id:String(d.buyerId),name:d.buyerName||'',balance:d.buyerBalance||0};
        const buyer=DB.players[d.buyerId];
        if((d.buyerBalance||0)>=(buyer.balance||0)) buyer.balance=d.buyerBalance||0;
        if(nft.price>0&&(buyer.balance||0)<nft.price) return reply(res,400,{error:'not enough balance'});
        buyer.balance=(buyer.balance||0)-nft.price;
        const prevOwnerId=nft.sellerId||nft.ownerId;
        if(nft.sellerIsPlayer && prevOwnerId && String(prevOwnerId)!==String(d.buyerId)){
            if(!DB.players[prevOwnerId]) DB.players[prevOwnerId]={id:String(prevOwnerId),balance:0};
            if(!DB.pendingEarnings) DB.pendingEarnings={};
            if(!DB.pendingEarnings[prevOwnerId]) DB.pendingEarnings[prevOwnerId]={total:0,sales:[]};
            DB.pendingEarnings[prevOwnerId].total=(DB.pendingEarnings[prevOwnerId].total||0)+nft.price;
            DB.pendingEarnings[prevOwnerId].sales.push({
                nftId:nft.id, nftName:nft.name, nftEmoji:nft.emoji||'🎁',
                price:nft.price, buyerName:d.buyerName||'Игрок', ts:Date.now()
            });
        }
        nft.ownerId=String(d.buyerId); nft.ownerName=d.buyerName||buyer.name;
        nft.onMarket=false; nft.sellerId=null; nft.sellerIsPlayer=false;
        saveDB(); return reply(res,200,{ok:true,nft,newBalance:buyer.balance});
    }
    if(req.method==='POST'&&parts[0]==='nfts'&&parts[2]==='sell'){
        const d=await body(req);
        const nft=DB.nfts[parts[1]];
        if(!nft) return reply(res,404,{error:'not found'});
        if(nft.opened) return reply(res,400,{error:'already opened'});
        if(String(nft.ownerId)!==String(d.playerId)) return reply(res,403,{error:'not your nft'});
        const sellPrice=parseInt(d.price)||nft.price||0;
        if(sellPrice<1) return reply(res,400,{error:'price must be > 0'});
        nft.onMarket=true; nft.price=sellPrice;
        nft.sellerId=String(d.playerId); nft.sellerName=d.playerName||'';
        nft.sellerIsPlayer=true;
        nft.priceHistory=nft.priceHistory||[];
        nft.priceHistory.push({price:sellPrice,ts:Date.now()});
        saveDB(); return reply(res,200,{ok:true,nft});
    }
    if(req.method==='POST'&&parts[0]==='nfts'&&parts[2]==='unsell'){
        const d=await body(req);
        const nft=DB.nfts[parts[1]];
        if(!nft) return reply(res,404,{error:'not found'});
        if(String(nft.ownerId)!==String(d.playerId)) return reply(res,403,{error:'not your nft'});
        nft.onMarket=false; nft.sellerId=null; nft.sellerIsPlayer=false;
        saveDB(); return reply(res,200,{ok:true,nft});
    }
    if(req.method==='GET'&&parts[0]==='earnings'&&parts[1]){
        if(!DB.pendingEarnings) DB.pendingEarnings={};
        return reply(res,200, DB.pendingEarnings[parts[1]]||{total:0,sales:[]});
    }
    if(req.method==='POST'&&parts[0]==='earnings'&&parts[1]==='claim'||
       req.method==='POST'&&parts[0]==='earnings'&&parts[2]==='claim'){
        const pid=parts[1]==='claim'?parts[0]:parts[1];
        if(!DB.pendingEarnings||!DB.pendingEarnings[pid]) return reply(res,200,{ok:true,amount:0});
        const amount=DB.pendingEarnings[pid].total||0;
        if(!DB.players[pid]) DB.players[pid]={id:pid,balance:0};
        DB.players[pid].balance=(DB.players[pid].balance||0)+amount;
        delete DB.pendingEarnings[pid];
        saveDB(); return reply(res,200,{ok:true,amount,newBalance:DB.players[pid].balance});
    }
    if(req.method==='POST'&&parts[0]==='nfts'&&parts[2]==='open'){
        const d=await body(req);
        const nft=DB.nfts[parts[1]];
        if(!nft) return reply(res,404,{error:'not found'});
        if(nft.opened) return reply(res,400,{error:'already opened'});
        if(nft.onMarket) return reply(res,400,{error:'on market, remove first'});
        if(String(nft.ownerId)!==String(d.playerId)) return reply(res,403,{error:'not your gift'});
        const maxReward=nft.maxReward||nft.reward||100;
        const reward=Math.floor(Math.random()*maxReward)+1;
        nft.opened=true; nft.openedReward=reward; nft.openedAt=Date.now();
        const player=DB.players[d.playerId];
        if(player){ player.balance=(player.balance||0)+reward; }
        saveDB(); return reply(res,200,{ok:true,reward,nft});
    }
    if(req.method==='GET'&&parts[0]==='nfts'&&parts[1]==='player'){
        if(!DB.nfts) DB.nfts={};
        const pid=String(parts[2]);
        return reply(res,200, Object.values(DB.nfts).filter(n=>String(n.ownerId)===pid));
    }

    // ══════════ ЛИЧНЫЕ СООБЩЕНИЯ ══════════

    if(req.method==='GET'&&parts[0]==='dm'&&parts[1]){
        if(!DB.dm) DB.dm={};
        return reply(res,200, DB.dm[parts[1]]||[]);
    }
    if(req.method==='POST'&&parts[0]==='dm'&&parts[1]){
        const d=await body(req);
        if(!d.from) return reply(res,400,{error:'missing from'});
        if(!d.text||!d.text.trim()) return reply(res,400,{error:'empty message'});
        if(!DB.dm) DB.dm={};
        if(!DB.dm[parts[1]]) DB.dm[parts[1]]=[];
        const msg={id:Date.now()+'_'+Math.random().toString(36).slice(2,5),
            from:String(d.from), fromName:d.fromName||'?', text:d.text.trim(),
            ts:Date.now(), read:false};
        DB.dm[parts[1]].push(msg);
        if(DB.dm[parts[1]].length>200) DB.dm[parts[1]]=DB.dm[parts[1]].slice(-200);
        saveDB(); return reply(res,200,{ok:true,msg});
    }
    if(req.method==='POST'&&parts[0]==='dm'&&parts[2]==='read'){
        const d=await body(req);
        if(!DB.dm||!DB.dm[parts[1]]) return reply(res,200,{ok:true});
        DB.dm[parts[1]].forEach(m=>{ if(String(m.from)!==String(d.userId)) m.read=true; });
        saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='dm'&&parts[1]==='unread'){
        if(!DB.dm) return reply(res,200,{count:0,chats:{}});
        const uid=String(parts[2]);
        let count=0; const chats={};
        Object.entries(DB.dm).forEach(([chatId,msgs])=>{
            if(!chatId.includes(uid)) return;
            const unread=msgs.filter(m=>String(m.from)!==uid&&!m.read).length;
            if(unread>0){ chats[chatId]=unread; count+=unread; }
        });
        return reply(res,200,{count,chats});
    }

    // Leaderboard (по балансу)
    if(req.method==='GET'&&parts[0]==='leaderboard'){
        const top = Object.values(DB.players)
            .filter(p=>p.name&&(p.balance||0)>=0)
            .sort((a,b)=>(b.balance||0)-(a.balance||0))
            .slice(0,50)
            .map(p=>({id:p.id,name:p.name,tag:p.tag||'',color:p.color||'#FF9800',balance:p.balance||0,inventory:p.inventory||[]}));
        return reply(res,200,top);
    }

    // Leaderboard (по времени на сайте)
    if(req.method==='GET'&&parts[0]==='leaderboard-time'){
        const top = Object.values(DB.players)
            .filter(p=>p.name&&(p.hubTime||0)>0)
            .sort((a,b)=>(b.hubTime||0)-(a.hubTime||0))
            .slice(0,50)
            .map(p=>({id:p.id,name:p.name,tag:p.tag||'',color:p.color||'#FF9800',hubTime:p.hubTime||0,inventory:p.inventory||[]}));
        return reply(res,200,top);
    }

    // Обновить время на сайте
    if(req.method==='POST'&&parts[0]==='hub-time'&&parts[1]){
        const d=await body(req);
        const sec=parseInt(d.seconds)||0;
        if(sec<=0||sec>7200) return reply(res,400,{error:'bad seconds'});
        if(!DB.players[parts[1]]) return reply(res,404,{error:'not found'});
        DB.players[parts[1]].hubTime = (DB.players[parts[1]].hubTime||0) + sec;
        saveDB();
        return reply(res,200,{ok:true, hubTime: DB.players[parts[1]].hubTime});
    }

    // Stats
    if(req.method==='GET'&&parts[0]==='stats'){
        if(!DB.stats) DB.stats={totalRegistered:0,totalSessions:0,worldPlays:{},dailyActive:{},firstSeenDates:[]};
        DB.stats.totalRegistered = Object.keys(DB.players).length;
        const allAccounts = Object.values(DB.players)
            .filter(p=>p.name && !/[.?]/.test(p.name))
            .map(p=>({
                id:p.id, name:p.name||'?', tag:p.tag||'', color:p.color||'#888',
                ts: p.ts||0
            })).sort((a,b)=>b.ts-a.ts);
        return reply(res,200,{...DB.stats, allAccounts});
    }
    if(req.method==='POST'&&parts[0]==='stats'&&parts[1]==='world'){
        const d=await body(req);
        if(!d.world) return reply(res,400,{ok:false});
        // Записываем только официальные миры
        const OFFICIAL=['gather','parkour','volcano','space','race','dropper','obby','maze','pvp','hideseek','dungeon'];
        if(!OFFICIAL.includes(d.world)) return reply(res,200,{ok:true});
        if(!DB.stats) DB.stats={totalRegistered:0,totalSessions:0,worldPlays:{},dailyActive:{},firstSeenDates:[]};
        if(!DB.stats.worldPlays) DB.stats.worldPlays={};
        DB.stats.worldPlays[d.world] = (DB.stats.worldPlays[d.world]||0) + 1;
        saveDB();
        return reply(res,200,{ok:true});
    }

    // Bans
    if(req.method==='GET'&&parts[0]==='bans'){
        return reply(res,200,Object.values(DB.bans||{}));
    }
    if(req.method==='POST'&&parts[0]==='bans'){
        const d=await body(req);
        if(!d.name||!d.adminKey)return reply(res,403,{ok:false,error:'forbidden'});
        if(d.adminKey!=='citrus_admin_2025')return reply(res,403,{ok:false,error:'forbidden'});
        const key=d.name.toLowerCase();
        DB.bans[key]={name:d.name,reason:d.reason||'Нарушение правил',date:new Date().toLocaleDateString('ru'),by:d.by||'Разраб'};
        saveDB();
        wsClients.forEach(cl=>{
            if(cl.name===key)
                wsWrite(cl.socket,{type:'banned',reason:d.reason||'Нарушение правил',by:d.by||'Разраб'});
        });
        return reply(res,200,{ok:true});
    }
    if(req.method==='DELETE'&&parts[0]==='bans'&&parts[1]){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025')return reply(res,403,{ok:false,error:'forbidden'});
        delete DB.bans[parts[1].toLowerCase()]; saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='DELETE'&&parts[0]==='bans'&&!parts[1]){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025')return reply(res,403,{ok:false,error:'forbidden'});
        DB.bans={}; saveDB(); return reply(res,200,{ok:true});
    }
    if(req.method==='GET'&&parts[0]==='checkban'&&parts[1]){
        const key=decodeURIComponent(parts[1]).toLowerCase();
        const ban=DB.bans[key];
        return ban?reply(res,200,{banned:true,...ban}):reply(res,200,{banned:false});
    }

    // ══════════ ПОДДЕРЖКА ══════════

    // GET /support?adminKey=... — все письма (разраб)
    if(req.method==='GET'&&parts[0]==='support'&&!parts[1]){
        const key=url.searchParams.get('adminKey');
        if(key!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        if(!DB.support) DB.support={};
        const letters = Object.values(DB.support).sort((a,b)=>b.ts-a.ts);
        return reply(res,200,letters);
    }
    // GET /support/player/:id — письма игрока
    if(req.method==='GET'&&parts[0]==='support'&&parts[1]==='player'){
        if(!DB.support) DB.support={};
        const pid=String(parts[2]);
        const letters = Object.values(DB.support).filter(l=>String(l.fromId)===pid).sort((a,b)=>b.ts-a.ts);
        return reply(res,200,letters);
    }
    // POST /support — отправить письмо
    if(req.method==='POST'&&parts[0]==='support'&&!parts[1]){
        const d=await body(req);
        if(!d.fromId||!d.text) return reply(res,400,{error:'bad'});
        if(!DB.support) DB.support={};
        const id='sup_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        DB.support[id]={id, fromId:String(d.fromId), fromName:d.fromName||'?',
            type:d.type||'help', text:d.text.trim().slice(0,1000),
            ts:Date.now(), reply:null, repliedAt:null};
        saveDB();
        return reply(res,200,{ok:true,id});
    }
    // POST /support/:id/reply — ответ разраба
    if(req.method==='POST'&&parts[0]==='support'&&parts[2]==='reply'){
        const d=await body(req);
        if(d.adminKey!=='citrus_admin_2025') return reply(res,403,{error:'forbidden'});
        if(!DB.support||!DB.support[parts[1]]) return reply(res,404,{error:'not found'});
        DB.support[parts[1]].reply = d.reply.trim().slice(0,1000);
        DB.support[parts[1]].repliedAt = Date.now();
        saveDB();
        return reply(res,200,{ok:true});
    }
    // DELETE /support/:id — удалить письмо
    if(req.method==='DELETE'&&parts[0]==='support'&&parts[1]){
        const d=await body(req);
        if(!DB.support||!DB.support[parts[1]]) return reply(res,404,{error:'not found'});
        const letter = DB.support[parts[1]];
        // Разраб или сам игрок
        const isAdmin = d.adminKey==='citrus_admin_2025';
        const isOwner = String(letter.fromId)===String(d.playerId);
        if(!isAdmin&&!isOwner) return reply(res,403,{error:'forbidden'});
        delete DB.support[parts[1]];
        saveDB();
        return reply(res,200,{ok:true});
    }

    // ═══ AI PROXY — Groq (бесплатно и быстро) ═══
    if(req.method==='POST'&&parts[0]==='ai-proxy'){
        const d=await body(req);
        if(!d.messages) return reply(res,400,{error:'bad'});
        const key=GROQ_KEY;
        if(!key){
            console.error('❌ GROQ_KEY не задан в Environment Variables!');
            return reply(res,500,{error:'GROQ_KEY not set on server'});
        }
        const messages=d.messages.map(m=>{
            if(typeof m.content==='string') return m;
            const text=(Array.isArray(m.content)?m.content:[m.content])
                .filter(b=>b&&b.type==='text').map(b=>b.text).join('\n');
            return {role:m.role,content:text||'...'};
        });
        const payload=JSON.stringify({
            model:'llama-3.1-8b-instant',
            max_tokens:1000,
            messages:[
                {role:'system',content:d.system||'Ты — ИИ Хелпер игры Citrus Online 🍊. Отвечай на языке пользователя, кратко и по делу.'},
                ...messages
            ]
        });
        return new Promise(resolve=>{
            const apiReq=https.request({
                hostname:'api.groq.com',
                path:'/openai/v1/chat/completions',
                method:'POST',
                headers:{'Content-Type':'application/json','Authorization':'Bearer '+key,'Content-Length':Buffer.byteLength(payload)}
            },apiRes=>{
                let s=''; apiRes.on('data',c=>s+=c);
                apiRes.on('end',()=>{
                    try{
                        const data=JSON.parse(s);
                        console.log('🤖 Groq status:',apiRes.statusCode);
                        if(data.error){
                            console.error('❌ Groq error:',JSON.stringify(data.error));
                            res.writeHead(200,H);
                            res.end(JSON.stringify({content:[{type:'text',text:'❌ Groq: '+(data.error.message||JSON.stringify(data.error))}]}));
                        } else {
                            const text=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content||'Пустой ответ от Groq.';
                            res.writeHead(200,H); res.end(JSON.stringify({content:[{type:'text',text}]}));
                        }
                    }catch(e){
                        console.error('❌ Groq parse error:',e.message,'raw:',s.slice(0,200));
                        reply(res,500,{error:'parse error: '+e.message});
                    }
                    resolve();
                });
            });
            apiReq.on('error',e=>{
                console.error('❌ Groq request error:',e.message);
                reply(res,502,{error:e.message});
                resolve();
            });
            apiReq.write(payload); apiReq.end();
        });
    }

    // ═══ AI HELPER — покупка/трата сообщений ═══
    if(req.method==='POST'&&parts[0]==='ai-helper'&&parts[1]==='buy'){
        const d=await body(req);
        if(!d.playerId) return reply(res,400,{error:'bad'});
        const p=DB.players[String(d.playerId)];
        if(!p) return reply(res,404,{error:'player not found'});
        if((p.balance||0)<1000) return reply(res,400,{ok:false,error:'not enough balance'});
        p.balance=(p.balance||0)-1000;
        if(!DB.aiHelper) DB.aiHelper={};
        const key=String(d.playerId);
        DB.aiHelper[key]={msgs:(DB.aiHelper[key]&&DB.aiHelper[key].msgs||0)+5};
        saveDB();
        return reply(res,200,{ok:true,balance:p.balance,msgsLeft:DB.aiHelper[key].msgs});
    }
    if(req.method==='POST'&&parts[0]==='ai-helper'&&parts[1]==='use'){
        const d=await body(req);
        if(!d.playerId) return reply(res,400,{error:'bad'});
        if(!DB.aiHelper) DB.aiHelper={};
        const key=String(d.playerId);
        const cur=(DB.aiHelper[key]&&DB.aiHelper[key].msgs)||0;
        if(cur<=0) return reply(res,400,{ok:false,error:'no messages left'});
        DB.aiHelper[key].msgs=cur-1;
        saveDB();
        return reply(res,200,{ok:true,msgsLeft:DB.aiHelper[key].msgs});
    }
    if(req.method==='GET'&&parts[0]==='ai-helper'&&parts[1]){
        if(!DB.aiHelper) DB.aiHelper={};
        return reply(res,200,{msgsLeft:(DB.aiHelper[String(parts[1])]&&DB.aiHelper[String(parts[1])].msgs)||0});
    }

    // HTTP fallback для igchat (когда WS временно недоступен)
    if(req.method==='POST'&&parts[0]==='igchat'){
        const d=await body(req);
        if(d&&d.map&&d.text){
            broadcastToMap(d.map,{type:'igchat',...d},d.id||'');
        }
        return reply(res,200,{ok:true});
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
        else if(len===127){len=Number(BigInt(data.readBigUInt64BE(2)));offset=10;}
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
        let header;
        if(len<126) header=Buffer.from([0x81,len]);
        else if(len<65536) header=Buffer.from([0x81,126,(len>>8)&0xff,len&0xff]);
        else {
            header=Buffer.alloc(10); header[0]=0x81; header[1]=127;
            const big=BigInt(len);
            for(let i=0;i<8;i++) header[9-i]=Number((big>>(BigInt(i)*8n))&0xffn);
        }
        socket.write(Buffer.concat([header,payload]));
    }catch(e){}
}
function wsWriteRaw(socket,payload){
    try{
        const len=payload.length;
        let header;
        if(len<126) header=Buffer.from([0x81,len]);
        else if(len<65536) header=Buffer.from([0x81,126,(len>>8)&0xff,len&0xff]);
        else {
            header=Buffer.alloc(10); header[0]=0x81; header[1]=127;
            const big=BigInt(len);
            for(let i=0;i<8;i++) header[9-i]=Number((big>>(BigInt(i)*8n))&0xffn);
        }
        socket.write(Buffer.concat([header,payload]));
    }catch(e){}
}
function wsPing(socket){
    try{ socket.write(Buffer.from([0x89,0x00])); }catch(e){}
}
function broadcastToMap(map,msg,exceptId){
    const encoded=Buffer.from(JSON.stringify(msg));
    wsClients.forEach(c=>{ if(String(c.map)===String(map)&&String(c.userId)!==String(exceptId)) wsWriteRaw(c.socket,encoded); });
}
function broadcastToSession(sessionId,msg,exceptId){
    wsClients.forEach(c=>{ if(c.studioSession===sessionId&&String(c.userId)!==String(exceptId))wsWrite(c.socket,msg); });
}

// Каждые 10 сек: пингуем клиентов и чистим позиции без живого WS
setInterval(()=>{
    const activeIds=new Set();
    wsClients.forEach(c=>{ if(c.userId) activeIds.add(String(c.userId)); });
    Object.keys(positions).forEach(id=>{
        if(!activeIds.has(String(id))){
            const p=positions[id];
            if(p&&p.map) broadcastToMap(p.map,{type:'leave',id},id);
            delete positions[id];
        }
    });
    wsClients.forEach(c=>wsPing(c.socket));
}, 10000);

server.on('upgrade',(req,socket)=>{
    wsHandshake(req,socket);
    const cid=Math.random().toString(36).slice(2);
    socket.setNoDelay(true); // Отключаем алгоритм Нейгла — пакеты идут сразу без буферизации
    const client={socket,map:null,userId:null,studioSession:null,lastPong:Date.now()};
    wsClients.set(cid,client);
    let buf=Buffer.alloc(0);
    socket.on('data',chunk=>{
        buf=Buffer.concat([buf,chunk]);
        while(buf.length>=2){
            const opcode=buf[0]&0x0f;
            if(opcode===0xA){ client.lastPong=Date.now(); buf=buf.slice(2); continue; } // pong
            if(opcode===0x8){
                if(client.userId&&client.map){ broadcastToMap(client.map,{type:'leave',id:client.userId},client.userId); delete positions[client.userId]; }
                wsClients.delete(cid); return;
            }
            let len=buf[1]&0x7f, hasMask=(buf[1]&0x80)!==0, hdrLen=2;
            if(len===126){if(buf.length<4)break; len=(buf[2]<<8)|buf[3]; hdrLen=4;}
            else if(len===127){if(buf.length<10)break; len=Number(BigInt(buf.readBigUInt64BE(2))); hdrLen=10;}
            const frameLen=hdrLen+(hasMask?4:0)+len;
            if(buf.length<frameLen)break;
            const frame=buf.slice(0,frameLen);buf=buf.slice(frameLen);
            const msg=wsRead(frame);
            if(!msg)continue;
            client.lastPong=Date.now();
            if(msg.type==='join'){
                client.userId=msg.id; client.map=msg.map; client.name=(msg.name||'').toLowerCase();
                // Шлём новому игроку позиции всех кто уже на карте
                Object.values(positions).forEach(p=>{
                    if(String(p.id)!==String(msg.id)&&String(p.map)===String(msg.map))
                        wsWrite(socket,{...p,type:'move'});
                });
                // Просим всех на карте прислать позицию новому игроку
                wsClients.forEach(c2=>{
                    if(c2.map&&String(c2.map)===String(msg.map)&&String(c2.userId)!==String(msg.id))
                        wsWrite(c2.socket,{type:'req_pos',for:msg.id});
                });
            }
            if(msg.type==='move'){
                client.map=msg.map;
                client.userId=client.userId||msg.id;
                positions[msg.id]={...msg,type:'move',ts:Date.now()};
                broadcastToMap(msg.map,msg,msg.id);
            }
            if(msg.type==='leave'){
                if(client.map) broadcastToMap(client.map,{type:'leave',id:msg.id},msg.id);
                delete positions[msg.id];
                client.map=null;
            }
            if(msg.type==='studio_join'){client.studioSession=msg.sessionId;client.userId=msg.userId;}
            if(msg.type==='studio_block'||msg.type==='studio_clear'){broadcastToSession(msg.sessionId,msg,msg.userId);}
            if(msg.type==='igchat'&&msg.map&&msg.text){
                // Обновляем map клиента на случай если он ещё не слал move
                if(msg.id) client.userId=client.userId||msg.id;
                if(msg.map) client.map=client.map||msg.map;
                broadcastToMap(msg.map,msg,msg.id);
            }
        }
    });
    const cleanup=()=>{
        if(client.userId&&client.map){ broadcastToMap(client.map,{type:'leave',id:client.userId},client.userId); delete positions[client.userId]; }
        wsClients.delete(cid);
    };
    socket.on('close',cleanup);
    socket.on('error',cleanup);
});

loadDB().then(()=>{
    server.listen(process.env.PORT||3000,()=>{
        console.log('🍊 Citrus backend OK');
        // Не даём серверу засыпать на Free плане Render
        const SELF = process.env.RENDER_EXTERNAL_URL||'';
        if(SELF){
            setInterval(()=>{
                https.get(SELF+'/ping',()=>{}).on('error',e=>console.log('ping err:',e.message));
                console.log('🏓 self-ping');
            }, 4*60*1000); // каждые 4 минуты
        }
    });
});
