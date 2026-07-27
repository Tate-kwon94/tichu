#!/bin/bash
# CI 러너용 라벨 생성 샤드 — 이 샤드 몫을 vCPU만큼 병렬로.
# 환경: SHARD TOTAL_SHARDS LABELS WORLDS SEED_START [ECOLOGY_EXW] [PROCS]
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
LABELS=${LABELS:-10000}
WORLDS=${WORLDS:-2000}
SEED0=${SEED_START:-2000000}
PROCS=${PROCS:-$(nproc)}
mkdir -p ci-labels

PER=$(( (LABELS + TOTAL - 1) / TOTAL ))
MY0=$(( SHARD * PER ))
REMAIN=$(( LABELS - MY0 ))
if [ "$REMAIN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi
MYN=$PER
if [ "$MYN" -gt "$REMAIN" ]; then MYN=$REMAIN; fi

echo "shard=$SHARD labels=$MYN worlds=$WORLDS nproc=$(nproc) ecology=${ECOLOGY_EXW:-2단(keepSpecials)}"
SUB=$(( (MYN + PROCS - 1) / PROCS ))
for p in $(seq 0 $((PROCS - 1))); do
  N=$SUB
  DONE=$(( p * SUB ))
  if [ "$DONE" -ge "$MYN" ]; then continue; fi
  if [ $((DONE + N)) -gt "$MYN" ]; then N=$(( MYN - DONE )); fi
  # 시드 공간을 샤드·프로세스별로 분리 (라벨당 시드 ~4개 소모 대비 ×8 여유)
  S=$(( SEED0 + (SHARD * PROCS + p) * PER * 8 ))
  TICHU_LABEL_EXW="${ECOLOGY_EXW:-}" \
  node ml/gen-exchange-labels.js "$N" "$S" "$WORLDS" \
    > "ci-labels/lab_${SHARD}_${p}.jsonl" 2> /dev/null &
done
wait
wc -l ci-labels/lab_${SHARD}_*.jsonl | tail -1
