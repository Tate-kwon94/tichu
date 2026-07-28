#!/bin/zsh
# AZ 자가대전 루프(로컬 맥) — 배포 3단 PUCT 자가대전 → 방문분포 증류 → 트립와이어.
# 사용: zsh ml/az.sh [최대세대=8]
# 재시작 안전: ml/data/az/state 에 세대 저장, 세대별 가중치 보존.
#
# CI와의 분업: 대량 생성은 CI selfplay.yml(야간 1회 ~1,600게임), 로컬은 상시 소량 생성 +
# 학습 + 트립와이어. CI 아티팩트를 ml/data/az/ci/ 에 풀어두면 이 루프가 같이 먹는다.
set -e
setopt NULL_GLOB 2>/dev/null || true    # zsh: 매치 없는 glob이 명령 전체를 죽이는 사고 방지(2회 전례)
cd "$(dirname "$0")/.."
ML=ml; AZ=$ML/data/az
mkdir -p "$AZ" "$AZ/ci"
PY=$ML/.venv/bin/python
NODE=/opt/homebrew/bin/node
MAXGEN=${1:-8}
WORKERS=${AZ_WORKERS:-6}       # M2 8코어(4P+4E) — PUCT는 시간예산이라 초과구독 금지
GPW=${AZ_GPW:-14}              # 워커당 게임 (6×14=84게임/세대 ≈ 1.9만 결정, ~40분)
BUDGET=${AZ_BUDGET:-600}
FROZEN=shared/weights-super3.json        # 동결 3단 = 트립와이어 상대이자 앵커
REFPT=$AZ/ref3.pt
DECL=shared/weights-declare.json
KLTARGET=0.04

# 초기화: 3단 프라이어에서 출발
if [ ! -f "$AZ/cur.pt" ]; then
  cp $ML/data/rl3/swa13_18.pt "$AZ/cur.pt"
  cp $ML/data/rl3/swa13_18.json "$AZ/cur.json"
  cp $ML/data/rl3/swa13_18.pt "$REFPT"
  echo "0" > "$AZ/state"
  echo "$(date '+%H:%M:%S') init from 3단(swa13_18)" >> "$AZ/loop.log"
fi
GEN=$(cat "$AZ/state")
DROP=0

while [ "$GEN" -lt "$MAXGEN" ]; do
  GEN=$((GEN + 1))
  echo "$(date '+%H:%M:%S') === gen $GEN: 생성 ($WORKERS×$GPW 게임 @${BUDGET}ms) ===" >> "$AZ/loop.log"
  for i in $(seq 0 $((WORKERS - 1))); do
    S=$((GEN * 100000 + i * 10000))
    $NODE $ML/gen-az.js "$AZ/cur.json" $S $((S + GPW - 1)) $BUDGET 1.0 \
      > "$AZ/g${GEN}_$i.jsonl" 2>> "$AZ/gen.log" &
  done
  wait

  BETA=$( [ -f "$AZ/beta" ] && cat "$AZ/beta" || echo 0.3 )
  echo "$(date '+%H:%M:%S') === gen $GEN: 학습 (방문분포 증류, β=$BETA) ===" >> "$AZ/loop.log"
  # 학습 창 = 이번 + 직전 세대 + CI 아티팩트. 한 세대분만 쓰면 표본이 얇아 잡음을 배운다.
  PREV=$((GEN - 1))
  FILES=""
  for f in "$AZ/g${GEN}_"*.jsonl "$AZ/g${PREV}_"*.jsonl "$AZ/ci/"*.jsonl; do [ -s "$f" ] && FILES="$FILES $f"; done
  if [ -z "$FILES" ]; then echo "생성 실패 — 중단" >> "$AZ/loop.log"; exit 1; fi
  $PY $ML/train_az.py ${=FILES} --init "$AZ/cur.pt" --ref "$REFPT" --out "$AZ/gen$GEN.pt" \
    --epochs 2 --beta $BETA --kltarget $KLTARGET --betaout "$AZ/beta" --lr 5e-5 >> "$AZ/loop.log" 2>&1
  cp "$AZ/gen$GEN.pt" "$AZ/cur.pt"
  $PY $ML/export_weights.py "$AZ/cur.pt" "$AZ/cur.json.tmp" >> "$AZ/loop.log" 2>&1
  mv "$AZ/cur.json.tmp" "$AZ/cur.json"
  cp "$AZ/cur.json" "$AZ/gen$GEN.json"
  echo "$GEN" > "$AZ/state"

  # 트립와이어(값싼 방향 확인): raw 그리디 짝지음 vs 동결 3단. 4,000딜로 SE ~1.
  # 주의: raw 개선이 PUCT 실물로 전이된다는 보장은 없다(RL2에서 전이 0) — 방향 확인용일 뿐,
  # 판정은 항상 eval-hybrid 실물전(PUCT 짝지음).
  echo "$(date '+%H:%M:%S') === gen $GEN: 트립와이어 ===" >> "$AZ/loop.log"
  for i in $(seq 0 7); do
    $NODE $ML/eval-raw.js "$AZ/cur.json" "$FROZEN" 500 $((8000000 + i * 1000)) "$DECL" \
      > "$AZ/trip${GEN}_$i.tmp" 2>/dev/null &
  done
  wait
  read TRIP TRIPSE < <($PY -c "
import glob,math,statistics
ms=[]; ns=[]
for f in sorted(glob.glob('$AZ/trip${GEN}_*.tmp')):
    p=open(f).read().split()
    if len(p)>=4: ms.append(float(p[1])); ns.append(int(p[3].split('=')[1]))
if len(ms)>=2:
    m=sum(mi*ni for mi,ni in zip(ms,ns))/sum(ns)
    se=statistics.stdev(ms)/math.sqrt(len(ms))
    print(f'{m:.2f} {se:.2f}')
else: print('NA NA')
")
  rm -f "$AZ/trip${GEN}_"*.tmp
  echo "gen $GEN 트립와이어(vs 동결3단): $TRIP ± $TRIPSE 점/라운드" >> "$AZ/bench.log"
  echo "$(date '+%H:%M:%S') gen $GEN 트립: $TRIP ± $TRIPSE" >> "$AZ/loop.log"

  SIGNEG=$($PY -c "print(1 if ($TRIP + 2*$TRIPSE) < 0 else 0)" 2>/dev/null || echo 0)
  if [ "$SIGNEG" = "1" ]; then DROP=$((DROP + 1)); else DROP=0; fi
  if [ "$DROP" -ge 2 ]; then
    echo "$(date '+%H:%M:%S') !!! gen $GEN 유의한 하락 2세대 연속 — 정지" >> "$AZ/loop.log"
    exit 1
  fi

  OLD=$((GEN - 2))                     # 2세대 창(WINDOW=2) — 직전 것은 남겨 재학습에 쓴다
  [ "$OLD" -ge 1 ] && rm -f "$AZ/g${OLD}_"*.jsonl
done
echo "$(date '+%H:%M:%S') LOOP DONE gen=$GEN" >> "$AZ/loop.log"
