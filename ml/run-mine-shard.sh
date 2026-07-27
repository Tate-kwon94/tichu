#!/bin/bash
# CI 러너용 발굴 스윕 샤드
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
GAMES=${GAMES:-2000}
SEED0=${SEED_START:-60000}
PUCTMS=${PUCTMS:-950}
WORLDS=${WORLDS:-250}
PROCS=${PROCS:-$(nproc)}
mkdir -p ci-mine
PER=$(( (GAMES + TOTAL - 1) / TOTAL ))
MY0=$(( SEED0 + SHARD * PER ))
REMAIN=$(( GAMES - SHARD * PER ))
if [ "$REMAIN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi
MYN=$PER; [ "$MYN" -gt "$REMAIN" ] && MYN=$REMAIN
SUB=$(( (MYN + PROCS - 1) / PROCS ))
echo "shard=$SHARD games=$MYN procs=$PROCS"
for p in $(seq 0 $((PROCS - 1))); do
  N=$SUB; DONE=$(( p * SUB ))
  [ "$DONE" -ge "$MYN" ] && continue
  [ $((DONE + N)) -gt "$MYN" ] && N=$(( MYN - DONE ))
  node ml/mine-decisions.js "$N" $((MY0 + DONE)) "$PUCTMS" "$WORLDS" > "ci-mine/mine_${SHARD}_${p}.jsonl" 2>/dev/null &
done
wait
wc -l ci-mine/mine_${SHARD}_*.jsonl | tail -1
