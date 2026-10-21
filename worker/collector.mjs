import {Parser} from 'htmlparser2';
import {OFFICIAL} from './model.mjs';

const clean=s=>s.replace(/\s+/gu,' ').trim();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class SiteError extends Error {
  constructor(status,retryAfter='') {super('公開照会の通信に失敗しました');this.status=status;this.retryAfter=retryAfter;}
}
export class SiteSessionError extends Error {
  constructor(){super('予約サイトの照会情報が失効したか、内部エラーが発生しました');this.name='SiteSessionError';this.code='session';}
}
const publicPage=url=>{
  try{const page=new URL(url).pathname.split('/').at(-1);return /^(?:Wg_[A-Za-z]+|StartPage)\.aspx$/i.test(page)?page:'公開照会画面';}catch{return '公開照会画面';}
};
function checkSiteUrl(url,source,operation) {
  const target=new URL(url),base=new URL(OFFICIAL);
  // 公式が返す既知の終了画面だけを認識する。遷移先へ送信せず新しい照会で復旧する。
  if(target.origin===base.origin&&!target.username&&!target.password&&target.pathname.toLowerCase()==='/kasukabe/web/internalerror.htm') {
    const e=new SiteSessionError();e.sitePage=publicPage(source);e.operation=operation;throw e;
  }
  if(target.origin!==base.origin||target.username||target.password||!target.pathname.startsWith(base.pathname))throw Error('公式照会サイト外への通信を停止しました');
}
export function parsePage(html) {
  const form={fields:{},controls:[],action:'',tables:[]};let table,row,cell;
  const parser=new Parser({
    onopentag(tag,a) {
      if(tag==='form')form.action=a.action||'';
      if(tag==='input'&&a.name) {
        form.controls.push(a);
        if(['hidden','text'].includes((a.type||'').toLowerCase()))form.fields[a.name]=a.value||'';
      }
      if(tag==='table'&&/^dlRepeat_ctl\d+_tpItem_dgTable$/.test(a.id||'')) {
        if(table)throw Error('空き表が入れ子になっています');
        table={id:a.id,rows:[]};
      }
      if(!table)return;
      if(tag==='tr')row=[];
      if(tag==='td'||tag==='th')cell=[];
      if(tag==='br'&&cell)cell.push(' ');
    },
    ontext(text) {if(cell)cell.push(text);},
    onclosetag(tag) {
      if(!table)return;
      if((tag==='td'||tag==='th')&&cell) {if(!row)throw Error('空き表の行がありません');row.push(clean(cell.join('')));cell=null;}
      if(tag==='tr'&&row) {table.rows.push(row);row=null;}
      if(tag==='table') {form.tables.push(table);table=null;}
    }
  },{decodeEntities:true,lowerCaseAttributeNames:true,lowerCaseTags:true});
  parser.end(html);
  return form;
}
function minutes(value) {
  const [h,m]=value.split(':').map(Number);
  if(h>24||m>59||(h===24&&m))throw Error('時刻が不正です');
  return h*60+m;
}
export function parseDetail(htmlOrForm,expectedDate=null,allowedAreas=null) {
  const {tables}=typeof htmlOrForm==='string'?parsePage(htmlOrForm):htmlOrForm;
  if(!tables.length)throw Error('時間帯別の表がありません');
  const out=[];
  for(const table of tables) {
    const rows=table.rows;if(!rows.length||rows[0].length<3)throw Error('時刻見出しが不足しています');
    const header=rows[0].map(s=>s.normalize('NFKC'));
    const m=header[0].match(/(\d{4})年(\d+)月(\d+)日/);
    if(!m)throw Error('照会日がありません');
    const day=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||(expectedDate&&day!==expectedDate))throw Error('照会日が一致しません');
    const times=header.slice(2).map(text=>{
      const t=text.replaceAll(' ','').match(/^(\d{1,2}:\d{2})[~〜～](\d{1,2}:\d{2})$/);
      if(!t)throw Error('時間帯の形式が変わりました');
      const start=minutes(t[1]),end=minutes(t[2]);if(end<=start)throw Error('時間帯の順番が不正です');
      return [start,end];
    });
    const occurrences=new Map();
    for(const r of rows.slice(1)) {
      if(r.length!==header.length)throw Error('時間帯と状態の個数が一致しません');
      const area=r[0],index=(occurrences.get(area)||0)+1;occurrences.set(area,index);
      if(allowedAreas&&!allowedAreas.includes(area))continue;
      for(let i=0;i<times.length;i++) {
        const symbol=r[i+2].normalize('NFKC').trim();
        const state={'○':'available','◯':'available','×':'booked','-':'outside_application','−':'outside_application','―':'outside_application','ー':'outside_application','△':'conditional','*':'unknown'}[symbol];
        if(!state)throw Error('未知の空き状態です');
        out.push({area,area_key:area+'#'+index,date:day,start:times[i][0],end:times[i][1],state});
      }
    }
  }
  return out;
}
export function parseSelectedDays(form,days,areas) {
  const tables=new Map();
  for(const table of form.tables) {
    const m=table.rows[0]?.[0]?.normalize('NFKC').match(/(\d{4})年(\d+)月(\d+)日/);
    if(!m)throw Error('照会日の見出しがありません');
    const date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    if(tables.has(date))throw Error('照会日が重複しています');tables.set(date,table);
  }
  if(tables.size!==days.length||days.some(d=>!tables.has(d)))throw Error('取得した日付が不足しています');
  return Object.fromEntries(days.map(date=>{
    try{return [date,parseDetail({tables:[tables.get(date)]},date,areas)];}
    catch(e){return [date,{error:String(e.message).slice(0,180),code:'parse'}];}
  }));
}
export function acceptanceEnd(sports,now=Date.now()) {
  const d=new Date(now+9*3600000);
  const released=d.getUTCDate()>15||(d.getUTCDate()===15&&d.getUTCHours()>=10);
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+(released?(sports?3:2):(sports?2:1))+1,0)).toISOString().slice(0,10);
}
export function targetDays(c,item,now=Date.now()) {
  const tomorrow=new Date(now+9*3600000+86400000).toISOString().slice(0,10);
  const start=c.rolling?tomorrow:[c.dateFrom,tomorrow].sort().at(-1);
  const end=c.rolling?acceptanceEnd(item.sports,now):[c.dateTo,acceptanceEnd(item.sports,now)].sort()[0];
  const days=[];
  for(let time=Date.parse(start+'T00:00:00Z');time<=Date.parse(end+'T00:00:00Z');time+=86400000) {
    const day=new Date(time);if(c.weekdays.includes((day.getUTCDay()+6)%7))days.push(day.toISOString().slice(0,10));
  }
  return days;
}
export function batches(days,span=14,maxDates=Infinity) {
  const out=[];let rest=[...days];
  while(rest.length) {const first=Date.parse(rest[0]);const group=rest.filter(d=>Date.parse(d)-first<span*86400000).slice(0,maxDates);out.push(group);rest=rest.slice(group.length);}
  return out;
}
export function calendarDays(form,room) {
  if(form.tables.length!==1)throw Error('施設一覧の表が変わりました');
  const rows=form.tables[0].rows,header=rows[0];
  const match=header?.[0]?.normalize('NFKC').match(/^(\d{4})年(\d{1,2})月(?:\s+全日)?$/);
  const found=rows.slice(1).flatMap((r,i)=>r[0]===room?[{row:r,index:i+2}]:[]);
  if(!match||found.length!==1||found[0].row.length!==header.length)throw Error('施設一覧の日付・部屋が一致しません');
  let year=Number(match[1]),month=Number(match[2]),previous=0;const result=new Map();
  for(let i=2;i<header.length;i++) {
    const day=header[i].normalize('NFKC').match(/^(\d{1,2})\s*([日月火水木金土])$/);
    if(!day)throw Error('施設一覧の日付形式が変わりました');
    const number=Number(day[1]);if(number<previous){month++;if(month>12){month=1;year++;}}previous=number;
    const date=new Date(Date.UTC(year,month-1,number));
    if(date.getUTCMonth()!==month-1||'日月火水木金土'[date.getUTCDay()]!==day[2])throw Error('施設一覧の日付と曜日が一致しません');
    result.set(date.toISOString().slice(0,10),{closed:found[0].row[i]==='休館',row:found[0].index});
  }
  return result;
}

export class SiteSession {
  constructor(siteFetch,snapshot=null,options={}) {
    this.siteFetch=siteFetch;this.url=snapshot?.url||OFFICIAL;this.requests=snapshot?.requests||0;
    this.cookies=new Map(snapshot?.cookies||[]);this.form=snapshot?.form||null;this.html='';
    this.period=snapshot?.period||options.period||'rbtnTwoWeek';
  }
  snapshot() {
    const keys=['id','name','type','value','pb','onclick','groupname','disabled'];
    const controls=this.form.controls.filter(c=>(c.type||'').toLowerCase()!=='hidden').map(c=>Object.fromEntries(keys.filter(k=>k in c).map(k=>[k,c[k]])));
    return {url:this.url,requests:this.requests,period:this.period,cookies:[...this.cookies],form:{fields:this.form.fields,controls,action:this.form.action}};
  }
  async read(path=null,data=null,operation='read') {
    if(this.requests)await wait(2000);
    let url=new URL(path||this.form?.action||this.url,this.url).href;
    let method=data?'POST':'GET',body=data?new URLSearchParams(data).toString():undefined;
    for(let i=0;i<10;i++) {
      checkSiteUrl(url,this.url,operation);
      const headers={'User-Agent':'KasukabeAvailabilityMonitor/1.0 (personal read-only check)','Cookie':[...this.cookies].map(([k,v])=>k+'='+v).join('; ')};
      if(body)headers['Content-Type']='application/x-www-form-urlencoded';
      let response;const started=Date.now();
      try{response=await this.siteFetch(url,{method,body,headers,redirect:'manual',signal:AbortSignal.timeout(35000)});}
      catch(e){e.sitePage=publicPage(url);e.operation=operation;e.elapsedMs=Date.now()-started;throw e;}
      for(const raw of response.headers.getSetCookie?.()||response.headers.getAll?.('Set-Cookie')||[]) {
        const pair=raw.split(';')[0],at=pair.indexOf('=');if(at>0)this.cookies.set(pair.slice(0,at),pair.slice(at+1));
      }
      if([301,302,303,307,308].includes(response.status)) {
        url=new URL(response.headers.get('Location'),url).href;
        if([301,302,303].includes(response.status)) {method='GET';body=undefined;}
        await response.body?.cancel();continue;
      }
      if(!response.ok) {await response.body?.cancel();throw new SiteError(response.status,response.headers.get('Retry-After')||'');}
      try{this.html=await response.text();}
      catch(e){e.sitePage=publicPage(url);e.operation=operation;e.elapsedMs=Date.now()-started;throw e;}
      this.url=url;this.form=parsePage(this.html);this.requests++;return;
    }
    throw Error('画面転送が上限に達しました');
  }
  async click(id,updates={}) {
    const controls=this.form.controls.filter(c=>c.id===id);
    if(controls.length!==1)throw Error('照会画面の項目が変わりました');
    const c=controls[0],onclick=c.onclick||'';
    if(c.pb==='False'&&onclick.includes('CheckBox_OnClick')) {const key='h_'+c.name;this.form.fields[key]=this.form.fields[key]==='True'?'False':'True';return;}
    if(c.pb==='False'&&onclick.includes('RadioButton_OnClick')) {
      if(c.groupname)for(const other of this.form.controls)if(other.groupname===c.groupname)this.form.fields['h_'+other.name]='False';
      this.form.fields['h_'+c.name]='True';return;
    }
    const data={...this.form.fields,...updates};
    if(onclick.includes('__doPostBack'))Object.assign(data,{__EVENTTARGET:c.name,__EVENTARGUMENT:''});
    else if((c.type||'').toLowerCase()==='image') {data[c.name+'.x']='5';data[c.name+'.y']='5';}
    else data[c.name]=c.value||'';
    await this.read(null,data,id);
  }
  selectDay(target) {
    const key='h_'+target.replaceAll('$','_');
    if(!(key in this.form.fields))throw Error('指定日の公開照会欄がありません');
    this.form.fields[key]=this.form.fields.h_StringSelect+this.form.fields[key];
    this.form.fields.h_SelectedCnt=String(Number(this.form.fields.h_SelectedCnt||0)+1);
  }
}
export async function openOverview(s,item,day) {
  await s.read(OFFICIAL+'StartPage.aspx?StartPage=ModeSelect');
  await s.click('dlSSCategory_ctl'+(item.sports?'05':'00')+'_btnSSCategory');
  const name=item.sports?item.facility:item.facility+'　市民センター内';
  let found=false;
  for(let i=0;i<6;i++) {
    const match=s.form.controls.find(c=>c.value===name&&(c.id||'').includes('chkShisetsu'));
    if(match) {await s.click(match.id);found=true;break;}
    const next=s.form.controls.find(c=>c.id==='btnNextPage'&&!('disabled' in c));
    if(!next)break;await s.click(next.id);
  }
  if(!found)throw Error('公式の施設名が見つかりません');
  await s.click('ucPCFooter_btnForward');
  for(const c of s.form.controls)if((c.id||'').startsWith('rbtn'))s.form.fields['h_'+c.name]=[s.period||'rbtnTwoWeek','rbtnAllday'].includes(c.id)?'True':'False';
  const [y,m,d]=day.split('-');
  await s.click('ucPCFooter_btnForward',{txtYear:y,txtMonth:String(Number(m)),txtDay:String(Number(d))});
}
export async function collect(s,item,days,allowedAreas=item.areas) {
  if(s.requests) {
    if(s.url.includes('Wg_JikantaibetsuAkiJoukyou.aspx'))await s.click('ucPCFooter_btnBack');
    if(!s.url.includes('Wg_ShisetsubetsuAkiJoukyou.aspx'))throw Error('施設一覧に戻れません');
    const field=s.form.controls.find(c=>c.id==='ucTermSetting_txtDateFrom');
    if(!field)throw Error('期間の入力欄が見つかりません');
    await s.click('btnUpdate',{[field.name]:days[0].replaceAll('-','/')});
  } else await openOverview(s,item,days[0]);
  const calendar=calendarDays(s.form,item.room),closed=[],selected=[];
  for(const day of days) {
    const info=calendar.get(day);if(!info)throw Error('指定日が施設一覧から消えています');
    if(info.closed)closed.push(day);
    else {s.selectDay(`dlRepeat$ctl00$tpItem$dgTable$ctl${String(info.row).padStart(2,'0')}$b${day.replaceAll('-','')}`);selected.push(day);}
  }
  const results=Object.fromEntries(closed.map(day=>[day,{closed:true}]));
  if(!selected.length)return results;
  await s.click('ucPCFooter_btnForward');
  if(!s.url.includes('Wg_JikantaibetsuAkiJoukyou.aspx')||!s.html.includes(item.facility))throw Error('時間帯別の照会画面と一致しません');
  return {...results,...parseSelectedDays(s.form,selected,allowedAreas)};
}
