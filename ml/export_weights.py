#!/usr/bin/env python3
"""학습된 파일럿 가중치를 JS 추론용 JSON으로 내보내기.
사용: .venv/bin/python export_weights.py <weights.pt> <out.json>
"""
import base64, json, sys
import numpy as np
import torch

sd = torch.load(sys.argv[1], map_location="cpu")
out = {}
for k, v in sd.items():
    a = v.numpy().astype(np.float32)
    out[k] = {"shape": list(a.shape),
              "b64": base64.b64encode(a.tobytes()).decode("ascii")}
with open(sys.argv[2], "w") as f:
    json.dump(out, f)
print("exported", len(out), "tensors ->", sys.argv[2])
