import {initialState, validateCondition, applyResult, enqueue, compactInitial, OFFICIAL} from './model.mjs';
import catalog from '../public/catalog.json' with {type:'json'};
const json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const enc=new TextEncoder();
async function digest(s) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function equal(a,b){return typeof a==='string'&&typeof b==='string'&&await digest(a)===await digest(b);}
async function sign(s,key) {const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function read(env) {const row=await env.DB.prepare('SELECT value,version FROM documents WHERE id=?').bind('app').first();return row?{state:JSON.parse(row.value),version:row.version}:{state:initialState(),version:-1};}
async function mutate(env, fn) {
  for(let i=0;i<5;i++) {
    const {state,version}=await read(env);const result=fn(state);
    const value=JSON.stringify(state);
    if(enc.encode(value).length>1600000) throw Error('保存容量のアプリ上限です。期間・条件数を減らしてください');
    const r=version===-1 ? await env.DB.prepare('INSERT OR IGNORE INTO documents(id,value,version) VALUES(?,?,0)').bind('app',value).run()
      :await env.DB.prepare('UPDATE documents SET value=?,version=version+1 WHERE id=? AND version=?').bind(value,'app',version).run();
    if(r.meta.changes) return result;
  }
  throw Error('他の操作と重なりました。少し待って再実行してください');
}
async function body(req) {if(Number(req.headers.get('content-length'))>1500000) throw Error('送信内容が大きすぎます');const text=await req.text();if(text.length>1500000) throw Error('送信内容が大きすぎます');return JSON.parse(text);}
async function authenticated(req,env) {
  const cookie=req.headers.get('cookie')||'';const token=cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if(!token)return false;const [expires,mac]=token.split('.');
  return Number(expires)>Date.now()&&Number(expires)<Date.now()+32*86400000&&await equal(mac,await sign(expires,env.SESSION_SECRET));
}
function publicState(state) {
  return {...state,subscriptions:state.subscriptions.map(s=>({id:s.id,created:s.created})),conditions:state.conditions.map(c=>{const {samples,...rest}=c;return {...rest,windows:Object.entries(samples||{}).flatMap(([date,x])=>x.windows.map(w=>({date,...w,checked:x.checked}))),scopeCount:Object.keys(samples||{}).length};})};
}
async function handle(req,env) {
  const url=new URL(req.url),p=url.pathname,now=Date.now();
  if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
  if(!env.ADMIN_PASSWORD_HASH||!env.SESSION_SECRET||!env.RUNNER_TOKEN) return json({error:'管理者の初期設定が完了していません'},503);
  if(req.method!=='GET'&&req.headers.get('origin')&&req.headers.get('origin')!==url.origin) return json({error:'別のサイトからの操作を拒否しました'},403);
  if(p==='/api/login' && req.method==='POST') {
    const ip=await digest(req.headers.get('CF-Connecting-IP')||'local');
    await env.DB.prepare('DELETE FROM login_attempts WHERE expires<?').bind(now).run();
    const attempts=await env.DB.prepare('SELECT attempts,expires FROM login_attempts WHERE id=?').bind(ip).first();
    if(attempts?.attempts>=8) return json({error:'15分待ってから再試行してください'},429);
    const b=await body(req);
    if(!await equal(await digest(String(b.password||'')),env.ADMIN_PASSWORD_HASH)) {
      await env.DB.prepare('INSERT INTO login_attempts(id,attempts,expires) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').bind(ip,now+900000).run();
      return json({error:'ログイン用パスワードが一致しません'},401);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE id=?').bind(ip).run();
    const expires=String(now+30*86400000);
    return json({ok:true},200,{'Set-Cookie':`session=${expires}.${await sign(expires,env.SESSION_SECRET)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`});
  }
  if(p.startsWith('/api/runner/')) {
    if(!await equal(req.headers.get('authorization'),`Bearer ${env.RUNNER_TOKEN}`))return json({error:'認証が必要です'},401);
    if(p==='/api/runner/start' && req.method==='POST') {
      const b=await body(req);
      const owner=crypto.randomUUID();
      const r=await env.DB.prepare('INSERT INTO locks(id,owner,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<? RETURNING owner').bind('runner',owner,now+25*60000,now).first();
      if(!r)return json({error:'前の確認が実行中です'},409);
      await mutate(env,s=>{s.lastRunner=now;s.lastRunnerSource=b.source==='github'?'github':'manual';s.runnerError=null;});
      const state=(await read(env)).state;
      return json({owner,retrySiteAt:state.retrySiteAt||0,conditions:state.conditions.filter(c=>c.enabled)});
    }
    const owner=req.headers.get('x-run-owner');const lock=await env.DB.prepare('SELECT owner,expires FROM locks WHERE id=?').bind('runner').first();
    if(!lock||lock.owner!==owner||lock.expires<now)return json({error:'実行ロックの期限切れです'},409);
    if(p==='/api/runner/result'&&req.method==='POST') {const b=await body(req);return json(await mutate(env,s=>applyResult(s,b,now)));}
    if(p==='/api/runner/coverage'&&req.method==='POST') {const b=await body(req);await mutate(env,s=>{const c=s.conditions.find(c=>c.id===b.id&&c.revision===b.revision);if(c){c.lastCycle=now;c.coverageEnd=b.end;c.scheduledDays=b.days;}});return json({ok:true});}
    if(p==='/api/runner/claim'&&req.method==='POST') {
      return json(await mutate(env,s=>{
        compactInitial(s);
        for(const old of s.events) if(old.status==='sending'&&old.lease<now&&old.attempts>=5){old.status='failed';old.error='送信処理が中断され再試行上限に達しました';}
        const e=s.events.find(e=>(e.status==='pending'||(e.status==='sending'&&e.lease<now))&&e.retryAt<=now&&e.attempts<5);
        if(!e||!s.subscriptions.length)return null;
        e.status='sending';e.attempts++;e.lease=now+120000;
        return {event:e,subscriptions:s.subscriptions.filter(x=>!e.deliveries[x.id]),official:OFFICIAL};
      }));
    }
    if(p==='/api/runner/ack'&&req.method==='POST') {
      const b=await body(req);await mutate(env,s=>{const e=s.events.find(e=>e.id===b.id);if(!e||e.status!=='sending')return;
        if(b.expired?.length) s.subscriptions=s.subscriptions.filter(x=>!b.expired.includes(x.id));
        for(const id of b.sent||[])e.deliveries[id]=now;
        if(!s.subscriptions.length) {e.status='failed';e.error='通知の登録が失効しました。iPhoneから通知を登録し直してください';}
        else if(s.subscriptions.every(x=>e.deliveries[x.id])) {e.status='sent';e.sentAt=now;e.error=null;}
        else {e.status=e.attempts>=5?'failed':'pending';e.retryAt=now+Math.min(6*3600000,60000*2**e.attempts);e.error='通知サービスへの送信に失敗。次回確認時に再試行します';}
      });return json({ok:true});
    }
    if(p==='/api/runner/end'&&req.method==='POST') {
      const b=await body(req);await mutate(env,s=>{s.lastRunnerEnd=now;s.runnerError=b.error?'監視処理が途中で終了しました。GitHub Actionsを確認してください':null;if(Number.isFinite(b.retrySiteAt))s.retrySiteAt=b.retrySiteAt;});
      await env.DB.prepare('DELETE FROM locks WHERE id=? AND owner=?').bind('runner',owner).run();return json({ok:true});
    }
    return json({error:'見つかりません'},404);
  }
  if(!await authenticated(req,env))return json({error:'ログインしてください'},401);
  if(p==='/api/logout'&&req.method==='POST')return json({ok:true},200,{'Set-Cookie':'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(p==='/api/state'&&req.method==='GET')return json({...publicState((await read(env)).state),schedulerReady:env.SCHEDULER_READY==='true',vapidPublicKey:env.VAPID_PUBLIC_KEY,githubUrl:env.GITHUB_REPO_URL||null});
  if(p==='/api/conditions'&&req.method==='POST') {
    const b=await body(req),c=validateCondition(b,catalog);
    return json(await mutate(env,s=>{
      const i=s.conditions.findIndex(x=>x.id===c.id);
      if(i<0&&s.conditions.length>=12)throw Error('条件は12件までです');
      const next={...c,revision:crypto.randomUUID(),samples:{},error:null,failures:0};
      if(i<0)s.conditions.push(next);else s.conditions[i]=next;
      s.events=s.events.filter(e=>e.conditionId!==c.id||!['pending','sending'].includes(e.status));
      return {ok:true,id:c.id};
    }));
  }
  if(p==='/api/condition-action'&&req.method==='POST') {
    const b=await body(req);await mutate(env,s=>{const c=s.conditions.find(c=>c.id===b.id);if(!c)throw Error('条件がありません');
      if(b.action==='delete')s.conditions=s.conditions.filter(c=>c.id!==b.id);
      else if(b.action==='toggle'){c.enabled=!c.enabled;c.revision=crypto.randomUUID();}
      else throw Error('操作が不正です');
      s.events=s.events.filter(e=>e.conditionId!==b.id||!['pending','sending'].includes(e.status));
    });return json({ok:true});
  }
  if(p==='/api/subscription'&&req.method==='POST') {
    const b=await body(req);const endpoint=new URL(b.endpoint);
    const host=endpoint.hostname;
    if(endpoint.protocol!=='https:'||endpoint.port||endpoint.username||endpoint.password||!(host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host.endsWith('.push.services.mozilla.com'))||endpoint.href.length>2500||typeof b.keys?.p256dh!=='string'||typeof b.keys?.auth!=='string'||!/^[\w-]{80,100}$/.test(b.keys.p256dh)||!/^[\w-]{20,30}$/.test(b.keys.auth))throw Error('対応する通知サービスの購読情報ではありません');
    await mutate(env,s=>{if(s.subscriptions.some(x=>x.subscription.endpoint===b.endpoint))return;
      if(s.subscriptions.length>=3)throw Error('通知端末は3台までです');
      s.subscriptions.push({id:crypto.randomUUID(),created:now,subscription:{endpoint:b.endpoint,keys:b.keys}});
    });return json({ok:true});
  }
  if(p==='/api/unsubscribe'&&req.method==='POST') {const b=await body(req);await mutate(env,s=>{s.subscriptions=s.subscriptions.filter(x=>x.id!==b.id);});return json({ok:true});}
  if(p==='/api/test'&&req.method==='POST') {
    await mutate(env,s=>{if(!s.subscriptions.length)throw Error('先にこのiPhoneの通知を許可してください');
      if(s.events.some(e=>e.kind==='test'&&now-e.created<60000))throw Error('テスト通知は1分待ってから再試行してください');
      enqueue(s,{kind:'test',title:'通知のテストです',body:'春日部の空き通知アプリから届きました。設定はクラウドに保存されています。'},now);
    });return json({ok:true});
  }
  return json({error:'見つかりません'},404);
}
export default {async fetch(req,env) {try {const r=await handle(req,env);r.headers.set('Referrer-Policy','no-referrer');r.headers.set('X-Frame-Options','DENY');return r;}catch(e){return json({error:e.message?.startsWith('D1')?'保存先でエラーが発生しました。無料枠と設定を確認してください':String(e.message||'処理に失敗しました').slice(0,200)},400);}}};
