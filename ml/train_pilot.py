#!/usr/bin/env python3
"""티츄 신경망 파일럿 — v15 탐색봇 기보 모방학습.
사용: .venv/bin/python train_pilot.py <train.jsonl ...> --val <val.jsonl> [--epochs 4]
출력: 홀드아웃 top-1 일치율(교사와 같은 수를 고르는 비율) + weights 저장.
"""
import argparse, json, math, sys, time
import numpy as np
import torch
import torch.nn as nn

SUITS = "SHDC"
TYPES = ["none", "single", "pair", "triple", "fullhouse", "straight",
         "pairseq", "bomb4", "bombstraight", "dog", "pass"]
T_IDX = {t: i for i, t in enumerate(TYPES)}
RANK = {"2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
        "10": 10, "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14}
SPECIAL = {"MJ": 52, "DG": 53, "PH": 54, "DR": 55}

def card_idx(cid):
    if cid in SPECIAL:
        return SPECIAL[cid]
    return SUITS.index(cid[0]) * 13 + (RANK[cid[1:]] - 2)

HIST_N = 12                                              # 최근 12수
HIST_F = 4 + len(TYPES) + 2                              # 상대좌석4 + 타입11 + 랭크·장수 = 17
S_BASE = 56 * 5 + 4 + 4 + 8 + 5 + 12 + 5 + 1 + 14 + 3   # = 336
S_DIM = S_BASE + HIST_N * HIST_F                         # = 540
A_DIM = 56 + len(TYPES) + 8                              # = 75

def rel(seat, other):
    """상대 좌석의 상대 위치: 0=나 1=오른쪽 2=파트너 3=왼쪽"""
    return (other - seat) % 4

def enc_state(r):
    v = np.zeros(S_DIM, dtype=np.float32)
    seat = r["seat"]
    for c in r["h"]:
        v[card_idx(c)] = 1.0
    played = set(r["played"])
    for c in played:
        v[56 + card_idx(c)] = 1.0
    if r.get("gave"):
        for to_s, c in r["gave"].items():
            if c in played:
                continue
            p = rel(seat, int(to_s))          # 1/2/3
            v[56 * (1 + p) + card_idx(c)] = 1.0
    o = 56 * 5
    for s in range(4):
        v[o + rel(seat, s)] = r["cnt"][s] / 14.0
    o += 4
    for s in r["fin"]:
        v[o + rel(seat, s)] = 1.0
    o += 4
    for s in range(4):
        t = r["tichu"][s]
        if t == 100: v[o + rel(seat, s)] = 1.0
        if t == 200: v[o + 4 + rel(seat, s)] = 1.0
    o += 8
    v[o + (rel(seat, r["fo"]) + 1 if r["fo"] is not None else 0)] = 1.0
    o += 5
    cur = r.get("cur")
    v[o + (T_IDX[cur["t"]] if cur else 0)] = 1.0
    if cur:
        v[o + 10] = min(cur["r"], 16) / 16.0
        v[o + 11] = cur["l"] / 14.0
    o += 12
    v[o + (rel(seat, r["win"]) + 1 if r["win"] is not None and r["win"] >= 0 else 0)] = 1.0
    o += 5
    v[o] = r.get("tp", 0) / 100.0
    o += 1
    w = r.get("wish")
    v[o + (w - 1 if w else 0)] = 1.0                     # none=0, 2..14 → 1..13
    o += 14
    my, op = (r["sc"][0], r["sc"][1]) if seat % 2 == 0 else (r["sc"][1], r["sc"][0])
    tgt = max(r.get("tgt", 500), 1)
    v[o] = my / tgt; v[o + 1] = op / tgt; v[o + 2] = (my - op) / tgt
    # 플레이 이력 — 시간순, 최신이 맨 끝. 짧으면 앞쪽 0 패딩
    hist = (r.get("hist") or [])[-HIST_N:]
    base = S_BASE + (HIST_N - len(hist)) * HIST_F
    for i, hh in enumerate(hist):
        p = base + i * HIST_F
        v[p + rel(seat, hh["s"])] = 1.0
        v[p + 4 + T_IDX[hh["t"]]] = 1.0
        v[p + 4 + 11] = min(hh["r"], 16) / 16.0
        v[p + 4 + 12] = hh["l"] / 14.0
    return v

def enc_action(r, cand):
    v = np.zeros(A_DIM, dtype=np.float32)
    n = len(r["h"])
    if cand["t"] == "pass":
        v[56 + T_IDX["pass"]] = 1.0
        return v
    for c in cand["c"]:
        v[card_idx(c)] = 1.0
    v[56 + T_IDX[cand["t"]]] = 1.0
    o = 56 + len(TYPES)
    v[o] = min(cand["r"], 16) / 16.0
    v[o + 1] = cand["l"] / 14.0
    v[o + 2] = (n - cand["l"]) / 14.0
    v[o + 3] = 1.0 if cand["l"] == n else 0.0            # 완주 수
    cs = set(cand["c"])
    v[o + 4] = 1.0 if "DR" in cs else 0.0
    v[o + 5] = 1.0 if "PH" in cs else 0.0
    v[o + 6] = 1.0 if "MJ" in cs else 0.0
    v[o + 7] = 1.0 if "DG" in cs else 0.0
    return v

def load(files, cap=None):
    data = []
    for f in files:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue                              # 생성 중 잘린 마지막 줄
                if len(r["cands"]) < 2:
                    continue
                data.append((enc_state(r),
                             np.stack([enc_action(r, c) for c in r["cands"]]),
                             r["pick"],
                             np.float32(np.clip(r.get("out", 0) / 200.0, -2, 2))))
                if cap and len(data) >= cap:
                    return data
    return data

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.se = nn.Sequential(nn.Linear(S_DIM, 512), nn.ReLU(),
                                nn.Linear(512, 256), nn.ReLU())
        self.ae = nn.Sequential(nn.Linear(A_DIM, 128), nn.ReLU())
        self.head = nn.Sequential(nn.Linear(256 + 128, 256), nn.ReLU(),
                                  nn.Linear(256, 1))
        self.vhead = nn.Sequential(nn.Linear(256, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, s, a_pad, mask):
        # s: [B,S]  a_pad: [B,K,A]  mask: [B,K] (True=실제 후보)
        z = self.se(s)                                    # [B,256]
        za = self.ae(a_pad)                               # [B,K,128]
        zz = z.unsqueeze(1).expand(-1, a_pad.size(1), -1)
        logit = self.head(torch.cat([zz, za], -1)).squeeze(-1)   # [B,K]
        logit = logit.masked_fill(~mask, -1e9)
        val = self.vhead(z).squeeze(-1)
        return logit, val

def batches(data, bs, shuffle=True):
    idx = np.random.permutation(len(data)) if shuffle else np.arange(len(data))
    for i in range(0, len(idx), bs):
        chunk = [data[j] for j in idx[i:i + bs]]
        K = max(len(c[1]) for c in chunk)
        B = len(chunk)
        s = np.stack([c[0] for c in chunk])
        a = np.zeros((B, K, A_DIM), dtype=np.float32)
        m = np.zeros((B, K), dtype=bool)
        y = np.array([c[2] for c in chunk], dtype=np.int64)
        v = np.array([c[3] for c in chunk], dtype=np.float32)
        for bi, c in enumerate(chunk):
            a[bi, :len(c[1])] = c[1]
            m[bi, :len(c[1])] = True
        yield (torch.from_numpy(s), torch.from_numpy(a),
               torch.from_numpy(m), torch.from_numpy(y), torch.from_numpy(v))

def evaluate(net, data, dev, bs=512):
    net.eval(); hit = tot = 0
    with torch.no_grad():
        for s, a, m, y, _ in batches(data, bs, shuffle=False):
            logit, _ = net(s.to(dev), a.to(dev), m.to(dev))
            hit += (logit.argmax(1).cpu() == y).sum().item()
            tot += len(y)
    return hit / max(tot, 1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--val", required=True)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--cap", type=int, default=None)
    ap.add_argument("--out", default="pilot-weights.pt")
    ap.add_argument("--init", default=None, help="이어학습: 기존 가중치에서 시작")
    ap.add_argument("--lr", type=float, default=1e-3)
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print("device:", dev)
    t0 = time.time()
    va = load([args.val], cap=40000)
    print(f"val {len(va)} decisions", flush=True)

    net = Net().to(dev)
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location="cpu"))
        print("init from:", args.init)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    print("params:", sum(p.numel() for p in net.parameters()))

    best = 0.0
    for ep in range(args.epochs):
        net.train(); tl = n = 0
        # 파일 단위 청크 로딩 — 8GB 램에서 50만+ 결정도 안전
        for f in args.train:
            data = load([f], args.cap)
            for s, a, m, y, v in batches(data, args.bs):
                s, a, m, y, v = s.to(dev), a.to(dev), m.to(dev), y.to(dev), v.to(dev)
                logit, val = net(s, a, m)
                loss = nn.functional.cross_entropy(logit, y) + 0.25 * nn.functional.mse_loss(val, v)
                opt.zero_grad(); loss.backward(); opt.step()
                tl += loss.item() * len(y); n += len(y)
            del data
        acc = evaluate(net, va, dev)
        star = ""
        if acc > best:
            best = acc; torch.save(net.state_dict(), args.out); star = " *저장"
        print(f"epoch {ep+1}: loss {tl/n:.4f}  val top-1 {acc*100:.1f}%{star}  ({time.time()-t0:.0f}s)", flush=True)

    print(f"best val top-1 {best*100:.1f}%  saved: {args.out}")

if __name__ == "__main__":
    main()
