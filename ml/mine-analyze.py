#!/usr/bin/env python3
"""발굴 스윕 집계 — 결정 유형별 (빈도 × 불일치율 × EV격차) 광맥 지도."""
import glob, json, sys
from collections import defaultdict

pat = sys.argv[1] if len(sys.argv) > 1 else 'ci-mine/*.jsonl'
rows = []
for f in glob.glob(pat):
    for line in open(f):
        try: rows.append(json.loads(line))
        except: pass
if not rows:
    print('데이터 없음'); sys.exit(0)

def key(c):
    return (('리드' if c['lead'] else '따라'), c['hand'], c['req'],
            'T내' if c['tMe'] else ('T파' if c['tPt'] else ('T상' if c['tOp'] else '-')),
            '폭' if c['bomb'] else '-')

agg = defaultdict(lambda: [0, 0, 0.0])   # n, disagree, gapSum(불일치시)
for r in rows:
    k = key(r['cls'])
    a = agg[k]; a[0] += 1
    if not r['agree'] and r.get('gap') is not None:
        a[1] += 1; a[2] += max(0.0, r['gap'])

N = len(rows)
dis = sum(1 for r in rows if not r['agree'])
print(f'결정 {N:,}개 · 불일치 {dis:,}개 ({100*dis/N:.1f}%)')
print(f'{"유형(진영·구간·요구·티츄·폭탄)":<38}{"n":>6}{"불일치":>8}{"평균격차":>9}{"총격차/1k결정":>13}')
rank = sorted(agg.items(), key=lambda kv: -kv[1][2])
for k, (n, d, gs) in rank[:18]:
    if n < 20: continue
    print(f'{"·".join(k):<38}{n:>6}{100*d/max(n,1):>7.0f}%{(gs/max(d,1)):>9.1f}{1000*gs/N:>13.1f}')
tot = sum(a[2] for a in agg.values())
print(f'\n총 양의 격차 합: {tot:.0f}점 / {N:,}결정 = 결정당 +{tot/N:.2f} (주의: 오라클 잡음 섞인 낙관 상한)')
