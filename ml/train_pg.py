#!/usr/bin/env python3
"""정책 그래디언트 학습 — REINFORCE + 가치 베이스라인 + 엔트로피 보너스.
모방학습과 같은 '후보 소프트맥스' 구조를 그대로 강화 → 워밍업 정책을 보존하며 개선.
(DMC의 'argmax가 안 둬본 수의 외삽 Q를 신뢰하는' 붕괴 모드를 회피)
사용: .venv/bin/python train_pg.py <selfplay.jsonl ...> --init <이전.pt> --out <새.pt>
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import train_pilot as tp

def load_pg(files, cap=None):
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
                             np.stack([tp.enc_action(r, c) for c in r["cands"]]),
                             r["pick"],
                             np.float32(np.clip(r["out"] / 200.0, -2.5, 2.5))))
                if cap and len(data) >= cap:
                    return data
    return data

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--init", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--ent", type=float, default=0.01)
    ap.add_argument("--cap", type=int, default=None)
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    net = tp.Net().to(dev)
    net.load_state_dict(torch.load(args.init, map_location="cpu"))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    t0 = time.time()

    for ep in range(args.epochs):
        net.train(); tp_, tv, te, n = 0, 0, 0, 0
        for f in args.train:
            data = load_pg([f], args.cap)
            for s, a, m, y, ret in tp.batches(data, args.bs):
                s, a, m, y, ret = s.to(dev), a.to(dev), m.to(dev), y.to(dev), ret.to(dev)
                logit, val = net(s, a, m)
                logp = nn.functional.log_softmax(logit, dim=1)
                p = logp.exp()
                # 어드밴티지 = 실제 결과 − 가치 예측(베이스라인). 배치 정규화로 안정화
                adv = (ret - val).detach()
                adv = (adv - adv.mean()) / (adv.std() + 1e-6)
                pg = -(logp.gather(1, y.unsqueeze(1)).squeeze(1) * adv).mean()
                vloss = nn.functional.mse_loss(val, ret)
                ent = -(p * logp.masked_fill(~m, 0)).sum(1).mean()
                loss = pg + 0.5 * vloss - args.ent * ent
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 2.0)
                opt.step()
                bsn = len(y)
                tp_ += pg.item() * bsn; tv += vloss.item() * bsn; te += ent.item() * bsn; n += bsn
            del data
        print(f"epoch {ep+1}: pg {tp_/n:+.4f}  v_mse {tv/n:.4f}  entropy {te/n:.3f}  n={n}  ({time.time()-t0:.0f}s)", flush=True)

    torch.save(net.state_dict(), args.out)
    print("saved:", args.out)

if __name__ == "__main__":
    main()
