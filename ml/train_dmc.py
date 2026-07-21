#!/usr/bin/env python3
"""DMC(DouZero식) 학습 — 자가대전 기록에서 Q(상황, 택한 수) ← 라운드 결과 회귀.
사용: .venv/bin/python train_dmc.py <selfplay.jsonl ...> --init <이전.pt> --out <새.pt> [--epochs 2]
train_pilot의 인코더·모델을 그대로 사용(아키텍처 호환 → net-infer.js 그대로 동작).
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import train_pilot as tp

def load_dmc(files, cap=None):
    """(state, action_taken, return) 만 추출 — 후보 전체가 필요 없어 가볍다"""
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
                    continue
                if "pick" not in r or "out" not in r or len(r.get("cands", [])) < 2:
                    continue
                data.append((tp.enc_state(r),
                             tp.enc_action(r, r["cands"][r["pick"]]),
                             np.float32(np.clip(r["out"] / 200.0, -2.5, 2.5))))
                if cap and len(data) >= cap:
                    return data
    return data

def dmc_batches(data, bs, shuffle=True):
    idx = np.random.permutation(len(data)) if shuffle else np.arange(len(data))
    for i in range(0, len(idx), bs):
        chunk = [data[j] for j in idx[i:i + bs]]
        s = torch.from_numpy(np.stack([c[0] for c in chunk]))
        a = torch.from_numpy(np.stack([c[1] for c in chunk])).unsqueeze(1)  # [B,1,A]
        m = torch.ones(len(chunk), 1, dtype=torch.bool)
        y = torch.from_numpy(np.array([c[2] for c in chunk], dtype=np.float32))
        yield s, a, m, y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--init", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=512)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--cap", type=int, default=None)   # 파일당 상한
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    net = tp.Net().to(dev)
    net.load_state_dict(torch.load(args.init, map_location="cpu"))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    t0 = time.time()

    for ep in range(args.epochs):
        net.train(); tl = n = 0
        for f in args.train:
            data = load_dmc([f], args.cap)
            for s, a, m, y in dmc_batches(data, args.bs):
                s, a, m, y = s.to(dev), a.to(dev), m.to(dev), y.to(dev)
                logit, _ = net(s, a, m)          # [B,1] — 택한 수의 Q
                loss = nn.functional.mse_loss(logit.squeeze(1), y)
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 5.0)  # 초기 스케일 급변 보호
                opt.step()
                tl += loss.item() * len(y); n += len(y)
            del data
        print(f"epoch {ep+1}: mse {tl/max(n,1):.4f}  n={n}  ({time.time()-t0:.0f}s)", flush=True)

    torch.save(net.state_dict(), args.out)
    print("saved:", args.out)

if __name__ == "__main__":
    main()
