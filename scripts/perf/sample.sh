#!/bin/bash
# Usage: PGURL=postgres://user:password@127.0.0.1:5432/db sample.sh <seconds> <outfile>
# 1 Hz samples of gateway CPU ticks, RSS, threads and PostgreSQL commits
end=$(( $(date +%s) + $1 ))
: > "$2"
while [ $(date +%s) -lt $end ]; do
  pids=$(pgrep -f 'claude gateway' | tr '\n' ' ')
  ticks=0; rss=0; thr=0
  for p in $pids; do
    read -r ut st <<< "$(awk '{print $14, $15}' /proc/$p/stat 2>/dev/null)"
    ticks=$(( ticks + ${ut:-0} + ${st:-0} ))
    r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); rss=$(( rss + ${r:-0} ))
    t=$(awk '/Threads/{print $2}' /proc/$p/status 2>/dev/null); thr=$(( thr + ${t:-0} ))
  done
  x=$(psql "$PGURL" -Atc "select xact_commit from pg_stat_database where datname=current_database()" 2>/dev/null)
  c=$(psql "$PGURL" -Atc "select count(*) from pg_stat_activity where datname=current_database()" 2>/dev/null)
  echo "{\"t\":$(date +%s.%N),\"pids\":\"$pids\",\"ticks\":$ticks,\"rssKb\":$rss,\"threads\":$thr,\"xact\":${x:-0},\"conns\":${c:-0}}" >> "$2"
  sleep 1
done