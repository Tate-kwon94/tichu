#!/bin/zsh
# 4단 자가대전 RL 루프 — 학습팀 vs 동결 3단(swa+학습교환 환경), swa KL앵커 + 트립와이어.
# 사용: zsh ml/rl4.sh [최대세대=8]
# 재시작 안전: ml/data/rl3/state 에 세대 저장, 세대별 가중치 보존.
set -e
setopt NULL_GLOB 2>/dev/null || true   # zsh: 매치 없는 glob이 에러가 되어 set -e로 죽는 것 방지
cd "$(dirname "$0")/.."
ML=ml; RL=$ML/data/rl4
mkdir -p "$RL"
PY=$ML/.venv/bin/python
NODE=/opt/homebrew/bin/node
MAXGEN=${1:-6}
GPW=200            # 워커당 게임 (8워커 = 1600게임/세대 ≈ 184k결정)
EPS=0.05
DECL=shared/weights-declare.json
ORACLE=$ML/data/orc/v_net.json           # net정책 오라클 — net환경 분산 제거↑(41→55%), 상태baseline 전용
FROZEN=shared/weights-super3.json          # 동결 3단 상대(swa 정책 + 학습교환 환경)
REFPT=$ML/data/rl3/swa13_18.pt           # KL 앵커 = 3단(swa)
KLTARGET=0.04                            # 적응형 KL 목표(β 자동 조정) — 세대당 이동 약간↑
[ -f "$RL/beta" ] && BETA=$(cat "$RL/beta") || BETA=0.4   # 세대 간 β 이월

# 초기화
if [ ! -f "$RL/cur.pt" ]; then
  cp "$ML/data/rl3/swa13_18.pt" "$RL/cur.pt"
  cp shared/weights-super3.json "$RL/cur.json"
  echo "0" > "$RL/state"
  echo "$(date "+%H:%M:%S") init from swa13_18(3단)" >> "$RL/loop.log"
fi
GEN=$(cat "$RL/state")
DROP=0

while [ "$GEN" -lt "$MAXGEN" ]; do
  GEN=$((GEN + 1))
  echo "$(date '+%H:%M:%S') === gen $GEN: 생성 (학습 vs 동결2단) ===" >> "$RL/loop.log"
  for i in 0 1 2 3 4 5 6 7; do
    TICHU_RL_EXW=$ML/weights-exchange-linear.json $NODE $ML/gen-rl.js "$RL/cur.json" "$FROZEN" $GPW $EPS $((GEN * 100000 + i * 10000)) "$DECL" "$ORACLE" \
      > "$RL/g${GEN}_$i.jsonl" 2>> "$RL/gen.log" &
  done
  wait

  BETA=$( [ -f "$RL/beta" ] && cat "$RL/beta" || echo 0.4 )
  echo "$(date '+%H:%M:%S') === gen $GEN: 학습 (오라클baseline + 적응형KL β=$BETA 목표$KLTARGET) ===" >> "$RL/loop.log"
  FILES=""
  for i in 0 1 2 3 4 5 6 7; do [ -s "$RL/g${GEN}_$i.jsonl" ] && FILES="$FILES $RL/g${GEN}_$i.jsonl"; done
  $PY $ML/train_rl.py ${=FILES} --init "$RL/cur.pt" --ref "$REFPT" --out "$RL/gen$GEN.pt" \
    --epochs 2 --beta $BETA --kltarget $KLTARGET --betaout "$RL/beta" --lr 5e-5 >> "$RL/loop.log" 2>&1
  cp "$RL/gen$GEN.pt" "$RL/cur.pt"
  $PY $ML/export_weights.py "$RL/cur.pt" "$RL/cur.json.tmp" >> "$RL/loop.log" 2>&1
  mv "$RL/cur.json.tmp" "$RL/cur.json"
  cp "$RL/cur.json" "$RL/gen$GEN.json"
  echo "$GEN" > "$RL/state"

  # 트립와이어: 이 세대 정책 vs 동결 2단, raw 그리디 짝지음 점수차 (>0이면 개선).
  # 8샤드×500딜 = 4000딜로 SE↓. 정지는 부호가 아니라 신뢰구간 기반(오발동 방지):
  # (평균 + 2·SE) < 0 이어야 "유의하게 나빠짐" — 노이즈로는 안 걸림.
  echo "$(date '+%H:%M:%S') === gen $GEN: 트립와이어 (1600딜) ===" >> "$RL/loop.log"
  for i in 0 1 2 3 4 5 6 7; do
    TICHU_RL_EXW=$ML/weights-exchange-linear.json $NODE $ML/eval-raw.js "$RL/cur.json" "$FROZEN" 200 $((7000000 + i * 500)) "$DECL" \
      > "$RL/trip${GEN}_$i.tmp" 2>/dev/null &
  done
  wait
  read TRIP TRIPSE < <($PY -c "
import glob,math,statistics
ms=[]; ns=[]
for f in sorted(glob.glob('$RL/trip${GEN}_*.tmp')):
    p=open(f).read().split()
    if len(p)>=3: ms.append(float(p[1])); ns.append(int(p[3].split('=')[1]))
if len(ms)>=2:
    m=sum(mi*ni for mi,ni in zip(ms,ns))/sum(ns)
    se=statistics.stdev(ms)/math.sqrt(len(ms))
    print(f'{m:.2f} {se:.2f}')
else: print('NA NA')
")
  rm -f "$RL/trip${GEN}_"*.tmp
  echo "gen $GEN 트립와이어(vs 동결2단): $TRIP ± $TRIPSE 점/라운드" >> "$RL/bench.log"
  echo "$(date '+%H:%M:%S') gen $GEN 트립: $TRIP ± $TRIPSE 점/라운드" >> "$RL/loop.log"

  # 유의하게 나빠짐(평균+2SE<0)이 2세대 연속이면 정지. 노이즈·정체로는 안 걸림.
  SIGNEG=$($PY -c "print(1 if ($TRIP + 2*$TRIPSE) < 0 else 0)" 2>/dev/null || echo 0)
  if [ "$SIGNEG" = "1" ]; then DROP=$((DROP + 1)); else DROP=0; fi
  if [ "$DROP" -ge 2 ]; then
    echo "$(date '+%H:%M:%S') !!! gen $GEN 유의한 하락 2세대 연속 — 정지" >> "$RL/loop.log"
    exit 1
  fi

  # 오래된 데이터 정리 (직전 세대만 보관)
  OLD=$((GEN - 1))
  [ "$OLD" -ge 1 ] && rm -f "$RL/g${OLD}_"*.jsonl
done
echo "$(date '+%H:%M:%S') LOOP DONE gen=$GEN" >> "$RL/loop.log"
