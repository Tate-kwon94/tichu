#!/usr/bin/env python3
"""3단 자가대전 RL — PPO + 오라클 상태 baseline + v6 KL 앵커.

과거 붕괴 두 원인을 정확히 친다:
  (1) 신호 노이즈 — 어드밴티지 = 라운드결과 − vhead(부분정보)였다. 라운드결과의 77%가
      비국소적(원투·4명 플레이)이라 부호가 잡음 → 정책이 위가 아니라 표류.
      → 완전정보 오라클 baseline(ov, gen-selfplay2가 god view로 기록)으로 그 분산을 걷어낸다.
      어드밴티지 = clip(out/100,±2) − ov. 근시안 없음: 신호는 여전히 진짜 롤아웃 결과.
  (2) 앵커 부재 — 클립은 스텝만 제한하고 고정점이 없어 세대 누적 드리프트. train_ppo엔 KL앵커 전무.
      → 동결 v6로의 forward-KL 페널티가 최적화 고정점을 v6(과다패스 안 함)에 못박는다.

사용: .venv/bin/python train_rl.py <sp.jsonl ...> --init cur.pt --ref v6.pt --out new.pt
      [--beta 0.4 --lr 5e-5 --clip 0.2 --ent 0.005 --epochs 2]
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import train_pilot as tp


def load_rl(files, cap=None):
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
                ret = np.float32(np.clip(r["out"] / 100.0, -2.0, 2.0))          # 오라클과 같은 /100 스케일
                ov = np.float32(r.get("ov", 0.0))                               # 완전정보 baseline (없으면 0)
                data.append((tp.enc_state(r),
                             np.stack([tp.enc_action(r, c) for c in r["cands"]]),
                             r["pick"], ret, np.float32(max(r["pb"], 1e-4)), ov))
                if cap and len(data) >= cap:
                    return data
    return data


def batches(data, bs, shuffle=True):
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
        ov = np.array([c[5] for c in chunk], dtype=np.float32)
        for bi, c in enumerate(chunk):
            a[bi, :len(c[1])] = c[1]
            m[bi, :len(c[1])] = True
        yield tuple(torch.from_numpy(x) for x in (s, a, m, y, ret, pb, ov))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--init", required=True)
    ap.add_argument("--ref", required=True, help="KL 앵커 기준(동결 v6)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent", type=float, default=0.005)
    ap.add_argument("--beta", type=float, default=0.4, help="KL(π_θ‖π_v6) 계수 초기값(적응형)")
    ap.add_argument("--kltarget", type=float, default=0.03, help="에폭당 목표 KL — β를 자동 조정해 이 값 유지")
    ap.add_argument("--betamin", type=float, default=0.05)
    ap.add_argument("--betamax", type=float, default=4.0)
    ap.add_argument("--klstop", type=float, default=0.10, help="평균 KL이 이 값 넘으면 에폭 조기중단(안전판)")
    ap.add_argument("--betaout", default=None, help="조정된 β를 이 파일에 기록(세대 간 이월)")
    ap.add_argument("--cap", type=int, default=None)
    args = ap.parse_args()
    beta = args.beta   # 적응형 — 에폭마다 측정 KL로 조정

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    sd0 = torch.load(args.init, map_location="cpu")
    width = sd0["se.0.bias"].shape[0] / 512.0                 # 체크포인트에서 폭 자동 감지(v6=2.0)
    print(f"모델 폭 {width}", flush=True)
    net = tp.Net(width).to(dev)
    net.load_state_dict(sd0)
    ref = tp.Net(width).to(dev)                               # 동결 v6 — 앵커
    ref.load_state_dict(torch.load(args.ref, map_location="cpu"))
    ref.eval()
    for prm in ref.parameters():
        prm.requires_grad_(False)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    t0 = time.time()

    for ep in range(args.epochs):
        net.train(); tot = {"pg": 0.0, "kl": 0.0, "e": 0.0, "eref": 0.0, "cl": 0.0, "adv": 0.0}; n = 0
        stop = False
        for f in args.train:
            data = load_rl([f], args.cap)
            for s, a, m, y, ret, pb, ov in batches(data, args.bs):
                s, a, m, y = s.to(dev), a.to(dev), m.to(dev), y.to(dev)
                ret, pb, ov = ret.to(dev), pb.to(dev), ov.to(dev)
                logit, _ = net(s, a, m)
                logp = nn.functional.log_softmax(logit, dim=1)
                p = logp.exp()
                lp_a = logp.gather(1, y.unsqueeze(1)).squeeze(1)
                ratio = (lp_a - pb.log()).exp()
                # 어드밴티지 = 진짜 롤아웃 결과 − 완전정보 오라클 baseline (분산 제거, 불편향)
                adv = (ret - ov).detach()
                adv = (adv - adv.mean()) / (adv.std() + 1e-6)
                un = ratio * adv
                cl = torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv
                pg = -torch.min(un, cl).mean()
                # forward-KL 앵커 → 동결 v6. 정책이 v6가 확률 준 공격수를 버리는 순간 벌.
                with torch.no_grad():
                    rlogit, _ = ref(s, a, m)
                    rlogp = nn.functional.log_softmax(rlogit, dim=1)
                    eref = -(rlogp.exp() * rlogp).masked_fill(~m, 0).sum(1).mean()
                kl = (p * (logp - rlogp)).masked_fill(~m, 0).sum(1).mean()
                ent = -(p * logp.masked_fill(~m, 0)).sum(1).mean()
                # 엔트로피 바닥: v6 엔트로피의 0.7 밑으로 떨어질 때만 개입(건강하면 0)
                ent_c = args.ent if ent.item() < 0.7 * eref.item() else 0.0
                loss = pg + beta * kl - ent_c * ent
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 2.0)
                opt.step()
                bsn = len(y)
                clipped = ((ratio < 1 - args.clip) | (ratio > 1 + args.clip)).float().mean().item()
                tot["pg"] += pg.item() * bsn; tot["kl"] += kl.item() * bsn
                tot["e"] += ent.item() * bsn; tot["eref"] += eref.item() * bsn
                tot["cl"] += clipped * bsn; tot["adv"] += adv.abs().mean().item() * bsn; n += bsn
            del data
            if tot["kl"] / max(n, 1) > args.klstop:            # 안전판: v6에서 너무 멀어짐
                stop = True; break
        meanKL = tot["kl"] / n
        # 적응형 KL: 측정 KL을 목표치로 유지하도록 β 자동 조정(PPO 표준). 내 추측 0.4를 원리로 대체.
        old_beta = beta
        if meanKL > args.kltarget * 1.5:   beta = min(beta * 2.0, args.betamax)
        elif meanKL < args.kltarget / 1.5: beta = max(beta / 2.0, args.betamin)
        print(f"epoch {ep+1}: pg {tot['pg']/n:+.4f}  KL {meanKL:.4f}  β {old_beta:.3f}→{beta:.3f}  "
              f"entropy {tot['e']/n:.3f}(v6 {tot['eref']/n:.3f})  |adv| {tot['adv']/n:.3f}  "
              f"clip율 {100*tot['cl']/n:.1f}%  n={n}  ({time.time()-t0:.0f}s){'  [KL안전정지]' if stop else ''}", flush=True)
        if stop:
            break

    torch.save(net.state_dict(), args.out)
    if args.betaout:
        with open(args.betaout, "w") as fh:
            fh.write(f"{beta:.4f}")
    print("saved:", args.out, f"β_next={beta:.3f}")


if __name__ == "__main__":
    main()
