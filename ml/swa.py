#!/usr/bin/env python3
"""SWA — 고원 구간 세대들의 가중치 평균.
트립와이어가 ±1.7로 시끄러워 개별 세대는 +2.3~+4.1로 튄다. 인접 SGD 반복의 평균은
개별 지점보다 나은 경우가 많다(고전적 SWA). 학습 0, 기존 .pt만 사용.
사용: .venv/bin/python swa.py <out.pt> <gen번호들...>
"""
import sys, torch
out = sys.argv[1]
gens = sys.argv[2:]
sds = [torch.load(f"data/rl3/gen{g}.pt", map_location="cpu") for g in gens]
avg = {k: sum(sd[k].float() for sd in sds) / len(sds) for k in sds[0]}
torch.save(avg, out)
print(f"SWA({','.join(gens)}) -> {out}")
