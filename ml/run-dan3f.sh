#!/bin/zsh
# 3단 스택 승단전 재실행 — 중단 내성판 (레인 8 × 청크 4 × 15시드 = 960게임)
# 청크마다 결과가 파일로 남아, 중단돼도 완료된 청크(30게임 단위)는 보존된다.
# 사용: zsh ml/run-dan3f.sh   (tichu 디렉터리에서. 이미 있는 청크 로그는 건너뜀 = 이어하기)
# 집계: python3 <merge-dan3.py> "ml/data/dan3fr_*.log"
setopt NULL_GLOB 2>/dev/null || true
cd "$(dirname "$0")/.."

for lane in 0 1 2 3 4 5 6 7; do
  (
    for chunk in 0 1 2 3; do
      OUT="ml/data/dan3fr_${lane}_${chunk}.log"
      # 이어하기: 완료된 청크(RESULT 줄 존재)는 건너뛴다
      if [ -f "$OUT" ] && grep -q "RESULT" "$OUT"; then continue; fi
      S=$((8001 + lane*100 + chunk*15))
      TICHU_CAND=exchange,exchTriple,endgame,guardTichu TICHU_OPP_CAND=exchange \
      node ml/eval-hybrid.js ml/data/rl3/swa13_18.json "pu:ml/data/v6-weights.json:1.0" \
        $S $((S+14)) 950 950 puct 1 1.0 > "$OUT" 2>&1
    done
  ) &
done
wait
echo "완료 — 집계: merge-dan3.py 'ml/data/dan3fr_*.log'"
