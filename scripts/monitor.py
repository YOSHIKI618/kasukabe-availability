"""クラウドの条件を読み、公開照会して結果を返す。秘密や取得内容をログ出力しない。"""
import calendar
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import http.cookiejar
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from email.utils import parsedate_to_datetime

from availability import TableReader, parse_detail
from probe_site import Session, open_overview, BASE

JST = timezone(timedelta(hours=9))
CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'public/catalog.json').read_text(encoding='utf-8'))


def acceptance_end(sports, now=None):
    now = now or datetime.now(JST)
    months = (3 if sports else 2) if (now.day > 15 or (now.day == 15 and now.hour >= 10)) else (2 if sports else 1)
    y, m = divmod(now.year * 12 + now.month - 1 + months, 12)
    m += 1
    return date(y, m, calendar.monthrange(y, m)[1])


def target_days(c, item, now=None):
    now = now or datetime.now(JST)
    start = now.date()+timedelta(days=1) if c.get('rolling') else max(date.fromisoformat(c['dateFrom']), now.date() + timedelta(days=1))
    end = acceptance_end(item['sports'], now) if c.get('rolling') else min(date.fromisoformat(c['dateTo']), acceptance_end(item['sports'], now))
    return [start + timedelta(days=i) for i in range(max(0, (end-start).days+1))
            if (start + timedelta(days=i)).weekday() in c['weekdays']]


def batches(days):
    while days:
        first = days[0]
        selected = [d for d in days if (d-first).days < 14]
        yield selected
        days = days[len(selected):]


class BudgetSession(Session):
    total = 0
    started = 0

    def __init__(self):
        super().__init__()
        self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),CountRedirects())

    @classmethod
    def count_request(cls):
        if cls.total >= 500 or time.monotonic()-cls.started > 25*60:
            raise RuntimeError('access_budget')
        cls.total += 1

    def read(self, *args, **kwargs):
        BudgetSession.count_request()
        return super().read(*args, **kwargs)


class CountRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if not newurl.startswith(BASE):
            raise ValueError('unexpected_redirect')
        BudgetSession.count_request()
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def calendar_days(table, room):
    rows=table['rows']; header=rows[0]
    match=re.fullmatch(r'(\d{4})年(\d{1,2})月(?:\s+全日)?',header[0])
    found=[(i+2,row) for i,row in enumerate(rows[1:]) if row[0]==room]
    if not match or len(found)!=1 or len(found[0][1])!=len(header):
        raise ValueError('overview_dates_or_room')
    year,month=map(int,match.groups()); previous=0; result={}
    for index,label in enumerate(header[2:],2):
        day_match=re.fullmatch(r'(\d{1,2})\s*([日月火水木金土])',label)
        if not day_match:raise ValueError('overview_date_format')
        number=int(day_match[1])
        if number<previous:
            month+=1
            if month>12:month=1;year+=1
        previous=number
        current=date(year,month,number)
        if '月火水木金土日'[current.weekday()]!=day_match[2]:raise ValueError('overview_weekday')
        result[current.isoformat()]={'closed':found[0][1][index]=='休館','row':found[0][0]}
    return result


def collect(item, days, session=None, areas=None):
    s = session or BudgetSession()
    # 調査用Sessionの画面遷移ログも公開実行ログには出さない。
    with contextlib.redirect_stdout(io.StringIO()):
        if s.requests:
            if 'Wg_JikantaibetsuAkiJoukyou.aspx' in s.url:s.click('ucPCFooter_btnBack')
            if 'Wg_ShisetsubetsuAkiJoukyou.aspx' not in s.url:raise ValueError('overview_return')
            field=next(c['name'] for c in s.form.controls if c.get('id')=='ucTermSetting_txtDateFrom')
            s.click('btnUpdate',{field:days[0].strftime('%Y/%m/%d')})
        else:
            open_overview(s, item['facility'], days[0].isoformat(), 'rbtnTwoWeek')
        tables = TableReader(s.html).tables
        if len(tables) != 1:
            raise ValueError('overview_structure')
        calendar=calendar_days(tables[0],item['room']); selected=[]; results={}
        for day in days:
            info=calendar.get(day.isoformat())
            if not info:raise ValueError('missing_overview_date')
            if info['closed']:results[day.isoformat()]={'closed':True}
            else:
                s.select_day(f'dlRepeat$ctl00$tpItem$dgTable$ctl{info["row"]:02d}$b{day:%Y%m%d}')
                selected.append(day)
        if not selected:return results
        s.click('ucPCFooter_btnForward')
        if 'Wg_JikantaibetsuAkiJoukyou.aspx' not in s.url or item['facility'] not in s.html:
            raise ValueError('unexpected_page')
        slots = parse_detail(s.html,allowed_areas=item['areas'] if areas is None else areas)
    expected = {d.isoformat() for d in selected}
    if {s['date'] for s in slots} != expected:
        raise ValueError('missing_dates')
    return {**results,**{day: [s for s in slots if s['date'] == day] for day in expected}}


class API:
    def __init__(self):
        self.base = os.environ['APP_URL'].rstrip('/')
        if not self.base.startswith('https://') and not self.base.startswith('http://127.0.0.1:'):
            raise RuntimeError('invalid_app_url')
        self.owner = None

    def call(self, path, data=None):
        req = urllib.request.Request(self.base+'/api/runner/'+path, method='POST',
            data=json.dumps(data or {}, ensure_ascii=False).encode('utf-8'), headers={
                'Authorization':'Bearer '+os.environ['RUNNER_TOKEN'], 'Content-Type':'application/json','User-Agent':'KasukabeMonitor/1.0',
                'X-Run-Owner':self.owner or ''})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)


def deliver(api):
    from pywebpush import webpush, WebPushException
    pem = os.environ['VAPID_PRIVATE_KEY']
    with tempfile.TemporaryDirectory() as tmp:
        keyfile = Path(tmp)/'push.pem'
        keyfile.write_text(pem, encoding='ascii')
        for _ in range(80):
            if time.monotonic()-BudgetSession.started>28*60:
                break
            claim = api.call('claim')
            if not claim:
                break
            e = claim['event']
            confirmed = datetime.fromtimestamp(e['created']/1000, JST).strftime('%Y/%m/%d %H:%M')
            if e.get('confirmedTo'):
                confirmed += '～'+datetime.fromtimestamp(e['confirmedTo']/1000,JST).strftime('%H:%M')
            more='\nほか'+str(e['more'])+'件はアプリで確認できます。' if e.get('more') else ''
            payload = json.dumps({'id':e['id'],'title':e['title'],
                'body': e['body']+more+'\n確認・通知作成 '+confirmed+'（日本時間）\n公式予約：'+claim['official'],
                'url':api.base}, ensure_ascii=False)
            sent, expired = [], []
            for sub in claim['subscriptions']:
                try:
                    response = webpush(subscription_info=sub['subscription'], data=payload,
                        vapid_private_key=str(keyfile), vapid_claims={'sub':os.environ.get('VAPID_SUBJECT',api.base)},
                        ttl=3600, timeout=20)
                    if 200 <= response.status_code < 300:
                        sent.append(sub['id'])
                except WebPushException as e:
                    if e.response is not None and e.response.status_code in (404, 410):
                        expired.append(sub['id'])
                except Exception:
                    pass
            api.call('ack', {'id':claim['event']['id'],'sent':sent,'expired':expired})


def main():
    BudgetSession.started = time.monotonic()
    api = API()
    try:
        job = api.call('start',{'source':'github' if os.environ.get('GITHUB_ACTIONS')=='true' else 'manual',
                                'event':os.environ.get('GITHUB_EVENT_NAME','manual'),
                                'notifyOnly':os.environ.get('NOTIFY_ONLY')=='true'})
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print('A previous run is active; this run was skipped.')
            return
        raise
    api.owner = job['owner']
    failed = False
    retry_site_at=job.get('retrySiteAt',0)
    try:
        deliver(api)  # テストや前回の再試行を、長い巡回より先に配信。
        if os.environ.get('NOTIFY_ONLY') != 'true' and time.time()*1000>=retry_site_at:
            for c in job['conditions']:
                item = next(x for x in CATALOG if x['id'] == c['catalogId'])
                days = target_days(c, item)
                api.call('coverage',{'id':c['id'],'revision':c['revision'],'end':acceptance_end(item['sports']).isoformat(),'days':len(days)})
                session=BudgetSession()
                for group in batches(days):
                    try:
                        results = collect(item, group, session,c['areas'])
                        for day, slots in sorted(results.items()):
                            data={'closed':True} if isinstance(slots,dict) and slots.get('closed') else {'slots':slots}
                            posted=api.call('result', {'conditionId':c['id'],'revision':c['revision'],'date':day,**data})
                            if posted.get('error'):failed=True
                    except Exception as e:
                        failed = True
                        session=BudgetSession()
                        kind = type(e).__name__
                        error = ('アクセス・実行時間の上限に達しました' if isinstance(e,RuntimeError) else
                                 '通信が時間切れになりました' if isinstance(e,TimeoutError) else
                                 '公開照会の取得・解析に失敗しました（'+kind+'）')
                        for day in group:
                            api.call('result', {'conditionId':c['id'],'revision':c['revision'],'date':day.isoformat(),'error':error})
                        if isinstance(e,urllib.error.HTTPError) and e.code in (403,429):
                            delay=3600
                            value=e.headers.get('Retry-After','')
                            if value.isdigit():delay=max(delay,int(value))
                            elif value:
                                try:delay=max(delay,int(parsedate_to_datetime(value).timestamp()-time.time()))
                                except (ValueError,TypeError):pass
                            retry_site_at=int((time.time()+delay)*1000)
                            raise RuntimeError('site_access_restricted')
                        if isinstance(e,RuntimeError):
                            raise
                deliver(api)
        deliver(api)
    finally:
        api.call('end', {'error':failed or time.time()*1000<retry_site_at,'retrySiteAt':retry_site_at})
    print('Monitor completed. Site requests: '+str(BudgetSession.total)+'. Check the private app for results.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # tracebacks can contain authenticated request objects. Never print secrets or subscription endpoints.
        print('Monitor failed. Open the private app and check cloud configuration and run status.', file=sys.stderr)
        sys.exit(1)
