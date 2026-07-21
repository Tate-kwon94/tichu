#!/usr/bin/env python3
"""PPO-lite 학습 — 클리핑된 서러게이트 + 가치 베이스라인 + 엔트로피.
행동확률(pb)을 기록한 자가대전 데이터로, 정책 이동을 클립 범위 안으로 제한
→ REINFORCE의 패스 쏠림 붕괴를 구조적으로 차단.
사용: .venv/bin/python train_ppo.py <selfplay.jsonl ...> --init <이전.pt> --out <새.pt>
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import train_pilot as tp

def load_ppo(files, cap=None):
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
                if "pick" not in r or "out" not in r or "pb" not in r or len(r.get("cands", [])) < 2:
                    continue
                data.append((tp.enc_state(r),
                             np.stack([tp.enc_action(r, c) for c in r["cands"]]),
                             r["pick"],
                             np.float32(np.clip(r["out"] / 200.0, -2.5, 2.5)),
                             np.float32(max(r["pb"], 1e-4))))
                if cap and len(data) >= cap:
                    return data
    return data

def ppo_batches(data, bs, shuffle=True):
    idx = np.random.permutation(len(data)) if shuffle else np.arange(len(data))
    for i in range(0, len(idx), bs):
        chunk = [data[j] for j in idx[i:i + bs]]
        K = max(len(c[1]) for c in chunk)
        B = len(chunk)
        s = np.stack([c[0] for c in chunk])
        a = np.zeros((B, K, tp.A_DIM), dtype=np.float32)
        m = np.zeros((B, K), dtype=bool)
        y = np.array([c[2] for c in chunk], dtype=np.int64)
        ret = np.array([c[3] for c in chunk], dtype=np.float32)
        pb = np.array([c[4] for c in chunk], dtype=np.float32)
        for bi, c in enumerate(chunk):
            a[bi, :len(c[1])] = c[1]
            m[bi, :len(c[1])] = True
        yield tuple(torch.from_numpy(x) for x in (s, a, m, y, ret, pb))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--init", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent", type=float, default=0.005)
    ap.add_argument("--cap", type=int, default=None)
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    net = tp.Net().to(dev)
    net.load_state_dict(torch.load(args.init, map_location="cpu"))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    t0 = time.time()

    for ep in range(args.epochs):
        net.train(); tot = {"pg": 0.0, "v": 0.0, "e": 0.0, "cl": 0.0}; n = 0
        for f in args.train:
            data = load_ppo([f], args.cap)
            for s, a, m, y, ret, pb in ppo_batches(data, args.bs):
                s, a, m, y = s.to(dev), a.to(dev), m.to(dev), y.to(dev)
                ret, pb = ret.to(dev), pb.to(dev)
                logit, val = net(s, a, m)
                logp = nn.functional.log_softmax(logit, dim=1)
                p = logp.exp()
                lp_a = logp.gather(1, y.unsqueeze(1)).squeeze(1)
                ratio = (lp_a - pb.log()).exp()
                adv = (ret - val).detach()
                adv = (adv - adv.mean()) / (adv.std() + 1e-6)
                un = ratio * adv
                cl = torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv
                pg = -torch.min(un, cl).mean()
                vloss = nn.functional.mse_loss(val, ret)
                ent = -(p * logp.masked_fill(~m, 0)).sum(1).mean()
                loss = pg + 0.5 * vloss - args.ent * ent
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 2.0)
                opt.step()
                bsn = len(y)
                clipped = ((ratio < 1 - args.clip) | (ratio > 1 + args.clip)).float().mean().item()
                tot["pg"] += pg.item() * bsn; tot["v"] += vloss.item() * bsn
                tot["e"] += ent.item() * bsn; tot["cl"] += clipped * bsn; n += bsn
            del data
        print(f"epoch {ep+1}: pg {tot['pg']/n:+.4f}  v_mse {tot['v']/n:.4f}  "
              f"entropy {tot['e']/n:.3f}  clip율 {100*tot['cl']/n:.1f}%  n={n}  ({time.time()-t0:.0f}s)", flush=True)

    torch.save(net.state_dict(), args.out)
    print("saved:", args.out)

if __name__ == "__main__":
    main()
