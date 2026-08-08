#!/bin/bash
# CI 러너용 승단전 샤드 — 전체 시드를 TOTAL_SHARDS로 나눠 이 샤드 몫을 PROCS 병렬로 실행.
# 러너 vCPU만큼 프로세스를 띄우되, 한 게임의 양측은 같은 프로세스라 공정성은 유지된다.
# 환경: SHARD TOTAL_SHARDS PAIRS SEED_START CAND OPP_CAND MAIN_WEIGHTS OPP_WEIGHTS BUDGET [PROCS]
set -u
SHARD=${SHARD:?}
TOTAL=${TOTAL_SHARDS:-20}
PAIRS=${PAIRS:-480}
SEED0=${SEED_START:-20001}
CAND=${CAND:-exchange}
OPPC=${OPP_CAND:-exchange}
# 시간배분 파라미터: "checkAt,stopShare,stopMargin,maxExtra,hardCap" (maxExtra=0 = 상한 없음)
TM_AT=""; TM_SHARE=""; TM_MARGIN=""; TM_EXTRA=""; TM_CAP=""
if [ -n "${TM_PARAMS:-}" ]; then
  IFS=',' read -r TM_AT TM_SHARE TM_MARGIN TM_EXTRA TM_CAP <<< "$TM_PARAMS"
fi
WMAIN=${MAIN_WEIGHTS:-shared/weights-super3.json}
WOPP=${OPP_WEIGHTS:-shared/weights-super.json}
BUDGET=${BUDGET:-950}
# 상대 예산을 따로 줄 수 있다(기본=같음). 비대칭 예산은 "탐색을 더 줬을 때 얼마나 강해지는가"를
# 재는 데 쓴다 — 예산 무한대는 어떤 프라이어 개선으로도 넘을 수 없는 상한이라, 4배 예산이
# 비기면 프라이어 축(AZ 포함) 전체가 그 위에서 막힌다는 뜻이다.
BUDGET_OPP=${BUDGET_OPP:-$BUDGET}
PROCS=${PROCS:-$(nproc)}
mkdir -p ci-logs

PER=$(( (PAIRS + TOTAL - 1) / TOTAL ))
MY0=$(( SEED0 + SHARD * PER ))
END=$(( SEED0 + PAIRS - 1 ))
MYN=$PER
LAST=$(( MY0 + MYN - 1 ))
if [ "$LAST" -gt "$END" ]; then MYN=$(( END - MY0 + 1 )); fi
if [ "$MYN" -le 0 ]; then echo "shard=$SHARD 몫 없음"; exit 0; fi

echo "shard=$SHARD seeds=$MY0..$((MY0 + MYN - 1)) procs=$PROCS nproc=$(nproc)"
SUB=$(( (MYN + PROCS - 1) / PROCS ))
MYEND=$(( MY0 + MYN - 1 ))
for p in $(seq 0 $((PROCS - 1))); do
  S=$(( MY0 + p * SUB ))
  if [ "$S" -gt "$MYEND" ]; then continue; fi
  E=$(( S + SUB - 1 ))
  if [ "$E" -gt "$MYEND" ]; then E=$MYEND; fi
  TICHU_CAND="$CAND" TICHU_OPP_CAND="$OPPC" TICHU_REPCAP="${REPCAP:-}" TICHU_TM="${TM:-}" TICHU_OUTBONUS="${OUTBONUS:-}" TICHU_FASTPOL="${FASTPOL:-}" TICHU_OPPK="${OPPK:-}" \
  TICHU_TM_AT="${TM_AT:-}" TICHU_TM_SHARE="${TM_SHARE:-}" TICHU_TM_MARGIN="${TM_MARGIN:-}" \
  TICHU_TM_EXTRA="${TM_EXTRA:-}" TICHU_TM_CAP="${TM_CAP:-}" \
  TICHU_PERFECT="${PERFECT:-}" \
  TICHU_PIN="${PIN:-}" \
  TICHU_DECLBIAS="${DECLBIAS:-}" \
  TICHU_WISHREAD="${WISHREAD:-}" \
  node ml/eval-hybrid.js "$WMAIN" "pu:$WOPP:1.0" "$S" "$E" "$BUDGET" "$BUDGET_OPP" puct 1 1.0 \
    > "ci-logs/out_${SHARD}_${p}.log" 2>&1 &
done
wait
grep -h "perDecision\|RESULT" ci-logs/out_${SHARD}_*.log || true
