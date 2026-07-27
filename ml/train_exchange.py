#!/usr/bin/env python3
"""학습 교환 — 선형 랭커 (단계 1 킬게이트용 최소 모델).

특징은 exchange-feats.js(JS 단일 소스)가 뽑은 것만 쓴다. 여기는 선형대수 전용.
목표: 후보별 점수 s=w·x, softmax(s)가 softmax(ev/τ)를 닮도록 (EV 소프트 타깃 —
argmax 원핫보다 라벨 잡음(세계 600개 표본오차)에 강함).

사용: node ml/exchange-feats.js < labels.jsonl | python3 ml/train_exchange.py > weights.json
"""
import json
import sys

import numpy as np

rows = [json.loads(l) for l in sys.stdin if l.strip()]
if len(rows) < 200:
    print(f'라벨 부족: {len(rows)}', file=sys.stderr)
    sys.exit(1)

TAU = 3.0          # EV 온도 — 3점 차이가 e배 가중
LR = 0.5
EPOCHS = 300
L2 = 1e-3

dim = len(rows[0]['X'][0])
w = np.zeros(dim)

# 홀드아웃 20%
rng = np.random.default_rng(7)
idx = rng.permutation(len(rows))
cut = int(len(rows) * 0.8)
train, val = [rows[i] for i in idx[:cut]], [rows[i] for i in idx[cut:]]


def soft(v):
    v = v - v.max()
    e = np.exp(v)
    return e / e.sum()


def eval_set(rs):
    """오라클 EV 기준: 모델 argmax가 고른 후보의 EV − keep(후보0) EV 평균"""
    gain, top1 = 0.0, 0
    for r in rs:
        X, ev = np.array(r['X']), np.array(r['ev'])
        pick = int(np.argmax(X @ w))
        gain += ev[pick] - ev[0]
        top1 += int(pick == int(r['k']))
    return gain / len(rs), top1 / len(rs)


best_w, best_gain = w.copy(), -1e9
for ep in range(EPOCHS):
    rng.shuffle(train)
    for r in train:
        X, ev = np.array(r['X']), np.array(r['ev'])
        p = soft(X @ w)
        t = soft(ev / TAU)
        grad = X.T @ (p - t) + L2 * w
        w -= LR * grad
    if (ep + 1) % 25 == 0:
        g, t1 = eval_set(val)
        print(f'ep{ep+1}: 홀드아웃 오라클이득 +{g:.2f} · top1 {100*t1:.0f}%', file=sys.stderr)
        if g > best_gain:
            best_gain, best_w = g, w.copy()

g_tr, t_tr = eval_set(train)
g_va, t_va = eval_set(val)
print(f'최종(현재 w): 학습 +{g_tr:.2f}/{100*t_tr:.0f}% · 홀드아웃 +{g_va:.2f}/{100*t_va:.0f}%', file=sys.stderr)
print(f'베스트 홀드아웃: +{best_gain:.2f}', file=sys.stderr)

json.dump({'w': [round(float(x), 6) for x in best_w],
           'note': 'exchange-feats.js features(hand,cand) 순서 그대로. s=w·x argmax.'},
          sys.stdout)
