// Pump.fun Replay Sprint — paper bot (burn entry, @gentle-lynx-64).
//
// Strategy: "proven-runner second wave" (see strategy.ts). Entry point is
// main.ts at the repo root, run as `node /bot/main.ts`. Node 22 strips
// types; stdlib only; no install step. The bot speaks the
// agent-fun/replay/v2 NDJSON protocol through the vendored SDK shim
// (vendor/makefun-bot.ts) and is fully deterministic.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
