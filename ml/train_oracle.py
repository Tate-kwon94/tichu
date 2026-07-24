#!/usr/bin/env python3
"""오라클 가치망 학습 — 완전정보 국면 → 라운드 최종 점수차(클립 ±2) 회귀.

인코딩은 하지 않는다. shared/oracle-value.js가 뽑은 float32 바이너리를 그대로 읽는다
([290 특징][라벨] × N). 인코더가 한 곳뿐이라 JS/파이썬이 어긋날 수 없다.

사용: .venv/bin/python train_oracle.py <data.bin ...> --out oracle.pt [--h1 256 --h2 128]
"""
import argparse, time
import numpy as np
import torch
import torch.nn as nn

S_ORC = 290
REC = S_ORC + 1


class Oracle(nn.Module):
    def __init__(self, h1=256, h2=128):
        super().__init__()
        # 이름을 'o'로 두면 state_dict 키가 o.0/o.2/o.4 — export_weights.py와 oracle-value.js가 그대로 읽는다
        self.o = nn.Sequential(nn.Linear(S_ORC, h1), nn.ReLU(),
                               nn.Linear(h1, h2), nn.ReLU(),
                               nn.Linear(h2, 1))

    def forward(self, x):
        return self.o(x).squeeze(-1)


def open_maps(files):
    maps, total = [], 0
    for f in files:
        m = np.memmap(f, dtype=np.float32, mode="r")
        n = len(m) // REC
        maps.append(m[: n * REC].reshape(n, REC))
        total += n
    return maps, total


def shuffled_batches(maps, bs, pool=400_000, block=8192, rng=None, skip_mod=None, keep_mod=None):
    """섞기 버퍼: 무작위 블록들을 큰 풀에 모아 섞은 뒤 배치로 내보낸다.
    한 게임의 샘플들은 라벨이 같아 상관이 크므로, 블록만 섞으면 배치가 편향된다."""
    rng = rng or np.random.default_rng(0)
    blocks = [(mi, s) for mi, m in enumerate(maps) for s in range(0, len(m), block)]
    # 홀드아웃: 블록 단위로 나눠야 같은 게임이 학습/검증에 동시에 들어가지 않는다
    if skip_mod is not None:
        blocks = [b for i, b in enumerate(blocks) if i % skip_mod != keep_mod]
    else:
        blocks = list(blocks)
    rng.shuffle(blocks)
    bufx, bufy, have = [], [], 0
    for mi, s in blocks:
        m = maps[mi]
        arr = np.asarray(m[s : s + block])
        bufx.append(arr[:, :S_ORC]); bufy.append(arr[:, S_ORC]); have += len(arr)
        if have >= pool:
            X = np.concatenate(bufx); Y = np.concatenate(bufy)
            p = rng.permutation(len(X))
            X, Y = X[p], Y[p]
            for i in range(0, len(X) - bs + 1, bs):
                yield torch.from_numpy(X[i : i + bs].copy()), torch.from_numpy(Y[i : i + bs].copy())
            bufx, bufy, have = [], [], 0


def holdout(maps, block=8192, mod=20, keep=0, cap=200_000):
    xs, ys, n = [], [], 0
    for mi, m in enumerate(maps):
        for bi, s in enumerate(range(0, len(m), block)):
            if (bi + mi) % mod != keep:
                continue
            arr = np.asarray(m[s : s + block])
            xs.append(arr[:, :S_ORC]); ys.append(arr[:, S_ORC]); n += len(arr)
            if n >= cap:
                break
        if n >= cap:
            break
    return torch.from_numpy(np.concatenate(xs)), torch.from_numpy(np.concatenate(ys))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--h1", type=int, default=256)
    ap.add_argument("--h2", type=int, default=128)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--bs", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--init", default=None)
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    maps, total = open_maps(args.data)
    print(f"device {dev}  파일 {len(maps)}개  샘플 {total:,}", flush=True)

    vx, vy = holdout(maps)
    vvar = vy.var().item()
    # 주의: val MSE = (근사오차) + (줄일 수 없는 잡음)이라, 여기서 곧바로
    # "플레이아웃 몇 회분"을 읽을 수 없다. 그 비교는 ml/eval-oracle.js가
    # 플레이아웃 200회로 참값을 따로 추정해서 낸다.
    print(f"홀드아웃 {len(vy):,}  라벨 분산 {vvar:.4f} (= 상수 예측기의 MSE)", flush=True)
    vx, vy = vx.to(dev), vy.to(dev)

    net = Oracle(args.h1, args.h2).to(dev)
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location="cpu"))
        print("이어학습:", args.init)
    print("파라미터", sum(p.numel() for p in net.parameters()), flush=True)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    best, t0 = 1e9, time.time()
    for ep in range(args.epochs):
        net.train(); tot = n = 0
        rng = np.random.default_rng(1000 + ep)
        for x, y in shuffled_batches(maps, args.bs, rng=rng, skip_mod=20, keep_mod=0):
            x, y = x.to(dev), y.to(dev)
            loss = nn.functional.mse_loss(net(x), y)
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(y); n += len(y)
        sched.step()
        net.eval()
        with torch.no_grad():
            vm = nn.functional.mse_loss(net(vx), vy).item()
        r2 = 1 - vm / vvar
        star = ""
        if vm < best:
            best = vm; torch.save(net.state_dict(), args.out); star = " *저장"
        print(f"epoch {ep+1}: train {tot/n:.4f}  val {vm:.4f}  R² {r2*100:.1f}%{star}  "
              f"({time.time()-t0:.0f}s)", flush=True)

    print(f"best val {best:.4f}  saved: {args.out}")


if __name__ == "__main__":
    main()
