import catalog from '../public/catalog.json' with {type:'json'};
import {SiteSession,SiteError,collect,targetDays,batches,acceptanceEnd} from './collector.mjs';
import {makePushRequest} from './push.mjs';
import {packStored,unpackStored} from './storage-codec.mjs';

const HOUR=3600000;
const fresh=()=>({enabled:false,nextMonitorAt:null,notificationSerial:0,handledNotificationSerial:0});
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
class MonitorError extends Error {constructor(code,status=0){super(code);this.code=code;this.status=status;}}
const safeError=e=>e instanceof SiteError?'公開照会の通信に失敗しました（HTTP '+e.status+'）':e instanceof MonitorError?{
  site_budget:'予約サイトへのアクセス回数・時間の上限に達しました',phase_budget:'一度の照会処理が上限に達しました',
  run_budget:'今回の確認が時間上限に達しました',api:'確認結果の保存先との通信に失敗しました',
  snapshot:'照会画面の状態が保存上限に達しました',stopped:'定期確認を停止しました'
}[e.code]||'クラウドの確認処理でエラーが発生しました':'公開照会の取得・解析に失敗しました。前回の正常結果を保持しています';
// 公開照会の実行環境の互換性診断。URLや長い状態値を保存・表示しない。
const diagnostic=e=>({name:String(e.name).slice(0,40),message:String(e.message).replace(/https?:\/\/\S+|[A-Za-z0-9_+/=-]{40,}/g,'[省略]').slice(0,180)});
export function errorKind(e) {
  if(e instanceof SiteError)return [403,429].includes(e.status)?'restricted':e.status===408||e.status>=500?'http_temporary':'http';
  if(e?.code==='api')return 'storage';
  if(['site_budget','phase_budget','run_budget','snapshot'].includes(e?.code))return 'budget';
  if(['AbortError','TimeoutError'].includes(e?.name)||/fetch failed|network|connection|timed? ?out|aborted/i.test(e?.message||''))return 'network';
  return 'parse';
}
const explained=e=>({network:'予約サイトとの通信が時間切れ、または一時的に切断されました',http_temporary:'予約サイトが一時的な通信エラーを返しました',restricted:'予約サイトのアクセス制限を検出したため確認を中断しました',storage:'確認結果の保存先との通信に失敗しました',budget:safeError(e),http:safeError(e),parse:'予約サイトの表示を判定できません：'+diagnostic(e).message}[errorKind(e)]);

// 1人用に名前を固定し、本番のObjectは1個だけ作る。SQLite型の無料枠を利用。
export class AvailabilityMonitor {
  constructor(ctx,env,options={}) {this.ctx=ctx;this.env=env;this.transport=options.fetch||((...args)=>fetch(...args));this.collector=options.collect||collect;this.now=options.now||Date.now;this.calls=0;this.job=null;}
  async meta() {return await this.ctx.storage.get('meta')||fresh();}
  async changeMeta(fn) {return this.ctx.storage.transaction(async tx=>{const m=await tx.get('meta')||fresh(),before=JSON.stringify(m);if(m.recentIssues)m.recentIssues=m.recentIssues.filter(x=>x.at>this.now()-14*86400000);fn(m);if(JSON.stringify(m)!==before)await tx.put('meta',m);return m;});}
  async status() {
    const m=await this.meta(),job=await this.ctx.storage.get('job');
    return {...m,implementation:'2026-10-16.2',retryAt:job?.phaseRetryAt||null,running:Boolean(job),notifyOnly:job?.notifyOnly||false,conditionIndex:job?.conditionIndex||0,conditionCount:job?.plans.length||0,
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
    if(job)job.apiRequests=(job.apiRequests||0)+1;
    const req=new Request(this.env.SELF_URL+'/api/runner/'+path,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+this.env.RUNNER_TOKEN,'X-Run-Owner':job?.owner||'','User-Agent':'KasukabeMonitor/1.0'
    },body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
    try {
      const r=await this.outbound('api',req);
      if(!r.ok) {await r.body?.cancel();throw new MonitorError('api',r.status);}
      return await r.json();
    } catch(e) {if(e instanceof MonitorError)throw e;throw new MonitorError('api');}
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
          await this.changeMeta(m=>{m.lastPushStatus=r.status;});
          if(r.ok)sent.push(sub.id);else if([404,410].includes(r.status))expired.push(sub.id);
          await r.body?.cancel();
        } catch(e) {await this.changeMeta(m=>{m.lastPushIssue={name:String(e.name).slice(0,40)};}); /* 秘密を例外出力しない。 */ }
      }
      await this.api('ack',{id:e.id,sent,expired});
    }
  }
  async saveJob() {await this.ctx.storage.put('job',this.job);}
  async savePacked(key,value) {
    const packed=await packStored(value);await this.ctx.storage.put(key,packed.value);
    this.job.maxRawBytes=Math.max(this.job.maxRawBytes||0,packed.rawBytes);
    this.job.maxStoredBytes=Math.max(this.job.maxStoredBytes||0,packed.storedBytes);
  }
  async issue(error,condition,days,retrying=false) {
    error.monitorRecorded=true;
    const detail=diagnostic(error),entry={id:crypto.randomUUID(),at:this.now(),conditionId:condition?.id||null,
      facility:condition?.facility||'クラウド全体',room:condition?.room||'',dates:[...days],unresolvedDates:[...days],
      code:errorKind(error),message:explained(error),status:error.status||null,retrying,detail};
    await this.changeMeta(m=>{if(!retrying)for(const old of m.recentIssues||[])if(old.conditionId===entry.conditionId&&!old.resolvedAt&&old.dates.some(d=>days.includes(d)))old.retrying=false;m.recentIssues=[...(m.recentIssues||[]).filter(x=>x.at>this.now()-14*86400000),entry].slice(-40);m.lastCollectionIssue=detail;});
    return entry.id;
  }
  async resolve(conditionId,days) {
    const good=new Set(days);
    await this.changeMeta(m=>{for(const e of m.recentIssues||[])if(!e.resolvedAt&&e.conditionId===conditionId){
      e.unresolvedDates=(e.unresolvedDates||e.dates).filter(d=>!good.has(d));if(!e.unresolvedDates.length){e.resolvedAt=this.now();e.retrying=false;}
    }});
  }
  excluded() {return this.job.plans.slice(this.job.conditionIndex).map(p=>p.condition.id);}
  async begin(meta) {
    const notifyOnly=!meta.enabled||(meta.nextMonitorAt||0)>this.now()+1000;
    const start=await this.api('start',{source:'cloudflare',event:'alarm',notifyOnly},null);
    if(start.protocol!==2){try{await this.api('end',{},start);}catch{}throw new MonitorError('api',503);}
    const plans=notifyOnly?[]:start.conditions.map(c=>{
      const item=catalog.find(i=>i.id===c.catalogId);if(!item)throw new MonitorError('api');
      const condition=Object.fromEntries(['id','catalogId','revision','areas','weekdays','start','end','minimum','rolling','dateFrom','dateTo','name','facility','room'].map(k=>[k,c[k]]));
      const recentLargeFailure=(meta.recentIssues||[]).some(e=>e.conditionId===c.id&&(e.dates||[]).length>4&&['network','http_temporary'].includes(e.code)&&e.at>this.now()-24*HOUR);
      const days=targetDays(condition,item,this.now()),small=(meta.smallBatchUntil?.[item.id]||0)>this.now()||recentLargeFailure;
      return {condition,item,period:small?'rbtnTwoWeek':'rbtnMonth',groups:batches(days,small?14:28,small?4:8),days:days.length,end:acceptanceEnd(item.sports,this.now())};
    });
    this.job={owner:start.owner,started:this.now(),notifyOnly,plans,conditionIndex:0,groupIndex:0,siteRequests:0,
      failed:false,retrySiteAt:start.retrySiteAt||0,notificationSerialSeen:meta.notificationSerial,apiRequests:1,alarms:0};
    await this.ctx.storage.put('siteCount',0);await this.saveJob();
    await this.changeMeta(m=>{m.waitingForRun=false;if(!notifyOnly){m.lastError=null;m.nextMonitorAt=this.now()+HOUR;}});
  }
  async finish(error=null) {
    const job=this.job;if(!job)return;
    if(error)job.failed=true;
    const stats={siteRequests:job.siteRequests,apiRequests:(job.apiRequests||0)+1,alarms:job.alarms||0,elapsedMs:this.now()-job.started,maxRawBytes:job.maxRawBytes||0,maxStoredBytes:job.maxStoredBytes||0};
    try {await this.api('end',{error:job.failed||this.now()<job.retrySiteAt,retrySiteAt:job.retrySiteAt,stats});}
    catch {error=error||new MonitorError('api');}
    await this.ctx.storage.delete(['job','session','pending','siteCount']);this.job=null;
    const m=await this.changeMeta(m=>{
      m.handledNotificationSerial=Math.max(m.handledNotificationSerial,job.notificationSerialSeen);
      m.lastCompletedAt=this.now();m.waitingForRun=false;
      if(!job.notifyOnly){m.lastStats=stats;m.lastSiteRequests=job.siteRequests;m.lastError=error?explained(error):job.failed?'一部の対象日を取得できませんでした。条件ごとの取得エラーを確認してください':null;if(!m.lastError)delete m.lastCollectionIssue;}
      if(!error&&!job.failed)for(const e of m.recentIssues||[])if(!e.conditionId&&!e.resolvedAt){e.resolvedAt=this.now();e.retrying=false;}
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
    let pending=await unpackStored(await this.ctx.storage.get('pending'));
    if(!pending) {
      const session=new SiteSession((url,init)=>this.outbound('site',url,init),await unpackStored(await this.ctx.storage.get('session')),{period:plan.period||'rbtnTwoWeek'});
      try {
        pending={results:await this.collector(session,plan.item,days,c.areas),index:0,days};
        const snapshot=session.snapshot();
        await this.savePacked('session',snapshot);await this.savePacked('pending',pending);
      } catch(e) {
        if(e instanceof MonitorError&&e.code==='stopped')throw e;
        const retryable=['network','http_temporary'].includes(errorKind(e));
        await this.issue(e,c,days,retryable&&!job.groupRetry);
        if(retryable&&!job.groupRetry) {
          job.groupRetry=1;job.phaseRetryAt=this.now()+30000;await this.ctx.storage.delete('session');
          if(plan.period==='rbtnMonth') {await this.changeMeta(m=>{m.smallBatchUntil??={};m.smallBatchUntil[plan.item.id]=this.now()+24*HOUR;});plan.groups.splice(job.groupIndex,plan.groups.length-job.groupIndex,...batches(plan.groups.slice(job.groupIndex).flat(),14,4));plan.period='rbtnTwoWeek';}
          await this.saveJob();return;
        }
        job.failed=true;await this.ctx.storage.delete('session');
        for(let i=0;i<days.length;i+=4)await this.api('results',{results:days.slice(i,i+4).map(date=>({conditionId:c.id,revision:c.revision,date,error:explained(e)}))});
        if(e instanceof SiteError&&[403,429].includes(e.status)) {
          const raw=e.retryAfter,delay=/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-this.now();
          job.retrySiteAt=this.now()+Math.max(HOUR,Number.isFinite(delay)?delay:HOUR);throw e;
        }
        if(e instanceof MonitorError&&['site_budget','snapshot'].includes(e.code))throw e;
      }
    }
    if(pending)for(;pending.index<days.length;) {
      const selected=days.slice(pending.index,pending.index+4),good=[];
      const payload=selected.map(date=>{const data=pending.results[date];return {conditionId:c.id,revision:c.revision,date,...(data?.error?{error:data.error}:data?.closed===true?{closed:true}:{slots:data})};});
      const response=await this.api('results',{results:payload});
      for(let i=0;i<selected.length;i++) {
        const data=pending.results[selected[i]],result=response.results[i];
        if(result.error){job.failed=true;await this.issue(Error(result.error),c,[selected[i]]);}
        else if(!result.ignored&&!data?.error)good.push(selected[i]);
      }
      if(good.length)await this.resolve(c.id,good);
      pending.index+=selected.length;await this.savePacked('pending',pending);
    }
    await this.ctx.storage.delete('pending');job.groupIndex++;job.groupRetry=0;job.phaseRetryAt=null;job.apiRetry=0;
    if(job.groupIndex>=plan.groups.length) {job.conditionIndex++;job.groupIndex=0;const next=job.plans[job.conditionIndex];if(!next||next.item.facility!==plan.item.facility||next.period!==plan.period)await this.ctx.storage.delete('session');}
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
      this.job.alarms=(this.job.alarms||0)+1;
      if(this.now()-this.job.started>30*60000)throw new MonitorError('run_budget');
      meta=await this.meta();this.job.notificationSerialSeen=meta.notificationSerial;
      await this.deliver(this.excluded(),this.job.notifyOnly?8:2);
      meta=await this.meta();
      if(this.job.notifyOnly||!meta.enabled||this.now()<this.job.retrySiteAt) {await this.finish();return;}
      if(this.job.phaseRetryAt>this.now()){await this.ctx.storage.setAlarm(this.job.phaseRetryAt);return;}
      this.job.phaseRetryAt=null;
      if(this.job.conditionIndex<this.job.plans.length)await this.processGroup();
      await this.deliver(this.excluded());
      if(this.job.conditionIndex>=this.job.plans.length)await this.finish();
      else {await this.saveJob();await this.ctx.storage.setAlarm(this.job.phaseRetryAt||this.now()+3000);}
    } catch(e) {
      if(!e.monitorRecorded&&!(e instanceof MonitorError&&e.code==='stopped'))await this.issue(e,null,[],Boolean(this.job&&e instanceof MonitorError&&e.code==='api'&&(e.status===0||e.status>=500)&&!this.job.apiRetry));
      if(this.job&&e instanceof MonitorError&&e.code==='api'&&(e.status===0||e.status>=500)&&!this.job.apiRetry) {
        this.job.apiRetry=1;this.job.phaseRetryAt=this.now()+30000;await this.saveJob();await this.ctx.storage.setAlarm(this.job.phaseRetryAt);return;
      }
      if(this.job)await this.finish(e instanceof MonitorError&&e.code==='stopped'?null:e);
      else {meta=await this.changeMeta(m=>{m.lastError=safeError(e);if(m.enabled)m.nextMonitorAt=this.now()+HOUR;});await this.scheduleIdle(meta);}
    }
  }
}
