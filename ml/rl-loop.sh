#!/bin/zsh
# RL 자가대전 루프 — 생성(6워커) → DMC 학습 → 내보내기 → 3세대마다 고수950 벤치마크
# 사용: zsh ml/rl-loop.sh [최대세대수=30]
# 재시작 안전: ml/data/rl/state 에 세대 번호 저장, 가중치는 세대별 보존
set -e
cd "$(dirname "$0")/.."
ML=ml; RL=$ML/data/rl
mkdir -p "$RL"
MAXGEN=${1:-30}
GPW=400              # 세대당 워커당 게임 수 (6워커 = 2400게임/세대)
EPS=0.05
WINDOW=2             # 최근 N세대 데이터로 학습 (정책 그래디언트는 준-온폴리시 유지)

[ -f "$RL/state" ] && GEN=$(cat "$RL/state") || GEN=0
if [ ! -f "$RL/cur.pt" ]; then
  cp "$ML/data/v2-weights.pt" "$RL/cur.pt"
  cp "$ML/data/v2-weights.json" "$RL/cur.json"
  echo "$(date '+%H:%M:%S') init from v2-weights" >> "$RL/loop.log"
fi

while [ "$GEN" -lt "$MAXGEN" ]; do
  GEN=$((GEN + 1))
  echo "$(date '+%H:%M:%S') === gen $GEN: selfplay ===" >> "$RL/loop.log"
  for i in 0 1 2 3 4 5; do
    /opt/homebrew/bin/node $ML/gen-selfplay.js "$RL/cur.json" $GPW $EPS $((GEN * 100000 + i * 10000)) \
      > "$RL/g${GEN}_$i.jsonl" 2>> "$RL/gen.log" &
  done
  wait

  # 학습: 최근 WINDOW 세대 데이터
  FILES=""
  for g in $(seq $((GEN - WINDOW + 1)) $GEN); do
    [ "$g" -ge 1 ] && for i in 0 1 2 3 4 5; do [ -s "$RL/g${g}_$i.jsonl" ] && FILES="$FILES $RL/g${g}_$i.jsonl"; done
  done
  echo "$(date '+%H:%M:%S') === gen $GEN: train(ppo) ===" >> "$RL/loop.log"
  $ML/.venv/bin/python $ML/train_ppo.py ${=FILES} --init "$RL/cur.pt" --out "$RL/gen$GEN.pt" --epochs 2 >> "$RL/loop.log" 2>&1
  cp "$RL/gen$GEN.pt" "$RL/cur.pt"
  $ML/.venv/bin/python $ML/export_weights.py "$RL/cur.pt" "$RL/cur.json.tmp" >> "$RL/loop.log" 2>&1
  mv "$RL/cur.json.tmp" "$RL/cur.json"
  echo "$GEN" > "$RL/state"

  # 트립와이어: 매 세대 vs 보통 40판 (12초) — 55% 미만이면 경보 남기고 정지
  TRIP=$(/opt/homebrew/bin/node $ML/eval-net.js "$RL/cur.json" normal 900 919 2>/dev/null | tail -1)
  echo "gen $GEN trip: $TRIP" >> "$RL/bench.log"
  RATE=$(echo "$TRIP" | grep -o 'rate=[0-9.]*' | cut -d= -f2)
  if [ -n "$RATE" ] && [ "${RATE%.*}" -lt 55 ]; then
    echo "$(date '+%H:%M:%S') !!! gen $GEN 붕괴 감지(rate=$RATE) — 루프 정지" >> "$RL/loop.log"
    exit 1
  fi

  # 오래된 세대 데이터 정리(디스크 절약: WINDOW+1 이전 세대 삭제)
  OLD=$((GEN - WINDOW))
  [ "$OLD" -ge 1 ] && rm -f "$RL/g${OLD}_"*.jsonl

  # 벤치마크: 3세대마다 vs 고수950 (20판) + vs 보통 (100판)
  if [ $((GEN % 3)) -eq 0 ]; then
    echo "$(date '+%H:%M:%S') === gen $GEN: benchmark ===" >> "$RL/loop.log"
    /opt/homebrew/bin/node $ML/eval-net.js "$RL/cur.json" normal 1 50 2>/dev/null | tail -1 >> "$RL/bench.log"
    for i in 0 1; do
      /opt/homebrew/bin/node $ML/eval-net.js "$RL/cur.json" hard $((1 + i * 5)) $((5 + i * 5)) 950 2>/dev/null | tail -1 >> "$RL/bench_h$i.tmp" &
    done
    wait
    { echo "gen $GEN:"; cat "$RL/bench_h0.tmp" "$RL/bench_h1.tmp"; } >> "$RL/bench.log"
    rm -f "$RL/bench_h0.tmp" "$RL/bench_h1.tmp"
  fi
done
echo "$(date '+%H:%M:%S') LOOP DONE gen=$GEN" >> "$RL/loop.log"
