#!/bin/zsh
# 자동 체인: c3 신선데이터 15만 대기 → v8 학습(신선+최근 챔피언) → 2단 승단전(v8-PUCT vs v6-PUCT 80판)
set -e
cd "$(dirname "$0")/.."
ML=ml; D=$ML/data
LOG=$D/chain-v8.log
echo "$(date '+%H:%M') chain 시작 (대기 중)" >> $LOG

# 1) 15만 수 대기
until [ $(( $(cat $D/c3_*.jsonl 2>/dev/null | wc -l) + $(cat $D/c3b_*.jsonl 2>/dev/null | wc -l) )) -ge 150000 ]; do sleep 300; done
pkill -f gen-champion.js 2>/dev/null || true
sleep 2
N=$(( $(cat $D/c3_*.jsonl 2>/dev/null | wc -l) + $(cat $D/c3b_*.jsonl 2>/dev/null | wc -l) ))
echo "$(date '+%H:%M') 데이터 $N수 — 생성 종료, v8 학습 시작" >> $LOG

# 2) v8 학습: 신선(c3,c3b) + 최근 챔피언(c2,c2b). 폭 2.0(데이터 효과 격리). 검증 c3b_5
cp $D/c3b_5.jsonl $D/c3val.jsonl
$ML/.venv/bin/python $ML/train_pilot.py \
  $D/c3_0.jsonl $D/c3_1.jsonl $D/c3_2.jsonl $D/c3_3.jsonl $D/c3_4.jsonl $D/c3_5.jsonl \
  $D/c3b_0.jsonl $D/c3b_1.jsonl $D/c3b_2.jsonl $D/c3b_3.jsonl $D/c3b_4.jsonl \
  $D/c2_0.jsonl $D/c2_1.jsonl $D/c2_2.jsonl $D/c2_3.jsonl $D/c2_4.jsonl \
  $D/c2b_0.jsonl $D/c2b_1.jsonl $D/c2b_2.jsonl $D/c2b_3.jsonl $D/c2b_4.jsonl \
  --val $D/c3val.jsonl --width 2.0 --epochs 5 --out $D/v8-weights.pt >> $LOG 2>&1
$ML/.venv/bin/python $ML/export_weights.py $D/v8-weights.pt $D/v8-weights.json >> $LOG 2>&1
echo "$(date '+%H:%M') v8 학습 완료" >> $LOG

# 3) 빠른 지표: v8 vs v6 직접(순신경망, 200판)
/opt/homebrew/bin/node $ML/eval-net.js $D/v8-weights.json "net:$D/v6-weights.json" 6500 6599 2>/dev/null | tail -1 >> $LOG

# 4) 2단 승단전: v8-PUCT vs v6-PUCT(1단) 80판
for i in 0 1 2 3 4 5 6 7; do
  s=$((1 + i*5)); e=$((s + 4))
  /opt/homebrew/bin/node $ML/eval-hybrid.js $D/v8-weights.json "pu:$D/v6-weights.json:1.0" $s $e 950 950 puct 1 1.0 > $D/d2v8_$i.log 2>&1 &
done
wait
RES=$(grep -ho 'games=[0-9]* hyWins=[0-9]*' $D/d2v8_*.log | awk '{split($1,g,"="); split($2,w,"="); G+=g[2]; W+=w[2]} END {printf "%d판 %d승 (%.1f%%)", G, W, 100*W/G}')
echo "$(date '+%H:%M') 2단 승단전 v8-PUCT vs v6-PUCT(1단): $RES" >> $LOG
echo "CHAIN-DONE $RES" >> $LOG
