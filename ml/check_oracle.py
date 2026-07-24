#!/usr/bin/env python3
"""학습본(PyTorch) 예측값을 덤프 — JS 배포본과 대조하기 위한 정답지.
JS 쪽 1층은 가중치를 [입력,은닉]으로 전치해 희소 누적하므로, 전치/인덱싱 실수가
조용히 틀린 봇을 만들 수 있다. 그 사고를 수치로 잡는다.
사용: .venv/bin/python check_oracle.py <oracle.pt> <data.bin> <out.json> [n=200]
"""
import json, sys
import numpy as np
import torch
from train_oracle import Oracle, S_ORC, REC

pt, binf, outf = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 200

sd = torch.load(pt, map_location="cpu")
net = Oracle(sd["o.0.bias"].shape[0], sd["o.2.bias"].shape[0])
net.load_state_dict(sd)
net.eval()

m = np.memmap(binf, dtype=np.float32, mode="r")
rows = m[: (len(m) // REC) * REC].reshape(-1, REC)[:n]
x = torch.from_numpy(np.asarray(rows[:, :S_ORC]))
with torch.no_grad():
    y = net(x).numpy()

json.dump({"n": int(n), "pred": [float(v) for v in y]}, open(outf, "w"))
print(f"덤프 {n}건 -> {outf}  (예측 범위 {y.min():+.3f} ~ {y.max():+.3f})")
