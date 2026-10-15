"""公開表の厳密な読取と、同一区画の連続時間判定。外部送信はしない。"""
import re
from collections import Counter
from datetime import date
from html.parser import HTMLParser
from unicodedata import normalize


class TableReader(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'table' and re.fullmatch(r'dlRepeat_ctl\d+_tpItem_dgTable', a.get('id','')):
            if self.table is not None:
                raise ValueError('予期しない表の入れ子')
            self.table = {'id': a['id'], 'rows': []}
        if self.table is None:
            return
        if tag == 'tr':
            self.row = []
        if tag in ('td', 'th'):
            self.cell = []
        if tag == 'br' and self.cell is not None:
            self.cell.append(' ')

    def handle_data(self, text):
        if self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if self.table is None:
            return
        if tag in ('td', 'th') and self.cell is not None:
            self.row.append(re.sub(r'\s+', ' ', ''.join(self.cell)).strip())
            self.cell = None
        if tag == 'tr' and self.row is not None:
            self.table['rows'].append(self.row)
            self.row = None
        if tag == 'table':
            self.tables.append(self.table)
            self.table = None


def minutes(value):
    h, m = map(int, value.split(':'))
    if not 0 <= h <= 24 or not 0 <= m < 60 or (h == 24 and m):
        raise ValueError('時刻が不正')
    return h * 60 + m


def parse_detail(html, expected_date=None, allowed_areas=None):
    tables = TableReader(html).tables
    if not tables:
        raise ValueError('時間帯別の表がありません（取得失敗・画面変更）')
    slots = []
    for table in tables:
        rows = table['rows']
        if not rows or len(rows[0]) < 3:
            raise ValueError('時刻見出しが不足')
        header = [normalize('NFKC', c) for c in rows[0]]
        match = re.search(r'(\d{4})年(\d+)月(\d+)日', header[0])
        actual_date = date(*map(int, match.groups())).isoformat() if match else None
        if not actual_date or (expected_date is not None and actual_date != expected_date):
            raise ValueError('照会日と取得日が一致しません')
        times = []
        for c in header[2:]:
            match = re.fullmatch(r'(\d{1,2}:\d{2})[~〜～]\s*(\d{1,2}:\d{2})', c.replace(' ', ''))
            if not match:
                raise ValueError('時間帯の形式が変わりました')
            start, end = map(minutes, match.groups())
            if end <= start:
                raise ValueError('時間の順番が不正')
            times.append((start, end))
        occurrences = Counter()
        for row in rows[1:]:
            if len(row) != len(header):
                raise ValueError('時間帯と状態の個数が不一致')
            label = row[0]
            occurrences[label] += 1
            if allowed_areas is not None and label not in allowed_areas:
                continue
            # 同名の面を混ぜない。同名行の番号は内部用であり公式の面名ではない。
            area_key = f'{label}#{occurrences[label]}'
            for (start, end), raw in zip(times, row[2:]):
                symbol = normalize('NFKC', raw).strip()
                state = {'○': 'available', '◯': 'available', '×': 'booked',
                         '-': 'outside_application', '−': 'outside_application',
                         '―': 'outside_application', 'ー': 'outside_application',
                         '△': 'conditional', '*': 'unknown'}.get(symbol)
                if state is None:
                    raise ValueError('未知の空き状態。空きなしには変換しません: ' + symbol)
                slots.append(dict(area=label, area_key=area_key, date=actual_date,
                                  start=start, end=end, state=state))
    return slots


def continuous_windows(slots, allowed_areas, start=540, end=1140, minimum=120):
    """同じarea_keyの○だけを結合。別の面への移動や△は空きとしない。"""
    result = []
    groups = {}
    for slot in slots:
        if slot['area'] not in allowed_areas:
            continue
        groups.setdefault((slot['date'], slot['area_key']), []).append(slot)
    for (day, key), group in groups.items():
        current = None
        for slot in sorted(group, key=lambda s: s['start']):
            a, b = max(start, slot['start']), min(end, slot['end'])
            if slot['state'] != 'available' or b <= a or slot['start'] < start or slot['end'] > end:
                if current and current['end'] - current['start'] >= minimum:
                    result.append(current)
                current = None
                continue
            if current and current['end'] == a:
                current['end'] = b
            else:
                if current and current['end'] - current['start'] >= minimum:
                    result.append(current)
                current = dict(date=day, area=slot['area'], area_key=key, start=a, end=b)
        if current and current['end'] - current['start'] >= minimum:
            result.append(current)
    return result
