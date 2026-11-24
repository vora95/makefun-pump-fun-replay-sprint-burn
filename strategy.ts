// Second-wave bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// STRATEGY — "proven-runner dip-buy" (deliberately different from the house
// pilots: momentum buys accelerating strength at highs, reversion buys ANY
// sharp dip off a 2500-slot high, sniper buys at launch). This bot buys ONLY
// dips on coins that already proved they can run:
//
//   1. PROOF: the coin's price peaked at >= 2x its creation price.
//   2. DIP: it has since pulled back >= 30% from that peak — and the bot
//      buys INTO the dip, at the dip, not after a reclaim.
//
// The reclaim filter was tested and REJECTED by backtest: waiting for price
// to reclaim 12% off the dip low loses money on the dev window (net -1.1 SOL
// over 95 trips in the Python sweep; the TS sim agreed at -2.2 SOL), because
// by the time a reclaim prints, the bounce is over. Buying the dip itself is
// net +2.0 SOL over 126 trips in the same sweep (TP 1.15x, stop 0.90x, max
// hold 600 slots). Quality filters keep it off the worst coins: >= 8 distinct
// buyers, >= 15 trades, age 50-7200 slots, creator has not sold.
//
// Exits are all-in and fast, because the dev data shows runners give gains
// back within minutes (median coin ends at 0.48x its dip-buy price 3600 slots
// later): sell everything at +25%, hard stop -10%, max hold 600 slots
// (~4 min). One shot per coin, 0.25 SOL per entry (capped at 1% of the coin's
// real SOL reserve, minimum 0.15 SOL), at most 5 open positions. (Dev-window
// sweep: TP +15% also works, but +25% with a 0.15 SOL minimum stake is the
// only variant net positive at both 1x and 2x fees: +0.058 SOL, 33 coins,
// drawdown 2.5%.)
//
// PACE GUARDRAIL: the competition requires a >= 0.01 SOL round trip on >= 20
// distinct mints and <= 50% max drawdown. If distinct coins traded lag behind
// slot progress, the entry thresholds relax in deterministic tiers (all inputs
// are slot numbers and counts from the replay itself — no clock, no random).
//
// DETERMINISM: every decision derives from the replay events; the hello seed
// is unused, no clock / Math.random / env. The same replay yields the same
// orders, so the two house executions match byte-for-byte.
//
// NOTE on the dev data (kit dataset, 2026-11-02 -> 03, 1222 coins): the median
// coin peaks only 7 slots after creation and only 43 of 1222 end >= 2x, so
// holding runners is a losing game — this bot takes its profit in one quick
// tranche and exits fast instead of waiting for a second leg.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL staked per entry, before the 1%-of-real-reserve cap. */
  stakeLamports: bigint;
  /** Skip an entry if the reserve cap makes the stake smaller than this. */
  minStakeLamports: bigint;
  /** Entry tier 0: peak must be >= this multiple of the creation price. */
  peakMinX: number;
  /** Entry tier 0: price must have pulled back >= this fraction from peak. */
  pullbackMin: number;
  /** Minimum distinct wallets that bought the coin before entry. */
  minDistinctBuyers: number;
  /** Minimum trades seen before entry. */
  minTrades: number;
  /** Youngest / oldest age (slots) at which a coin may be entered. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Sell everything once mark value reaches this multiple of cost. */
  tpX: number;
  /** Hard stop: sell all if mark value falls to this multiple of cost. */
  stopX: number;
  /** Max hold in slots; sell all when exceeded. */
  maxHoldSlots: number;
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 250_000_000n,
  // 0.15 SOL: only trade coins whose real SOL reserve is >= 15 SOL at entry.
  // The local sweep showed smaller stakes lose money on thin curves (own
  // fills move the price + curve/tx fees dominate); 0.15 SOL is the smallest
  // stake that stays net positive on the dev window (+0.058 SOL, 33 coins).
  minStakeLamports: 150_000_000n,
  peakMinX: 2.0,
  pullbackMin: 0.3,
  minDistinctBuyers: 8,
  minTrades: 15,
  minAgeSlots: 50,
  maxAgeSlots: 7200,
  tpX: 1.25,
  stopX: 0.9,
  maxHoldSlots: 600,
  buySlippageBps: 500,
  sellSlippageBps: 1000,
};

/** Relaxed entry tiers applied when distinct coins traded lag slot progress. */
const RELAXED_TIERS = [
  { afterProgress: 0.25, needTraded: 5, peakMinX: 1.6, pullbackMin: 0.2 },
  { afterProgress: 0.5, needTraded: 10, peakMinX: 1.4, pullbackMin: 0.15 },
  { afterProgress: 0.75, needTraded: 15, peakMinX: 1.3, pullbackMin: 0.12 },
] as const;

/** A 24h replay is ~400k slots; used only to measure pace progress. */
const WINDOW_SLOTS = 400_000;

interface Coin {
  mint: string;
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  peak: number;
  dipLow: number;
  trades: number;
  distinctBuyers: Set<string>;
  creatorSold: boolean;
  complete: boolean;
  traded: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<string, Coin>();
  const buySlotByMint = new Map<string, number>();
  let firstSlot = 0;
  let tradedCount = 0;

  function coinFor(mint: string): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createdSlot: null,
        creator: null,
        createPrice: 0,
        peak: 0,
        dipLow: Number.POSITIVE_INFINITY,
        trades: 0,
        distinctBuyers: new Set<string>(),
        creatorSold: false,
        complete: false,
        traded: false,
      };
      coins.set(mint, c);
    }
    return c;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot === 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // --- 1. Absorb the batch's events into the per-coin tape. ---
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        const c = coinFor(ev.mint);
        c.createdSlot = ev.slot;
        c.creator = ev.creator;
        const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        c.createPrice = p;
        c.peak = p;
        c.dipLow = Number.POSITIVE_INFINITY;
      } else if (ev.event === 'TradeEvent') {
        const c = coinFor(ev.mint);
        const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        c.trades += 1;
        if (ev.is_buy) {
          c.distinctBuyers.add(ev.user);
        } else if (c.creator !== null && ev.user === c.creator) {
          c.creatorSold = true;
        }
        if (c.peak > 0 && p > c.peak) {
          // New peak: the old dip is stale, restart the dip watch here.
          c.peak = p;
          c.dipLow = Number.POSITIVE_INFINITY;
        } else if (c.peak > 0 && p < c.peak) {
          if (p < c.dipLow) c.dipLow = p;
        }
      } else if (ev.event === 'CompleteEvent') {
        coinFor(ev.mint).complete = true;
      }
    }

    // --- 2. Rejected buys free the coin for a later retry. ---
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') {
        const c = coins.get(f.mint);
        if (c !== undefined && c.traded) {
          c.traded = false;
          tradedCount -= 1;
        }
      }
    }

    // --- 3. Exits first: manage every open position from its mark. ---
    // state.positions is a Map<mint, Holding>; iterate entries, not values.
    const held = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      held.add(mint);
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      const price = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
      if (price <= 0 || pos.token_amount <= 0n) continue;
      const value = (pos.token_amount * BigInt(Math.floor(price * 1e9))) / 1_000_000_000n;
      const cost = pos.cost_lamports > 0n ? pos.cost_lamports : 1n;
      const ratio = Number(value) / Number(cost);
      // Start the hold timer when the position is first SEEN held, not when
      // the buy order was sent (the fill lands 2 slots later; setting it at
      // order time lets the cleanup delete it before the fill arrives).
      let buySlot = buySlotByMint.get(mint);
      if (buySlot === undefined) {
        buySlot = slot;
        buySlotByMint.set(mint, buySlot);
      }
      if (ratio >= params.tpX || ratio <= params.stopX || slot - buySlot >= params.maxHoldSlots) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: params.sellSlippageBps });
      }
    }
    for (const mint of [...buySlotByMint.keys()]) {
      if (!held.has(mint)) buySlotByMint.delete(mint);
    }

    // --- 4. Entries: proven-runner dip-buy, at the dip. ---
    const progress = Math.min(1, Math.max(0, (slot - firstSlot) / WINDOW_SLOTS));
    let peakMinX = params.peakMinX;
    let pullbackMin = params.pullbackMin;
    for (const tier of RELAXED_TIERS) {
      if (progress > tier.afterProgress && tradedCount < tier.needTraded) {
        peakMinX = tier.peakMinX;
        pullbackMin = tier.pullbackMin;
      }
    }

    if (state.committedPositionCount() < 5 && orders.length < 16) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= 5) break;
        const c = coins.get(mint);
        if (c === undefined || c.complete || c.traded || held.has(mint)) continue;
        if (c.createdSlot === null || c.createPrice <= 0 || c.peak <= 0) continue;
        const age = slot - c.createdSlot;
        if (age < params.minAgeSlots || age > params.maxAgeSlots) continue;
        if (c.trades < params.minTrades) continue;
        if (c.distinctBuyers.size < params.minDistinctBuyers) continue;
        if (c.creatorSold) continue;
        // Proof: peaked high enough above the creation price.
        if (c.peak < c.createPrice * peakMinX) continue;
        // Dip: pulled back far enough from the peak, and we are IN the dip now.
        if (c.dipLow === Number.POSITIVE_INFINITY || c.dipLow > c.peak * (1 - pullbackMin)) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || price > c.peak * (1 - pullbackMin)) continue;
        // Size: 0.25 SOL, capped at 1% of real SOL reserve, skip if too small.
        const cap = state.maxBuyLamports(mint);
        const stake = params.stakeLamports < cap ? params.stakeLamports : cap;
        if (stake < params.minStakeLamports) continue;
        if (state.freeCashLamports() < stake + 105_000n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.buySlippageBps });
        c.traded = true;
        tradedCount += 1;
      }
    }

    return orders;
  }

  return { onBatch };
}
