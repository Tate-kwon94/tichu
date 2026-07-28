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
if [ "$PROCS" -gt 16 ]; then PROCS=16; fi     # SLOTS(=16) 상한 — 넘으면 시드 대역이 겹친다
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
  # 시드 대역: 샤드·프로세스마다 완전 분리. 인덱스에 러너 로컬 nproc(PROCS)를 쓰면
  # 러너마다 PROCS가 다를 때 대역이 겹쳐 같은 딜을 중복 생성한다(짝지음이 아니라 중복 표본).
  # 고정 상수 SLOTS로 인덱싱해 러너 사양과 무관하게 분리를 보장한다.
  SLOTS=16
  S=$(( SEED0 + (SHARD * SLOTS + p) * PER * 8 ))
  E=$(( S + N - 1 ))
  TICHU_AZ_TEMP="${AZ_TEMP:-0}" \
  node ml/gen-az.js "$W" "$S" "$E" "$BUDGET" "$CVAL" \
    > "ci-selfplay/az_${SHARD}_${p}.jsonl" 2> "ci-selfplay/az_${SHARD}_${p}.log" &
done
wait
echo "--- 레코드 수"
LINES=$(cat ci-selfplay/az_${SHARD}_*.jsonl 2>/dev/null | wc -l)
echo "$LINES"
echo "--- 결정당 시뮬(굶주림 판정)"
grep -h '^DONE' ci-selfplay/az_${SHARD}_*.log || true
# 생성이 전면 실패해도 wait는 0을 반환하고 마지막 grep의 || true가 초록으로 덮는다 —
# 빈 아티팩트로 "성공" 완주하면 다음 세대가 데이터 없이 학습한다. 산출물로 판정한다.
if [ "$LINES" -lt 1 ]; then
  echo "!!! shard=$SHARD 레코드 0 — 생성 실패" >&2
  sed -n '1,40p' ci-selfplay/az_${SHARD}_*.log 2>/dev/null >&2 || true
  exit 1
fi
