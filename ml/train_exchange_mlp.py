#!/usr/bin/env python3
"""학습 교환 단계2 — 소형 MLP 랭커 (선형 +2.18의 포획량을 올린다).

구조: score(x) = w2·relu(W1·x + b1) + b2   (17 → H → 1, 후보별 점수화 후 argmax)
JS 이식이 자명한 2층이라 net-infer 없이도 몇 줄로 추론 가능. numpy 학습(torch 불필요).
목표는 선형과 동일한 EV 소프트 타깃(τ=3) — 라벨 잡음에 강함.

사용: node ml/exchange-feats.js < labels.jsonl | python3 ml/train_exchange_mlp.py > weights.json
"""
import json
import sys

import numpy as np

H = 24
TAU = 3.0
LR = 0.03
EPOCHS = 400
L2 = 1e-4
SEED = 7

rows = [json.loads(l) for l in sys.stdin if l.strip()]
if len(rows) < 1000:
    print(f'라벨 부족: {len(rows)}', file=sys.stderr)
    sys.exit(1)
print(f'라벨 {len(rows)}개, H={H}', file=sys.stderr)

rng = np.random.default_rng(SEED)
idx = rng.permutation(len(rows))
cut = int(len(rows) * 0.85)
train, val = [rows[i] for i in idx[:cut]], [rows[i] for i in idx[cut:]]

dim = len(rows[0]['X'][0])
W1 = rng.normal(0, 0.3, (H, dim)); b1 = np.zeros(H)
w2 = rng.normal(0, 0.3, H); b2 = 0.0


def soft(v):
    v = v - v.max()
    e = np.exp(v)
    return e / e.sum()


def scores(X):
    h = np.maximum(0.0, X @ W1.T + b1)      # (K,H)
    return h @ w2 + b2, h


def eval_set(rs):
    gain, top1 = 0.0, 0
    for r in rs:
        X, ev = np.array(r['X']), np.array(r['ev'])
        s, _ = scores(X)
        pick = int(np.argmax(s))
        gain += ev[pick] - ev[0]
        top1 += int(pick == int(r['k']))
    return gain / len(rs), top1 / len(rs)


best = None
best_gain = -1e9
for ep in range(EPOCHS):
    rng.shuffle(train)
    for r in train:
        X, ev = np.array(r['X']), np.array(r['ev'])
        s, h = scores(X)
        p, t = soft(s), soft(ev / TAU)
        d = p - t                            # (K,)
        # 역전파
        gw2 = h.T @ d + L2 * w2
        gb2 = d.sum()
        dh = np.outer(d, w2) * (h > 0)       # (K,H)
        gW1 = dh.T @ X + L2 * W1
        gb1 = dh.sum(0)
        W1 -= LR * gW1; b1 -= LR * gb1; w2 -= LR * gw2; b2 -= LR * gb2
    if (ep + 1) % 20 == 0:
        g, t1 = eval_set(val)
        print(f'ep{ep+1}: 홀드아웃 +{g:.2f} · top1 {100*t1:.0f}%', file=sys.stderr)
        if g > best_gain:
            best_gain = g
            best = (W1.copy(), b1.copy(), w2.copy(), float(b2))

g_tr, _ = eval_set(train)
print(f'최종: 학습 +{g_tr:.2f} · 베스트 홀드아웃 +{best_gain:.2f} (선형은 +1.30이었음)', file=sys.stderr)
W1b, b1b, w2b, b2b = best
json.dump({
    'arch': 'mlp1', 'H': H,
    'W1': [[round(float(x), 6) for x in row] for row in W1b],
    'b1': [round(float(x), 6) for x in b1b],
    'w2': [round(float(x), 6) for x in w2b],
    'b2': round(b2b, 6),
    'note': 'score = w2·relu(W1·x+b1)+b2, x = exchange-feats.js features(hand,cand)'
}, sys.stdout)
