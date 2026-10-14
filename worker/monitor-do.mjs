import catalog from '../public/catalog.json' with {type:'json'};
import {SiteSession,SiteError,collect,targetDays,batches,acceptanceEnd} from './collector.mjs';
import {makePushRequest} from './push.mjs';

const HOUR=3600000;
const fresh=()=>({enabled:false,nextMonitorAt:null,notificationSerial:0,handledNotificationSerial:0});
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
class MonitorError extends Error {constructor(code,status=0){super(code);this.code=code;this.status=status;}}
const safeError=e=>e instanceof SiteError?'公開照会の通信に失敗しました（HTTP '+e.status+'）':e instanceof MonitorError?{
  site_budget:'予約サイトへのアクセス回数・時間の上限に達しました',phase_budget:'一度の照会処理が上限に達しました',
  run_budget:'今回の確認が時間上限に達しました',api:'確認結果の保存先との通信に失敗しました',
  snapshot:'照会画面の状態が保存上限に達しました',stopped:'定期確認を停止しました'
}[e.code]||'クラウドの確認処理でエラーが発生しました':'公開照会の取得・解析に失敗しました。前回の正常結果を保持しています';

// 1人用に名前を固定し、本番のObjectは1個だけ作る。SQLite型の無料枠を利用。
export class AvailabilityMonitor {
  constructor(ctx,env,options={}) {this.ctx=ctx;this.env=env;this.transport=options.fetch||fetch;this.now=options.now||Date.now;this.calls=0;this.job=null;}
  async meta() {return await this.ctx.storage.get('meta')||fresh();}
  async changeMeta(fn) {return this.ctx.storage.transaction(async tx=>{const m=await tx.get('meta')||fresh();fn(m);await tx.put('meta',m);return m;});}
  async status() {
    const m=await this.meta(),job=await this.ctx.storage.get('job');
    return {...m,running:Boolean(job),notifyOnly:job?.notifyOnly||false,conditionIndex:job?.conditionIndex||0,conditionCount:job?.plans.length||0,
      siteRequests:await this.ctx.storage.get('siteCount')||0,alarmAt:await this.ctx.storage.getAlarm()};
  }
  async fetch(req) {
    const path=new URL(req.url).pathname;
    if(path==='/status')return response(await this.status());
    if(req.method!=='POST')return new Response('Not found',{status:404});
    const job=await this.ctx.storage.get('job');
    if(path==='/stop') {await this.changeMeta(m=>{m.enabled=false;});if(!job)await this.ctx.storage.deleteAlarm();return response({ok:true});}
    if(path==='/schedule') {
      const m=await this.changeMeta(m=>{if(!m.enabled||!m.nextMonitorAt)m.nextMonitorAt=this.now()+3000;m.enabled=true;});
      if(!job)await this.ctx.storage.setAlarm(Math.max(this.now()+1000,m.nextMonitorAt));
      return response({ok:true,nextMonitorAt:m.nextMonitorAt});
    }
    if(path==='/wake') {
      const m=await this.changeMeta(m=>{m.notificationSerial++;});
      if(!job)await this.ctx.storage.setAlarm(Math.min(m.enabled?(m.nextMonitorAt||this.now()+3000):Infinity,this.now()+3000));
      return response({ok:true});
    }
    return new Response('Not found',{status:404});
  }
  async outbound(kind,input,init) {
    if(kind==='site') {
      if(!(await this.meta()).enabled)throw new MonitorError('stopped');
      if(this.calls>=30||this.now()-this.phaseStart>5*60000)throw new MonitorError('phase_budget');
      if(this.job.siteRequests>=500||this.now()-this.job.started>25*60000)throw new MonitorError('site_budget');
      this.job.siteRequests++;await this.ctx.storage.put('siteCount',this.job.siteRequests);
    }
    if(this.calls>=48)throw new MonitorError('phase_budget');
    this.calls++;
    return kind==='api'&&this.env.APP_API?this.env.APP_API.fetch(input,init):this.transport(input,init);
  }
  async api(path,data={},job=this.job) {
    const req=new Request(this.env.SELF_URL+'/api/runner/'+path,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+this.env.RUNNER_TOKEN,'X-Run-Owner':job?.owner||'','User-Agent':'KasukabeMonitor/1.0'
    },body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
    const r=await this.outbound('api',req);
    if(!r.ok) {await r.body?.cancel();throw new MonitorError('api',r.status);}
    return r.json();
  }
  async deliver(excludeInitialFor=[],limit=2) {
    for(let i=0;i<limit&&this.calls<=33;i++) {
      const claim=await this.api('claim',{excludeInitialFor});if(!claim)return;
      const e=claim.event,sent=[],expired=[];
      const when=new Date(e.created).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
      const more=e.more?'\nほか'+e.more+'件はアプリで確認できます。':'';
      const payload={id:e.id,title:e.title,body:e.body+more+'\n確認・通知作成 '+when+'（日本時間）\n公式予約：'+claim.official,url:this.env.SELF_URL};
      for(const sub of claim.subscriptions) {
        try {
          const request=await makePushRequest(sub.subscription,payload,{privateKey:this.env.VAPID_PRIVATE_KEY,publicKey:this.env.VAPID_PUBLIC_KEY,subject:this.env.SELF_URL,now:this.now()});
          const r=await this.outbound('push',request.url,{method:'POST',headers:request.headers,body:request.body,redirect:'manual',signal:AbortSignal.timeout(15000)});
          if(r.ok)sent.push(sub.id);else if([404,410].includes(r.status))expired.push(sub.id);
          await r.body?.cancel();
        } catch { /* 失敗はackで永続的な再試行待ちにする。秘密を例外出力しない。 */ }
      }
      await this.api('ack',{id:e.id,sent,expired});
    }
  }
  async saveJob() {await this.ctx.storage.put('job',this.job);}
  excluded() {return this.job.plans.slice(this.job.conditionIndex).map(p=>p.condition.id);}
  async begin(meta) {
    const notifyOnly=!meta.enabled||(meta.nextMonitorAt||0)>this.now()+1000;
    const start=await this.api('start',{source:'cloudflare',event:'alarm',notifyOnly},null);
    const plans=notifyOnly?[]:start.conditions.map(c=>{
      const item=catalog.find(i=>i.id===c.catalogId);if(!item)throw new MonitorError('api');
      const condition=Object.fromEntries(['id','catalogId','revision','areas','weekdays','start','end','minimum','rolling','dateFrom','dateTo','name','facility','room'].map(k=>[k,c[k]]));
      const days=targetDays(condition,item,this.now());return {condition,item,groups:batches(days),days:days.length,end:acceptanceEnd(item.sports,this.now())};
    });
    this.job={owner:start.owner,started:this.now(),notifyOnly,plans,conditionIndex:0,groupIndex:0,siteRequests:0,
      failed:false,retrySiteAt:start.retrySiteAt||0,notificationSerialSeen:meta.notificationSerial};
    await this.ctx.storage.put('siteCount',0);await this.saveJob();
    await this.changeMeta(m=>{m.waitingForRun=false;if(!notifyOnly){m.lastError=null;m.nextMonitorAt=this.now()+HOUR;}});
  }
  async finish(error=null) {
    const job=this.job;if(!job)return;
    if(error)job.failed=true;
    try {await this.api('end',{error:job.failed||this.now()<job.retrySiteAt,retrySiteAt:job.retrySiteAt});}
    catch {error=error||new MonitorError('api');}
    await this.ctx.storage.delete(['job','session','pending','siteCount']);this.job=null;
    const m=await this.changeMeta(m=>{
      m.handledNotificationSerial=Math.max(m.handledNotificationSerial,job.notificationSerialSeen);
      m.lastCompletedAt=this.now();m.waitingForRun=false;
      if(!job.notifyOnly){m.lastSiteRequests=job.siteRequests;m.lastError=error?safeError(error):job.failed?'一部の対象日を取得できませんでした。条件ごとの取得エラーを確認してください':null;}
      if(m.enabled)m.nextMonitorAt=Math.max(m.nextMonitorAt||this.now()+HOUR,job.retrySiteAt||0,this.now()+3000);
    });
    await this.scheduleIdle(m);
  }
  async scheduleIdle(meta) {
    const next=meta.notificationSerial>meta.handledNotificationSerial?this.now()+3000:meta.enabled?Math.max(this.now()+1000,meta.nextMonitorAt||this.now()+HOUR):null;
    if(next)await this.ctx.storage.setAlarm(next);else await this.ctx.storage.deleteAlarm();
  }
  async processGroup() {
    const job=this.job,plan=job.plans[job.conditionIndex],c=plan.condition;
    if(job.groupIndex===0)await this.api('coverage',{id:c.id,revision:c.revision,end:plan.end,days:plan.days});
    if(!plan.groups.length) {job.conditionIndex++;await this.saveJob();return;}
    const days=plan.groups[job.groupIndex];
    let pending=await this.ctx.storage.get('pending');
    if(!pending) {
      const session=new SiteSession((url,init)=>this.outbound('site',url,init),await this.ctx.storage.get('session'));
      try {
        pending={results:await collect(session,plan.item,days),index:0,days};
        const snapshot=session.snapshot();
        if(new TextEncoder().encode(JSON.stringify(snapshot)).length>1900000)throw new MonitorError('snapshot');
        await this.ctx.storage.put('session',snapshot);await this.ctx.storage.put('pending',pending);
      } catch(e) {
        if(e instanceof MonitorError&&e.code==='stopped')throw e;
        job.failed=true;await this.ctx.storage.delete('session');
        for(const date of days)await this.api('result',{conditionId:c.id,revision:c.revision,date,error:safeError(e)});
        if(e instanceof SiteError&&[403,429].includes(e.status)) {
          const raw=e.retryAfter,delay=/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-this.now();
          job.retrySiteAt=this.now()+Math.max(HOUR,Number.isFinite(delay)?delay:HOUR);throw e;
        }
        if(e instanceof MonitorError&&['site_budget','snapshot'].includes(e.code))throw e;
      }
    }
    if(pending)for(;pending.index<days.length;) {
      const date=days[pending.index],result=await this.api('result',{conditionId:c.id,revision:c.revision,date,slots:pending.results[date]});
      if(result.error)job.failed=true;
      pending.index++;await this.ctx.storage.put('pending',pending);
    }
    await this.ctx.storage.delete('pending');job.groupIndex++;
    if(job.groupIndex>=plan.groups.length) {job.conditionIndex++;job.groupIndex=0;await this.ctx.storage.delete('session');}
    await this.saveJob();
  }
  async alarm() {
    this.calls=0;this.phaseStart=this.now();
    let meta=await this.meta();
    this.job=await this.ctx.storage.get('job');
    if(!this.job&&!meta.enabled&&meta.notificationSerial<=meta.handledNotificationSerial)return;
    if(!this.job&&(meta.nextMonitorAt||Infinity)>this.now()+1000&&meta.notificationSerial<=meta.handledNotificationSerial) {await this.scheduleIdle(meta);return;}
    // 予期しない終了や限定回数の自動再試行が尽きても、次の呼出しを残す。
    await this.ctx.storage.setAlarm(this.now()+12*60000);
    await this.changeMeta(m=>{m.lastAlarmAt=this.now();});
    try {
      if(!this.job) {
        try {await this.begin(meta);}catch(e) {
          if(e instanceof MonitorError&&e.status===409) {await this.changeMeta(m=>{m.waitingForRun=true;});await this.ctx.storage.setAlarm(this.now()+60000);return;}
          throw e;
        }
      }
      this.job.siteRequests=await this.ctx.storage.get('siteCount')||0;
      if(this.now()-this.job.started>30*60000)throw new MonitorError('run_budget');
      meta=await this.meta();this.job.notificationSerialSeen=meta.notificationSerial;
      await this.deliver(this.excluded(),this.job.notifyOnly?8:2);
      meta=await this.meta();
      if(this.job.notifyOnly||!meta.enabled||this.now()<this.job.retrySiteAt) {await this.finish();return;}
      if(this.job.conditionIndex<this.job.plans.length)await this.processGroup();
      await this.deliver(this.excluded());
      if(this.job.conditionIndex>=this.job.plans.length)await this.finish();
      else {await this.saveJob();await this.ctx.storage.setAlarm(this.now()+3000);}
    } catch(e) {
      if(this.job)await this.finish(e instanceof MonitorError&&e.code==='stopped'?null:e);
      else {meta=await this.changeMeta(m=>{m.lastError=safeError(e);if(m.enabled)m.nextMonitorAt=this.now()+HOUR;});await this.scheduleIdle(meta);}
    }
  }
}
