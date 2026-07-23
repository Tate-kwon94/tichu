#!/usr/bin/env python3
"""선언(라지/스몰 티츄) 모델 — 손패 → 1등 완주 확률 + EV 최적 임계 보정.
사용: .venv/bin/python train_declare.py <rounds.jsonl ...> --out-prefix data/declare
출력: declare-t.pt(14장→P(first)), declare-g.pt(8장→P(first)) + 보정 리포트
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn

SUITS = "SHDC"
RANK = {"2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
        "10": 10, "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14}
SPECIAL = {"MJ": 52, "DG": 53, "PH": 54, "DR": 55}

def card_idx(cid):
    if cid in SPECIAL:
        return SPECIAL[cid]
    return SUITS.index(cid[0]) * 13 + (RANK[cid[1:]] - 2)

def enc_hand(cards):
    v = np.zeros(56, dtype=np.float32)
    for c in cards:
        v[card_idx(c)] = 1.0
    return v

class TinyNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.f = nn.Sequential(nn.Linear(56, 64), nn.ReLU(),
                               nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1))
    def forward(self, x):
        return self.f(x).squeeze(-1)

def load(files):
    rows = []
    for f in files:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows

def train_one(rows, key, dev, epochs=6):
    X = torch.from_numpy(np.stack([enc_hand(r[key]) for r in rows]))
    y = torch.from_numpy(np.array([r["first"] for r in rows], dtype=np.float32))
    n = len(rows); cut = int(n * 0.9)
    net = TinyNet().to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3)
    for ep in range(epochs):
        net.train(); perm = torch.randperm(cut)
        for i in range(0, cut, 4096):
            idx = perm[i:i + 4096]
            xb, yb = X[idx].to(dev), y[idx].to(dev)
            loss = nn.functional.binary_cross_entropy_with_logits(net(xb), yb)
            opt.zero_grad(); loss.backward(); opt.step()
    net.eval()
    with torch.no_grad():
        pv = torch.sigmoid(net(X[cut:].to(dev))).cpu().numpy()
    yv = y[cut:].numpy()
    # AUC 근사(순위 기반)
    order = np.argsort(pv)
    ranks = np.empty_like(order, dtype=np.float64); ranks[order] = np.arange(len(pv))
    pos = yv == 1
    auc = (ranks[pos].mean() - (pos.sum() - 1) / 2) / max((~pos).sum(), 1) if pos.any() and (~pos).any() else 0.5
    return net, pv, yv, auc

def calibrate(pv, yv, reward, penalty):
    best = (0.5, -1e9)
    for t in np.arange(0.30, 0.90, 0.02):
        sel = pv >= t
        ev = np.where(sel, np.where(yv == 1, reward, -penalty), 0.0).mean()
        if ev > best[1]:
            best = (float(t), float(ev))
    return best

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rounds", nargs="+")
    ap.add_argument("--out-prefix", default="data/declare")
    args = ap.parse_args()
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    rows = load(args.rounds)
    print(f"rows {len(rows)}", flush=True)

    t0 = time.time()
    netT, pvT, yvT, aucT = train_one(rows, "h14", dev)
    tT, evT = calibrate(pvT, yvT, 100, 100)
    print(f"[스몰 티츄|14장] AUC {aucT:.3f}  최적임계 P>={tT:.2f}  EV {evT:+.2f}점/라운드  ({time.time()-t0:.0f}s)")
    base = np.mean([(100 if r["first"] else -100) if r["tichu"] == 100 else 0 for r in rows[int(len(rows)*0.9):]])
    print(f"  (현행 휴리스틱 선언의 홀드아웃 EV {base:+.2f}점/라운드)")

    netG, pvG, yvG, aucG = train_one(rows, "h8", dev)
    tG, evG = calibrate(pvG, yvG, 200, 200)
    print(f"[라지 티츄|8장]  AUC {aucG:.3f}  최적임계 P>={tG:.2f}  EV {evG:+.2f}점/라운드")

    torch.save(netT.state_dict(), args.out_prefix + "-t.pt")
    torch.save(netG.state_dict(), args.out_prefix + "-g.pt")
    json.dump({"tichuThreshold": tT, "grandThreshold": tG, "aucT": aucT, "aucG": aucG},
              open(args.out_prefix + "-calib.json", "w"))
    print("saved:", args.out_prefix + "-{t,g}.pt + calib")

if __name__ == "__main__":
    main()
