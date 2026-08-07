#!/usr/bin/env python3
"""독립 심판 샤드 집계 — 전체·플레이어별·유형별(광맥 지도)를 한 번에 낸다.

A) det+bot  = 종전(순환) 재현 대조군
B) true+bot = 믿음분포 순환만 제거
C) true+net = 이어두기 정책까지 교체  ← 주 판정

읽는 법: 사람우세가 50%에 가까우면 "봇과 다를 뿐 우열 없음",
        50%보다 크게 낮으면 사람이 실제로 약하다.
        평균이 0인데 승률이 낮으면 = 자주 조금 지고 가끔 크게 이긴다(분포가 다름).
"""
import glob, json, sys, math
from collections import defaultdict

pat = sys.argv[1] if len(sys.argv) > 1 else 'out/*.jsonl'
rows = []
for f in glob.glob(pat):
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass

if not rows:
    print('### 데이터 없음')
    sys.exit(0)


def stat(vals):
    v = [x for x in vals if x is not None]
    if len(v) < 2:
        return None
    m = sum(v) / len(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    se = sd / math.sqrt(len(v))
    pos = [x for x in v if x > 0]
    neg = [x for x in v if x < 0]
    return dict(n=len(v), m=m, se=se, sig=(abs(m / se) if se else 0),
                win=100 * len(pos) / len(v),
                avgwin=(sum(pos) / len(pos)) if pos else 0,
                avgloss=(sum(neg) / len(neg)) if neg else 0)


print('### 독립 심판 집계 — 갈린 수 %d건' % len(rows))
print()
print('| 조건 | n | 평균 ± SE | σ | 사람우세 | 이길때 | 질때 |')
print('|---|---|---|---|---|---|---|')
for label, key in [('A) det+bot (종전=순환)', 'gapA'),
                   ('B) true+bot (①제거)', 'gapB'),
                   ('C) true+net (①②제거) ★', 'gapC')]:
    s = stat([r.get(key) for r in rows])
    if not s:
        continue
    print('| %s | %d | %+.2f ± %.2f | %.1fσ | %.0f%% | %+.1f | %+.1f |'
          % (label, s['n'], s['m'], s['se'], s['sig'], s['win'], s['avgwin'], s['avgloss']))

print()
print('#### 플레이어별 (C 기준)')
print()
print('| 이름 | n | 평균 ± SE | σ | 사람우세 |')
print('|---|---|---|---|---|')
by = defaultdict(list)
for r in rows:
    by[r.get('who', '?')].append(r.get('gapC'))
for who, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
    s = stat(v)
    if not s or s['n'] < 10:
        continue
    print('| %s | %d | %+.2f ± %.2f | %.1fσ | %.0f%% |' % (who, s['n'], s['m'], s['se'], s['sig'], s['win']))

print()
print('#### 광맥 지도 — 사람이 이긴 수의 유형 (C 기준, 상위)')
print()
print('| 유형(진영·구간·요구·티츄) | n | 사람우세 | 우세시 총점 | 평균 |')
print('|---|---|---|---|---|')
tb = defaultdict(list)
for r in rows:
    c = r.get('cls') or {}
    tich = ('내티츄' if c.get('tMe') else '') + ('파트너티츄' if c.get('tPt') else '') + ('상대티츄' if c.get('tOp') else '')
    k = '%s·%s·%s·%s' % ('리드' if c.get('lead') else '따라', c.get('hand', '?'), c.get('req', '-'), tich or '-')
    tb[k].append(r.get('gapC'))
mine = []
for k, v in tb.items():
    s = stat(v)
    if not s or s['n'] < 8:
        continue
    tot = sum(x for x in v if x is not None and x > 0)
    mine.append((tot, k, s))
mine.sort(reverse=True, key=lambda t: t[0])
for tot, k, s in mine[:14]:
    print('| %s | %d | %.0f%% | %.0f | %+.1f |' % (k, s['n'], s['win'], tot, s['m']))

print()
print('*읽는 법: 평균이 0 근처인데 사람우세가 낮으면 "자주 조금 지고 가끔 크게 이긴다"는 뜻 —')
print('모방 재료는 그 이기는 소수 유형에 있다.*')
