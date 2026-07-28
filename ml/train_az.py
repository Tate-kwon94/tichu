#!/usr/bin/env python3
"""AZ 자가대전 학습 — 배포 PUCT의 방문 분포를 소프트 타깃으로 증류.

자기증류(v5·v7·v8, 전부 정체)와 무엇이 다른가:
  - 자기증류: 타깃 = argmax(방문). 결정당 1비트. 탐색이 "2순위도 거의 같았다"고 판단한 정보가 버려진다.
  - AZ:       타깃 = 방문 분포 전체. 탐색의 확신도까지 학습한다.
  기대 효과는 프라이어 캘리브레이션(§2): 현재 프라이어는 과확신이라 시뮬 84%가 1순위에 몰린다.
  분포를 맞추면 같은 예산에서 유효 탐색 폭이 넓어진다 — 이 가설이 참인지는 ml/gate-az.js가 먼저 판정.

가치헤드: 배포 PUCT는 말단을 휴리스틱 플레이아웃으로 평가하며 그 평가는 결정론적·정확하다는 것이
이미 확인됐다(로드맵 §0). 그래서 가치헤드를 플레이아웃 대체로 쓰지 않는다 — 진단·정규화용 보조
손실로만 학습한다(스케일은 RL·오라클과 같은 out/100 clip±2로 통일).

앵커: 동결 3단(swa13_18)으로의 forward-KL. AZ는 자기 자신의 탐색을 배우므로 폭주 위험이 RL보다
낮지만, 세대 누적 드리프트는 여전히 가능하다(RL2에서 raw만 오르고 실물은 0이던 경로).

사용: .venv/bin/python train_az.py <az.jsonl ...> --init cur.pt --ref swa13_18.pt --out gen1.pt
      [--epochs 2 --lr 5e-5 --beta 0.3 --vw 0.25]
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import train_pilot as tp


def load_az(files, cap=None, min_sims=0):
    """AZ 레코드 → (state, actions, pi, ret). pi는 cands와 같은 순서·길이여야 한다."""
    data, skipped = [], {"nopi": 0, "len": 0, "sims": 0, "bad": 0}
    for f in files:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:   # 생성 중 잘린 마지막 줄
                    skipped["bad"] += 1
                    continue
                cands = r.get("cands", [])
                pi = r.get("pi")
                if pi is None or "out" not in r:
                    skipped["nopi"] += 1
                    continue
                if len(cands) < 2 or len(pi) != len(cands):
                    skipped["len"] += 1
                    continue
                if min_sims and r.get("sims", 0) < min_sims:   # 굶주린 결정 배제
                    skipped["sims"] += 1
                    continue
                s = float(sum(pi))
                if not (0.99 < s < 1.01):
                    skipped["bad"] += 1
                    continue
                ret = np.float32(np.clip(r["out"] / 100.0, -2.0, 2.0))   # RL·오라클과 같은 스케일
                data.append((tp.enc_state(r),
                             np.stack([tp.enc_action(r, c) for c in cands]),
                             np.asarray(pi, dtype=np.float32) / s,
                             ret))
                if cap and len(data) >= cap:
                    return data, skipped
    return data, skipped


def batches(data, bs, shuffle=True):
    idx = np.random.permutation(len(data)) if shuffle else np.arange(len(data))
    for i in range(0, len(idx), bs):
        chunk = [data[j] for j in idx[i:i + bs]]
        K = max(len(c[1]) for c in chunk)
        B = len(chunk)
        s = np.stack([c[0] for c in chunk])
        a = np.zeros((B, K, tp.A_DIM), dtype=np.float32)
        m = np.zeros((B, K), dtype=bool)
        pi = np.zeros((B, K), dtype=np.float32)       # 마스크 밖은 0 — 손실에 안 들어감
        ret = np.array([c[3] for c in chunk], dtype=np.float32)
        for bi, c in enumerate(chunk):
            a[bi, :len(c[1])] = c[1]
            m[bi, :len(c[1])] = True
            pi[bi, :len(c[2])] = c[2]
        yield tuple(torch.from_numpy(x) for x in (s, a, m, pi, ret))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train", nargs="+")
    ap.add_argument("--init", required=True, help="시작 가중치(.pt) — 보통 직전 세대 또는 3단 프라이어")
    ap.add_argument("--ref", required=True, help="KL 앵커 기준(동결 3단 swa13_18.pt)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--vw", type=float, default=0.25, help="가치 회귀 손실 계수(보조)")
    ap.add_argument("--beta", type=float, default=0.3, help="KL(π_θ‖π_ref) 계수 초기값(적응형)")
    ap.add_argument("--kltarget", type=float, default=0.04)
    ap.add_argument("--betamin", type=float, default=0.02)
    ap.add_argument("--betamax", type=float, default=4.0)
    ap.add_argument("--klstop", type=float, default=0.15, help="평균 KL 초과 시 에폭 조기중단")
    ap.add_argument("--ent", type=float, default=0.005, help="엔트로피 바닥 계수(조건부)")
    ap.add_argument("--betaout", default=None)
    ap.add_argument("--minsims", type=int, default=0, help="이 시뮬 수 미만 결정은 학습에서 제외")
    ap.add_argument("--cap", type=int, default=None)
    args = ap.parse_args()
    beta = args.beta

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    sd0 = torch.load(args.init, map_location="cpu")
    width = sd0["se.0.bias"].shape[0] / 512.0
    print(f"모델 폭 {width}  장치 {dev}", flush=True)
    net = tp.Net(width).to(dev)
    net.load_state_dict(sd0)
    ref = tp.Net(width).to(dev)
    ref.load_state_dict(torch.load(args.ref, map_location="cpu"))
    ref.eval()
    for prm in ref.parameters():
        prm.requires_grad_(False)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    t0 = time.time()

    for ep in range(args.epochs):
        net.train()
        tot = {"pol": 0.0, "val": 0.0, "kl": 0.0, "e": 0.0, "eref": 0.0,
               "epi": 0.0, "agree": 0.0, "xent0": 0.0}
        n = 0
        stop = False
        for f in args.train:
            data, skipped = load_az([f], args.cap, args.minsims)
            if not data:
                print(f"  {f}: 유효 레코드 0 (스킵 {skipped})", flush=True)
                continue
            for s, a, m, pi, ret in batches(data, args.bs):
                s, a, m, pi, ret = s.to(dev), a.to(dev), m.to(dev), pi.to(dev), ret.to(dev)
                logit, val = net(s, a, m)
                logp = nn.functional.log_softmax(logit, dim=1)
                p = logp.exp()
                # 정책: 방문분포 소프트 타깃 교차엔트로피 (hard argmax CE의 일반화)
                pol = -(pi * logp.masked_fill(~m, 0.0)).sum(1).mean()
                # 가치: 라운드 결과 회귀 (보조 — 배포 말단 평가를 대체하지 않는다)
                vloss = nn.functional.mse_loss(val.squeeze(-1), ret)
                with torch.no_grad():
                    rlogit, _ = ref(s, a, m)
                    rlogp = nn.functional.log_softmax(rlogit, dim=1)
                    eref = -(rlogp.exp() * rlogp).masked_fill(~m, 0).sum(1).mean()
                kl = (p * (logp - rlogp)).masked_fill(~m, 0).sum(1).mean()
                ent = -(p * logp.masked_fill(~m, 0)).sum(1).mean()
                ent_c = args.ent if ent.item() < 0.7 * eref.item() else 0.0
                loss = pol + args.vw * vloss + beta * kl - ent_c * ent
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 2.0)
                opt.step()
                bsn = pi.shape[0]
                with torch.no_grad():
                    # 진단: 타깃 분포 자체의 엔트로피(= 탐색이 얼마나 갈렸나),
                    #       argmax 일치율(= 이 정책이 배포 선택을 재현하는 비율),
                    #       타깃 엔트로피를 뺀 순수 KL(π_visits‖π_θ) 성분
                    epi = -(pi * torch.log(pi.clamp_min(1e-9))).masked_fill(~m, 0).sum(1).mean()
                    agree = (logit.masked_fill(~m, -1e9).argmax(1) == pi.argmax(1)).float().mean()
                tot["pol"] += pol.item() * bsn; tot["val"] += vloss.item() * bsn
                tot["kl"] += kl.item() * bsn; tot["e"] += ent.item() * bsn
                tot["eref"] += eref.item() * bsn; tot["epi"] += epi.item() * bsn
                tot["agree"] += agree.item() * bsn
                n += bsn
            del data
            if n and tot["kl"] / n > args.klstop:
                stop = True
                break
        if not n:
            print("유효 데이터 없음 — 중단", flush=True)
            return
        meanKL = tot["kl"] / n
        old_beta = beta
        if meanKL > args.kltarget * 1.5:
            beta = min(beta * 2.0, args.betamax)
        elif meanKL < args.kltarget / 1.5:
            beta = max(beta / 2.0, args.betamin)
        # 정책손실 − 타깃엔트로피 = KL(π_visits‖π_θ) — 0이면 완전 재현. 세대 진척의 핵심 지표.
        residual = tot["pol"] / n - tot["epi"] / n
        print(f"epoch {ep+1}: 정책CE {tot['pol']/n:.4f}  KL(방문‖정책) {residual:.4f}  "
              f"타깃엔트로피 {tot['epi']/n:.3f}  일치율 {100*tot['agree']/n:.1f}%  "
              f"가치MSE {tot['val']/n:.4f}  KL(앵커) {meanKL:.4f}  β {old_beta:.3f}→{beta:.3f}  "
              f"엔트로피 {tot['e']/n:.3f}(ref {tot['eref']/n:.3f})  n={n}  "
              f"({time.time()-t0:.0f}s){'  [KL안전정지]' if stop else ''}", flush=True)
        if stop:
            break

    torch.save(net.state_dict(), args.out)
    if args.betaout:
        with open(args.betaout, "w") as fh:
            fh.write(f"{beta:.4f}")
    print("saved:", args.out, f"β_next={beta:.3f}")


if __name__ == "__main__":
    main()
