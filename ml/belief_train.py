#!/usr/bin/env python3
"""믿음망 선행 검증 — 조건부 로짓(공유 가중치 w, 좌석별 φ에 softmax) 학습.

작게 시작하는 이유: 목적이 성능 극대화가 아니라 "학습 가능한 신호가 결정화 정확도를
얼마나 올리는가"의 하한 확인이다. 선형으로 안 되면 신호 자체가 약한 것이고,
되면 큰 모델은 더 잘한다.

사용: python3 ml/belief_train.py <train.jsonl> <test.jsonl> <out-weights.json>
"""
import json, sys
import numpy as np

def load(p):
    F, Y = [], []
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line: continue
        r = json.loads(line)
        F.append(r['f']); Y.append(r['y'])
    return np.array(F, dtype=np.float64), np.array(Y, dtype=np.int64)

Ftr, Ytr = load(sys.argv[1])
Fte, Yte = load(sys.argv[2])
n, S, D = Ftr.shape
print(f'훈련 {n:,}건 · 특징 {D}차원', file=sys.stderr)

w = np.zeros(D)
lr, lam = 0.5, 1e-4
idx = np.arange(n)
rng = np.random.default_rng(7)
for epoch in range(30):
    rng.shuffle(idx)
    for b0 in range(0, n, 4096):
        bi = idx[b0:b0+4096]
        Z = Ftr[bi] @ w                    # (b,3)
        Z -= Z.max(axis=1, keepdims=True)
        P = np.exp(Z); P /= P.sum(axis=1, keepdims=True)
        G = P.copy(); G[np.arange(len(bi)), Ytr[bi]] -= 1.0   # dL/dZ
        gw = np.einsum('bs,bsd->d', G, Ftr[bi]) / len(bi) + lam * w
        w -= lr * gw
    # epoch 평가
    Z = Fte @ w; Z -= Z.max(axis=1, keepdims=True)
    P = np.exp(Z); P /= P.sum(axis=1, keepdims=True)
    acc = (P.argmax(axis=1) == Yte).mean()
    nll = -np.log(P[np.arange(len(Yte)), Yte] + 1e-12).mean()
    if epoch % 5 == 4 or epoch == 0:
        print(f'epoch {epoch+1:2d}  holdout acc {acc*100:.2f}%  nll {nll:.4f}', file=sys.stderr)

# 기준선: 손패 크기 비례(= 균일 결정화의 기대 정확도)
cap = Fte[:, :, 0]
base = (cap.argmax(axis=1) == Yte).mean()
prop = (cap / cap.sum(axis=1, keepdims=True))[np.arange(len(Yte)), Yte].mean()
print(f'\n기준선(최대 손패 찍기) {base*100:.2f}% · 비례 기대 {prop*100:.2f}%', file=sys.stderr)
print(f'모델 holdout 정확도    {acc*100:.2f}%', file=sys.stderr)
json.dump({'w': w.tolist(), 'dim': D,
           'note': 'belief conditional logit — feat 순서는 ml/belief-gen.js feat()'},
          open(sys.argv[3], 'w'))
print('가중치 저장: ' + sys.argv[3], file=sys.stderr)
