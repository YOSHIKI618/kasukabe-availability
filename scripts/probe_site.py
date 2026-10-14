"""公開の空き照会のみを低頻度で検証する。予約・ログイン機能は持たない。"""
import argparse
import http.cookiejar
import json
import re
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from availability import TableReader, parse_detail

BASE = 'https://www.pf489.com/kasukabe/web/'


class Form(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.fields = {}
        self.controls = []
        self.links = []
        self.text = []
        self.action = ''
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'form':
            self.action = a.get('action', '')
        if tag == 'a':
            self.links.append(a)
        if tag == 'input' and a.get('name'):
            self.controls.append(a)
            if a.get('type', '').lower() in ('hidden', 'text'):
                self.fields[a['name']] = a.get('value', '')

    def handle_data(self, data):
        if data.strip():
            self.text.append(data.strip())


class Session:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.url = BASE
        self.requests = 0

    def read(self, path=None, data=None):
        if self.requests:
            time.sleep(2)
        url = urllib.parse.urljoin(self.url, path or self.form.action or self.url)
        if not url.startswith(BASE):
            raise ValueError('照会サイト外への通信を停止しました')
        req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data is not None else None,
                                     headers={'User-Agent': 'KasukabeAvailabilityResearch/0.1 (personal read-only check)'})
        with self.opener.open(req, timeout=30) as response:
            raw = response.read()
            self.url = response.url
            try:
                html = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                html = raw.decode('cp932')
        self.requests += 1
        self.form = Form(html)
        self.html = html
        print(f'{self.requests}: {self.url.rsplit("/", 1)[-1]}')

    def click(self, control_id, updates=None):
        controls = [a for a in self.form.controls if a.get('id') == control_id]
        if len(controls) != 1:
            raise ValueError(f'画面変更または項目不足: {control_id}')
        c = controls[0]
        if c.get('pb') == 'False' and ('CheckBox_OnClick' in c.get('onclick', '')):
            key = 'h_' + c['name']
            self.form.fields[key] = 'False' if self.form.fields.get(key) == 'True' else 'True'
            return
        if c.get('pb') == 'False' and 'RadioButton_OnClick' in c.get('onclick', ''):
            group = c.get('groupname')
            if group:
                for other in self.form.controls:
                    if other.get('groupname') == group:
                        self.form.fields['h_' + other['name']] = 'False'
            self.form.fields['h_' + c['name']] = 'True'
            return
        data = dict(self.form.fields)
        data.update(updates or {})
        if '__doPostBack' in c.get('onclick', ''):
            data.update(__EVENTTARGET=c['name'], __EVENTARGUMENT='')
        elif c.get('type', '').lower() == 'image':
            data[c['name'] + '.x'] = '5'
            data[c['name'] + '.y'] = '5'
        else:
            data[c['name']] = c.get('value', '')
        self.read(data=data)

    def postback(self, target):
        data = dict(self.form.fields)
        data.update(__EVENTTARGET=target, __EVENTARGUMENT='')
        self.read(data=data)

    def select_day(self, target):
        key = 'h_' + target.replace('$', '_')
        if key not in self.form.fields:
            raise ValueError('指定日の公開照会欄がありません')
        self.form.fields[key] = self.form.fields['h_StringSelect'] + self.form.fields[key]
        self.form.fields['h_SelectedCnt'] = str(int(self.form.fields.get('h_SelectedCnt', '0')) + 1)


def open_overview(s, facility, date, period='rbtnDay'):
    s.read(BASE + 'StartPage.aspx?StartPage=ModeSelect')
    category = '00' if facility.startswith(('中央公民館', '幸松地区公民館')) else '05'
    official_name = facility + '　市民センター内' if facility in ('中央公民館', '幸松地区公民館') else facility
    s.click(f'dlSSCategory_ctl{category}_btnSSCategory')
    for page in range(6):
        matches = [c for c in s.form.controls if c.get('value') == official_name and 'chkShisetsu' in c.get('id','')]
        if matches:
            s.click(matches[0]['id'])
            break
        next_button = [c for c in s.form.controls if c.get('id') == 'btnNextPage' and 'disabled' not in c]
        if not next_button:
            raise ValueError('公式の施設名が見つかりません: ' + facility)
        s.click('btnNextPage')
    else:
        raise ValueError('施設一覧が想定を超えました')
    s.click('ucPCFooter_btnForward')
    # このサイトの独自ラジオボタンは複数のhidden fieldを一組として送信する。
    for c in s.form.controls:
        if c.get('id', '').startswith('rbtn'):
            s.form.fields['h_' + c['name']] = 'True' if c['id'] in (period, 'rbtnAllday') else 'False'
    year, month, day = date.split('-')
    s.click('ucPCFooter_btnForward', {'txtYear': year, 'txtMonth': str(int(month)), 'txtDay': str(int(day))})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True, help='調査する日 YYYY-MM-DD（本番監視条件ではない）')
    parser.add_argument('--output', default='research/latest-probe.html')
    parser.add_argument('--facility', default='市民体育館')
    parser.add_argument('--room', help='公式の部屋名。省略時は最初の部屋（調査専用）')
    parser.add_argument('--overview-only', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.date):
        parser.error('日付はYYYY-MM-DD形式')
    s = Session()
    open_overview(s, args.facility, args.date)
    if args.overview_only:
        print(json.dumps({'rooms': [[r[0] for r in t['rows'][1:]] for t in TableReader(s.html).tables]},ensure_ascii=False))
        return
    year, month, day = args.date.split('-')
    room_index = 2
    if args.room:
        rooms = TableReader(s.html).tables[0]['rows'][1:]
        matches = [i + 2 for i,r in enumerate(rooms) if r[0] == args.room]
        if len(matches) != 1:
            raise ValueError('公式の部屋名を一意に選べません')
        room_index = matches[0]
    target = f'dlRepeat$ctl00$tpItem$dgTable$ctl{room_index:02d}$b{year}{month}{day}'
    s.select_day(target)
    s.click('ucPCFooter_btnForward')
    if 'Wg_JikantaibetsuAkiJoukyou.aspx' not in s.url or args.facility not in s.html:
        raise ValueError('期待する詳細画面ではありません。空き判定を停止してください。')
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    # ViewStateやCookieは保存しない。表示表のみを調査資料にする。
    tables = re.findall(r'<table\b[^>]*id="dlRepeat_ctl\d+_tpItem_dgTable".*?</table>', s.html, flags=re.S | re.I)
    if not tables:
        raise ValueError('空き表がありません。画面変更の可能性があります。')
    out.write_text('<!doctype html><meta charset="utf-8"><title>公開照会の調査記録</title>' + '\n'.join(tables), encoding='utf-8')
    slots = parse_detail(out.read_text(encoding='utf-8'), args.date)
    print(json.dumps({'date': args.date, 'facility':args.facility, 'requests': s.requests,
                      'output': str(out), 'slots':len(slots), 'areas':list(dict.fromkeys(s['area'] for s in slots)),
                      'states':list(dict.fromkeys(s['state'] for s in slots))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
