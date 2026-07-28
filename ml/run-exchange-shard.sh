#!/bin/bash
# CI 러너용 교환 전략 대량 비교 샤드 — 짝지은 딜을 시드 대역으로 쪼개 vCPU만큼 병렬로.
#
# 왜 CI인가: 교환 MLP는 60k딜에서 +0.59±0.36(1.6σ)로 "유의 판정에 ~20만 딜 필요,
# 비용 대비 무의미"라며 보류됐다. 그 비용 판단은 로컬(단일 코어 ~7.5s/2,000딜) 기준이었다.
# CI 80코어면 100만 딜이 분 단위 — 닫힌 게 아니라 못 잰 것이었으므로 여기서 종결한다.
#
# 환경: SHARD TOTAL_SHARDS DEALS SEED_START STRATS [ECO] [POLICY] [PROCS]
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
DEALS=${DEALS:-200000}
SEED0=${SEED_START:-5000000}
STRATS=${STRATS:-learned,learnedMlp}
ECO=${ECO:-learned}
POLICY=${POLICY:-normal}
PROCS=${PROCS:-$(nproc)}
mkdir -p ci-exch

PER=$(( (DEALS + TOTAL - 1) / TOTAL ))
MY0=$(( SHARD * PER ))
REMAIN=$(( DEALS - MY0 ))
if [ "$REMAIN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi
MYN=$PER
if [ "$MYN" -gt "$REMAIN" ]; then MYN=$REMAIN; fi

echo "shard=$SHARD deals=$MYN strats=$STRATS eco=$ECO policy=$POLICY nproc=$(nproc)"
SUB=$(( (MYN + PROCS - 1) / PROCS ))
for p in $(seq 0 $((PROCS - 1))); do
  N=$SUB
  DONE=$(( p * SUB ))
  if [ "$DONE" -ge "$MYN" ]; then continue; fi
  if [ $((DONE + N)) -gt "$MYN" ]; then N=$(( MYN - DONE )); fi
  # 딜당 시드 1개. 대역을 샤드·프로세스로 완전 분리(겹치면 짝지음이 중복 표본이 된다)
  S=$(( SEED0 + MY0 + DONE ))
  TICHU_STRATS="$STRATS" TICHU_ECO="$ECO" \
    node ml/eval-exchange.js "$N" "$S" "$POLICY" \
    > "ci-exch/xd_${SHARD}_${p}.log" 2>&1 &
done
wait
grep -h '^XD' ci-exch/xd_${SHARD}_*.log || true
