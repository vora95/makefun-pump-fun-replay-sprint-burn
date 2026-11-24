# Pump.fun Replay Sprint — Paper Bot (burn entry)

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vora95/makefun-pump-fun-replay-sprint-burn/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vora95/makefun-pump-fun-replay-sprint-burn/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

make.fun bounty entry: a paper trading bot that trades 10 SOL of paper money
on a replay of recorded pump.fun activity. No real trading. The bot is scored
by net PnL over a 24h replay window.

## Strategy — proven-runner dip-buy

Buy ONLY dips on coins that already proved they can run: peak >= 2x the
creation price, then a pullback >= 30% from that peak — buy INTO the dip, at
the dip, with >= 8 distinct buyers, >= 15 trades, coin age 50–7200 slots,
and the creator not selling. One shot per coin, 0.25 SOL per entry (capped at
1% of the coin's real SOL reserve), at most 5 open positions.

Exits are all-in and fast: sell everything at +15%, hard stop at -10%, max
hold 600 slots (~4 min). Runners on pump.fun give gains back within minutes,
so the bot takes one quick tranche and leaves.

## Run

```sh
node main.ts
```

Entrypoint `main.ts` at the repo root, run as `node /bot/main.ts` (Node 22
strips types, stdlib only, no install step). It speaks the
agent-fun/replay/v2 NDJSON protocol through the vendored SDK shim
(`vendor/makefun-bot.ts`) and is fully deterministic — no clock, no
`Math.random`, no env — so the two house executions produce identical
action logs.
