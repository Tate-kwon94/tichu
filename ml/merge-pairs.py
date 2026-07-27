#!/usr/bin/env python3
"""승단전 로그 합산 — PAIRS(짝지은 라운드 점수차) 풀링 + 사전등록 판정.

사용: python3 ml/merge-pairs.py '<로그 글롭>' [기준점수차=4.17]
로컬 샤드 로그와 CI 아티팩트 로그 모두 같은 형식(eval-hybrid 출력)이다.
"""
import glob
import json
import math
import re
import statistics
import sys

pat = sys.argv[1] if len(sys.argv) > 1 else 'ci-logs/*.log'
bar = float(sys.argv[2]) if len(sys.argv) > 2 else 4.17

pairs, rounds, tot, wins, games, starv = [], 0, 0, 0, 0, []
files = sorted(glob.glob(pat))
done = 0
for f in files:
    txt = open(f).read()
    m = re.search(r'PAIRS (\[.*?\])', txt)
    if m:
        pairs += json.loads(m.group(1))
        done += 1
    m = re.search(r'PTS rounds=(\d+) total=(-?\d+)', txt)
    if m:
        rounds += int(m.group(1)); tot += int(m.group(2))
    m = re.search(r'games=(\d+) hyWins=(\d+)', txt)
    if m:
        games += int(m.group(1)); wins += int(m.group(2))
    m = re.search(r'perDecision=(\d+)', txt)
    if m:
        starv.append(int(m.group(1)))

if not pairs:
    print(f'완료 로그 없음 (파일 {len(files)}개 검사)')
    sys.exit(0)

n = len(pairs)
mean = sum(pairs) / n
se = statistics.stdev(pairs) / math.sqrt(n) if n > 1 else 99.0
lo, hi = mean - 1.96 * se, mean + 1.96 * se
print(f'### 승단전 합산 — 완료 로그 {done}/{len(files)}')
print(f'- 쌍 {n} · 게임 {games} · 라운드 {rounds}')
print(f'- 점수차: **{mean:+.2f} ± {se:.2f}** 점/라운드 (95% CI [{lo:+.2f}, {hi:+.2f}])')
print(f'- 환산 승률: {50 + mean * 0.72:.1f}%  (기준선 {bar:+.2f} = {50 + bar * 0.72:.0f}%)')
if games:
    print(f'- 명목 승률: {100 * wins / games:.1f}% ({wins}/{games})')
if starv:
    print(f'- perDecision: min {min(starv)} / max {max(starv)} (러너 간 속도 편차 확인용)')
ok = mean >= bar and lo > 0
print(f'\n**사전등록 판정: {"통과" if ok else "미달"}** '
      f'(점추정 {"≥" if mean >= bar else "<"} {bar:+.2f}, CI 하한 {"" if lo > 0 else "≤"}{"> 0" if lo > 0 else " 0"})')
