export const OFFICIAL = 'https://www.pf489.com/kasukabe/web/';
export function initialState() { return {conditions: [], subscriptions: [], events: [], lastRunner: null, runnerError: null}; }
export function validateCondition(c, catalog) {
  const item = catalog.find(x => x.id === c.catalogId);
  if (!item) throw Error('施設・部屋を選んでください');
  if (!Array.isArray(c.areas) || !c.areas.length || c.areas.some(a => !item.areas.includes(a))) throw Error('確認済みの面区分を選んでください');
  if (!Array.isArray(c.weekdays) || !c.weekdays.length || c.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw Error('曜日を選んでください');
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end > 1440 || c.end <= c.start) throw Error('時間帯が正しくありません');
  if (!Number.isInteger(c.minimum) || c.minimum < 120 || c.minimum > c.end-c.start) throw Error('連続時間は120分以上で、希望時間帯の長さ以内にしてください');
  for (const key of ['dateFrom','dateTo']) if (!/^\d{4}-\d{2}-\d{2}$/.test(c[key]) || new Date(c[key]+'T00:00:00Z').toISOString().slice(0,10) !== c[key]) throw Error('対象日が正しくありません');
  if (c.dateTo < c.dateFrom || (new Date(c.dateTo)-new Date(c.dateFrom))/86400000 > 120) throw Error('対象期間は120日以内です');
  return {id: typeof c.id === 'string' && /^[\w-]{1,60}$/.test(c.id) ? c.id : crypto.randomUUID(),
    catalogId: item.id, facility:item.facility, room:item.room, areas:[...new Set(c.areas)],
    weekdays:[...new Set(c.weekdays)], start:c.start,end:c.end,minimum:c.minimum,
    dateFrom:c.dateFrom,dateTo:c.dateTo, rolling:c.rolling===true, enabled:c.enabled===true, name:String(c.name||item.facility).slice(0,70)};
}
export function windowsFor(slots, c) {
  const groups = new Map(), out=[];
  for (const s of slots) if (c.areas.includes(s.area)) {
    if (!groups.has(s.area_key)) groups.set(s.area_key, []);
    groups.get(s.area_key).push(s);
  }
  for (const [key, group] of groups) {
    let run;
    const finish=()=> {if(run && run.end-run.start>=c.minimum) out.push(run);run=null;};
    for (const s of group.sort((a,b)=>a.start-b.start)) {
      // 予約の単位を切り取って表示しない。指定時間に完全に収まる枠だけを結合。
      if(s.state!=='available'||s.start<c.start||s.end>c.end) {finish();continue;}
      if(run && run.end===s.start) {run.end=s.end;run.cells.push(cellKey(s));}
      else {finish();run={area:s.area,area_key:key,start:s.start,end:s.end,cells:[cellKey(s)]};}
    }
    finish();
  }
  return out;
}
export const cellKey = s => `${s.area_key}|${s.start}|${s.end}`;
export function applyResult(state, input, now=Date.now()) {
  const c=state.conditions.find(c=>c.id===input.conditionId);
  if(!c || !c.enabled || c.revision!==input.revision) return {ignored:true};
  c.lastCheck=now;
  const fail=message=>{
    c.errors??={};c.errors[input.date||'general']=message;
    c.error=message;c.failures=(c.failures||0)+1;
    if(c.failures>=3 && now-(c.lastErrorNotice||0)>86400000) {
      enqueue(state,{kind:'error',title:'空き状況を確認できません',body:`${c.facility}・${c.room}\n取得失敗が続いています。アプリで状況を確認してください。`,conditionId:c.id},now);
      c.lastErrorNotice=now;
    }
    return {error:message};
  };
  if(input.error) return fail(String(input.error).slice(0,180));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date||'')||(!c.rolling&&(input.date<c.dateFrom||input.date>c.dateTo))) throw Error('対象期間外の結果です');
  const day=(new Date(input.date+'T00:00:00Z').getUTCDay()+6)%7;
  if(!c.weekdays.includes(day)) throw Error('対象曜日外の結果です');
  const slots=input.slots;
  if(!Array.isArray(slots)||!slots.length||slots.length>6000) return fail('空き表が空、または想定外の大きさです');
  const seen=new Set();
  for(const s of slots) {
    if(typeof s.area!=='string'||typeof s.area_key!=='string'||s.area.length>120||s.area_key.length>140||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end>1440||s.end<=s.start||!['available','booked','outside_application','conditional'].includes(s.state)) return fail('空き表に判定不能な項目があります');
    if(seen.has(cellKey(s))) return fail('空き表の区画が重複しています');seen.add(cellKey(s));
  }
  const filtered=slots.filter(s=>c.areas.includes(s.area));
  if(!filtered.length || c.areas.some(a=>!filtered.some(s=>s.area===a))) return fail('指定した面区分が表から消えています');
  const shape=filtered.map(cellKey).sort().join('\n');
  c.samples??={};
  const prev=c.samples[input.date];
  if(prev && prev.shape!==shape) return fail('表の構成が変わりました。面区分を再確認して条件を保存し直してください');
  const cells=Object.fromEntries(filtered.map(s=>[cellKey(s),s.state]));
  const windows=windowsFor(filtered,c);
  const changed=windows.filter(w=>w.cells.some(k=>!prev || prev.cells[k]!=='available'));
  if(changed.length) {
    const lines=changed.map(w=>`${input.date}（${'日月火水木金土'[new Date(input.date+'T00:00:00Z').getUTCDay()]}） ${time(w.start)}～${time(w.end)} ${w.area}`);
    // 暗号化後のPush上限を超えないよう、日付単位の本文も分割する。
    let body=`${c.facility}・${c.room}\n${prev?'新しく空きが出ました':'初回確認で空きが見つかりました'}\n`;
    for(const line of lines) {
      if(new TextEncoder().encode(body+line).length>2200) {enqueue(state,{kind:'availability',title:'春日部の施設に空き',body,conditionId:c.id},now);body=`${c.facility}・${c.room}\n`;}
      body+=line+'\n';
    }
    enqueue(state,{kind:'availability',title:'春日部の施設に空き',body,conditionId:c.id},now);
  }
  c.samples[input.date]={shape,cells,windows,checked:now};
  const today=new Date(now+9*3600000).toISOString().slice(0,10);
  for(const d of Object.keys(c.samples)) if(d<today||(!c.rolling&&d>c.dateTo)) delete c.samples[d];
  if(c.errors) {delete c.errors[input.date];for(const d of Object.keys(c.errors))if(d<today)delete c.errors[d];}
  c.lastSuccess=now;c.error=Object.values(c.errors||{})[0]||null;if(!c.error)c.failures=0;
  return {windows:windows.length, changed:changed.length};
}
export function time(m){return `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`;}
export function enqueue(state,data,now=Date.now()) {
  if(state.events.filter(e=>e.status==='pending'||e.status==='sending').length>=120) throw Error('通知待ちが上限です。通知設定を確認してください');
  state.events.push({...data,id:crypto.randomUUID(),created:now,status:'pending',attempts:0,retryAt:now,deliveries:{}});
  const pending=state.events.filter(e=>['pending','sending'].includes(e.status));
  state.events=[...state.events.filter(e=>!['pending','sending'].includes(e.status)).slice(-150),...pending];
}
export function compactInitial(state) {
  const groups=new Map();
  for(const e of state.events) {
    if(e.status!=='pending'||e.kind!=='availability'||!e.body.includes('初回確認で空きが見つかりました'))continue;
    const key=e.conditionId;
    if(!groups.has(key)){groups.set(key,e);continue;}
    const first=groups.get(key),addition=e.body.split('\n').slice(2).join('\n');
    first.confirmedFrom=first.confirmedFrom||first.created;
    first.confirmedTo=e.created;
    if(new TextEncoder().encode(first.body+addition).length<2200)first.body+=addition;
    else first.more=(first.more||0)+1;
    e.status='grouped';e.groupedInto=first.id;
  }
}
