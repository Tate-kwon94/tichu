#!/bin/bash
# CI 러너용 AZ 자가대전 샤드 — 이 샤드 몫의 게임을 vCPU만큼 병렬로.
# 환경: SHARD TOTAL_SHARDS GAMES SEED_START BUDGET [WEIGHTS] [PUCT_C] [AZ_TEMP] [PROCS]
#
# 주의(계측): PUCT는 시간예산 탐색이라 코어를 초과구독하면 결정당 시뮬 수가 급감한다.
# PROCS=nproc를 넘기지 말 것 — gen-az가 stderr에 sims/dec를 찍으므로 사후 판정 가능.
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
GAMES=${GAMES:-400}
# 시드 대역: 지정이 없으면(cron) 실행 번호로 회전시킨다 — 안 그러면 매일 밤 같은 딜을 만든다
SEED0=${SEED_START:-}
if [ -z "$SEED0" ]; then SEED0=$(( 3000000 + ${RUN_NUMBER:-0} * 100000 )); fi
BUDGET=${BUDGET:-600}
W=${WEIGHTS:-shared/weights-super3.json}
CVAL=${PUCT_C:-1.0}
PROCS=${PROCS:-$(nproc)}
mkdir -p ci-selfplay

PER=$(( (GAMES + TOTAL - 1) / TOTAL ))
MY0=$(( SHARD * PER ))
REMAIN=$(( GAMES - MY0 ))
if [ "$REMAIN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi
MYN=$PER
if [ "$MYN" -gt "$REMAIN" ]; then MYN=$REMAIN; fi

echo "shard=$SHARD games=$MYN budget=${BUDGET}ms c=$CVAL nproc=$(nproc) procs=$PROCS w=$W"
SUB=$(( (MYN + PROCS - 1) / PROCS ))
for p in $(seq 0 $((PROCS - 1))); do
  N=$SUB
  DONE=$(( p * SUB ))
  if [ "$DONE" -ge "$MYN" ]; then continue; fi
  if [ $((DONE + N)) -gt "$MYN" ]; then N=$(( MYN - DONE )); fi
  # 시드 대역: 샤드·프로세스마다 완전 분리(게임당 시드 1개, ×8 여유)
  S=$(( SEED0 + (SHARD * PROCS + p) * PER * 8 ))
  E=$(( S + N - 1 ))
  TICHU_AZ_TEMP="${AZ_TEMP:-0}" \
  node ml/gen-az.js "$W" "$S" "$E" "$BUDGET" "$CVAL" \
    > "ci-selfplay/az_${SHARD}_${p}.jsonl" 2> "ci-selfplay/az_${SHARD}_${p}.log" &
done
wait
echo "--- 레코드 수"
wc -l ci-selfplay/az_${SHARD}_*.jsonl | tail -1
echo "--- 결정당 시뮬(굶주림 판정)"
grep -h '^DONE' ci-selfplay/az_${SHARD}_*.log || true
