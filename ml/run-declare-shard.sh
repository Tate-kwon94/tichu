#!/bin/bash
# CI 러너용 선언 임계값 스윕 샤드 — 짝지은 딜을 대역으로 쪼개 vCPU만큼 병렬로.
#
# 왜 다시 재는가: 과거 스윕은 4,000딜(SE≈1.5)이었다. "현행이 최적, 올려도 g0.68 −1.02"의
# −1.02는 그 정밀도에서 잡음이다. 선언은 ±100/±200 판돈이라 작은 임계 이동도 값이 크다.
# 내리는 방향은 이미 큰 효과로 확정 음수(t0.34/g0.34 = −49.9) — 올리는 방향이 미측정 구간.
#
# 환경: SHARD TOTAL_SHARDS DEALS SEED_START [DECL_T] [DECL_G] [EXCH] [PROCS]
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
DEALS=${DEALS:-100000}
SEED0=${SEED_START:-7000000}
EXCH=${EXCH:-keep}
PROCS=${PROCS:-$(nproc)}
if [ "$PROCS" -gt 16 ]; then PROCS=16; fi
mkdir -p ci-decl

PER=$(( (DEALS + TOTAL - 1) / TOTAL ))
MY0=$(( SHARD * PER ))
REMAIN=$(( DEALS - MY0 ))
if [ "$REMAIN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi
MYN=$PER
if [ "$MYN" -gt "$REMAIN" ]; then MYN=$REMAIN; fi

echo "shard=$SHARD deals=$MYN t=[${DECL_T:-기본}] g=[${DECL_G:-기본}] exch=$EXCH nproc=$(nproc)"
SUB=$(( (MYN + PROCS - 1) / PROCS ))
for p in $(seq 0 $((PROCS - 1))); do
  N=$SUB
  DONE=$(( p * SUB ))
  if [ "$DONE" -ge "$MYN" ]; then continue; fi
  if [ $((DONE + N)) -gt "$MYN" ]; then N=$(( MYN - DONE )); fi
  S=$(( SEED0 + MY0 + DONE ))     # 딜당 시드 1개 — 대역 완전 분리
  TICHU_DECL_T="${DECL_T:-}" TICHU_DECL_G="${DECL_G:-}" \
    node ml/eval-declare.js "$N" "$S" "$EXCH" \
    > "ci-decl/dc_${SHARD}_${p}.log" 2>&1 &
done
wait
LINES=$(grep -h '^XD' ci-decl/dc_${SHARD}_*.log 2>/dev/null | wc -l)
echo "XD 줄 $LINES"
if [ "$LINES" -lt 1 ]; then
  echo "!!! shard=$SHARD XD 줄 0 — 실패" >&2
  sed -n '1,40p' ci-decl/dc_${SHARD}_*.log 2>/dev/null >&2 || true
  exit 1
fi
grep -h '^XD' ci-decl/dc_${SHARD}_*.log | head -5
