#!/usr/bin/env python3
"""교환 전략 비교 샤드 로그(XD 줄)를 풀링해 유의 판정을 낸다.

XD 줄 형식: XD <전략> <평균차> <SE> <딜수> <비영딜수>
샤드마다 독립 딜이므로 딜 수 가중 평균 + 분산 합성(SE는 각 샤드 SE와 n으로 재구성).

사용: python3 ml/merge-xd.py 'ci-exch/**/*.log' [bar=0]
"""
import glob, sys, math
from collections import defaultdict

pat = sys.argv[1] if len(sys.argv) > 1 else 'ci-exch/*.log'
bar = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0

agg = defaultdict(lambda: {"n": 0, "sw": 0.0, "var": 0.0, "nz": 0})
files = glob.glob(pat, recursive=True)
for f in files:
    for line in open(f, errors='ignore'):
        if not line.startswith('XD '):
            continue
        p = line.split()
        if len(p) < 6:
            continue
        name, m, se, n, nz = p[1], float(p[2]), float(p[3]), int(p[4]), int(p[5])
        if n < 2:
            continue
        a = agg[name]
        a["n"] += n
        a["sw"] += m * n
        a["var"] += (se * se) * n * n     # Var(합) = SE²·n² 를 누적 → 풀링 SE = √Σ / N
        a["nz"] += nz

if not agg:
    print(f"XD 줄 없음 (검색 {len(files)}파일: {pat})")
    sys.exit(1)

print(f"[교환 전략 풀링 — {len(files)}개 로그]")
print(f"{'전략':<16}{'점/라운드차':>12}{'SE':>8}{'σ':>7}{'승률환산':>10}{'딜수':>10}{'비영딜':>9}")
for name, a in sorted(agg.items()):
    N = a["n"]
    mean = a["sw"] / N
    se = math.sqrt(a["var"]) / N
    sigma = mean / se if se > 0 else 0.0
    print(f"{name:<16}{mean:>+12.4f}{se:>8.4f}{sigma:>7.2f}{50 + mean * 0.72:>9.2f}%{N:>10,}{a['nz']:>9,}")

print()
for name, a in sorted(agg.items()):
    N = a["n"]
    mean = a["sw"] / N
    se = math.sqrt(a["var"]) / N
    lo, hi = mean - 2 * se, mean + 2 * se
    if bar:
        verdict = "통과" if lo > bar else ("미달" if hi < bar else "판정불가(구간이 기준을 걸침)")
        print(f"{name}: CI95 [{lo:+.3f}, {hi:+.3f}] vs 기준 {bar:+.2f} → {verdict}")
    else:
        verdict = "유의한 양수" if lo > 0 else ("유의한 음수" if hi < 0 else "0과 구분 불가")
        print(f"{name}: CI95 [{lo:+.3f}, {hi:+.3f}] → {verdict}")
