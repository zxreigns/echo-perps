// The mirror engine: watch the followed leaders' public position changes and
// reproduce them in our own account, scaled to our equity and bounded by our caps.
// Every decision, including the ones we DON'T take, becomes a journal card.
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { ORDER_TYPE, type Market, fromBase, toBase, alignDown, markUsd, markAgeSec, toUsd, X18 } from "./chain.js";
import type { EchoConfig } from "./config.js";
import { Indexer, type PositionChange } from "./indexer.js";
import { Journal, type EchoState, type TradeCard } from "./journal.js";

const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const nowIso = () => new Date().toISOString();

export class Mirror {
  private seen = new Set<string>();
  private leaderEquity = new Map<string, number>();
  constructor(private cfg: EchoConfig, private markets: SomniaMarkets, private ix: Indexer, private mk: Map<string, Market>, private j: Journal, private state: EchoState, private account: `0x${string}`) {
    for (const id of state.seenIds) this.seen.add(id);
  }

  explorerTx(h: string) { return `${this.cfg.explorerUrl}/tx/${h}`; }

  /** The mark the POOL acts on, read from the chain; undefined when the oracle is stale (opens are refused then). */
  async liveMark(m: Market): Promise<{ mark: number; raw: bigint } | undefined> {
    try {
      const snap: any = await this.markets.client.getPerpHealthSnapshot(m.poolAddress);
      if (!snap.priceable) return undefined;
      const raw = BigInt(snap.markPrice); if (raw <= 0n) return undefined;
      return { mark: toUsd(raw), raw };
    } catch { return undefined; }
  }

  /** Our perps equity in USDso (collateral + unrealized), from the MarginBank. */
  async equityUsd(): Promise<number> {
    const bank = [...this.mk.values()][0].marginBank;
    const eq = await this.markets.client.tryGetPerpAccountEquity(bank, this.account);
    const v = eq === null ? 0 : toUsd(eq);
    return v === 0 && this.cfg.dryRun ? this.cfg.dryRunEquityUsd : v;
  }

  /** Our live positions per pool, signed human units. */
  async ourPositions(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const m of this.mk.values()) {
      try {
        const p = await this.markets.client.getPerpPosition({ marginBank: m.marginBank, account: this.account, pool: m.poolAddress });
        if (p.size !== 0n) out.set(m.poolAddress.toLowerCase(), fromBase(p.size, m));
      } catch { /* no position */ }
    }
    return out;
  }

  /** Estimate a leader's equity: Arena funding + realized P&L we have seen. Good enough for scaling; capped by our own rules anyway. */
  async leaderEquityUsd(leader: string): Promise<number> {
    const cached = this.leaderEquity.get(leader);
    if (cached) return cached;
    let eq = this.cfg.leaderFundedUsd;
    try {
      const bank = [...this.mk.values()][0].marginBank;
      const e = await this.markets.client.tryGetPerpAccountEquity(bank, leader as `0x${string}`);
      if (e !== null && e > 0n) eq = toUsd(e);
    } catch { /* keep the assumption */ }
    this.leaderEquity.set(leader, eq);
    return eq;
  }

  netMirrored(pool: string): number {
    let s = 0;
    for (const [k, v] of Object.entries(this.state.mirrored)) if (k.endsWith("|" + pool)) s += v;
    return s;
  }
  grossMirroredUsd(): number {
    let s = 0;
    for (const [k, v] of Object.entries(this.state.mirrored)) { const m = this.mk.get(k.split("|")[1]); if (m) s += Math.abs(v) * markUsd(m); }
    return s;
  }

  /** One leader change -> at most one order of ours. */
  async handle(c: PositionChange, equity: number) {
    const m = this.mk.get(c.pool) ?? this.mk.get(c.market_id);
    const leader = c.account; const key = `${leader}|${(m?.poolAddress ?? c.pool).toLowerCase()}`;
    const t = nowIso();
    const base: Partial<TradeCard> = { t, leader, market: m?.baseSymbol ?? c.market_id, equityUsd: equity, dryRun: this.cfg.dryRun };
    if (!m) { this.j.card({ ...base, kind: "skip", headline: `Skipped ${short(leader)}: unknown market ${c.market_id}`, why: ["market is not in the live perps list"] } as TradeCard); return; }

    const before = fromBase(c.sizeBefore, m), after = fromBase(c.sizeAfter, m);
    const live = await this.liveMark(m);
    const mark = live?.mark ?? markUsd(m);
    const markRaw = live?.raw ?? BigInt(m.markPrice);
    const px = c.exitPrice ? toUsd(c.exitPrice) : mark;
    const leaderMove = `${short(leader)} ${c.kind.toLowerCase()} ${m.baseSymbol}: ${fmt(before, 6)} → ${fmt(after, 6)} ${m.baseSymbol} (${fmt(after * mark, 0)} USDso at mark)` + (c.realizedPnl !== 0n ? `, realized ${toUsd(c.realizedPnl) >= 0 ? "+" : ""}${fmt(toUsd(c.realizedPnl))} USDso` : "");
    const why: string[] = [];

    // 1. What should OUR sub-position for this leader+market be?
    const ours = this.state.mirrored[key] ?? 0;
    let target: number;
    if (after === 0 || (c.kind === "FLIP")) {
      // close everything we hold for them here (a flip re-opens below on the next change we see; keep it simple and safe)
      target = 0; why.push(after === 0 ? "they are flat now, so we close our copy of this position" : "they flipped direction; we close our copy first and open the new side on their next change");
    } else if (before !== 0 && ours !== 0 && Math.sign(before) === Math.sign(after)) {
      // scale our copy by the same fraction they scaled theirs: survives the caps we applied earlier
      target = ours * (after / before);
      why.push(`they changed size by ${fmt((after / before - 1) * 100, 1)}%, so our copy goes from ${fmt(ours, 6)} to ${fmt(target, 6)} ${m.baseSymbol}`);
    } else {
      const leq = await this.leaderEquityUsd(leader);
      const slice = equity * this.cfg.copyScale / Math.max(1, this.state.leaders.length);
      const ratio = slice / leq;
      target = after * ratio;
      why.push(`new position for us: their ${fmt(after, 6)} ${m.baseSymbol} on ~${fmt(leq, 0)} USDso equity × our slice ${fmt(slice, 0)} USDso (${fmt(equity, 0)} equity × ${this.cfg.copyScale} scale ÷ ${this.state.leaders.length} leaders) → ratio ${ratio.toFixed(4)} → ${fmt(target, 6)} ${m.baseSymbol}`);
    }

    // 2. Caps, applied to the resulting net position in this market.
    const netBefore = this.netMirrored(m.poolAddress.toLowerCase());
    let netAfter = netBefore - ours + target;
    const perMarketCap = equity * this.cfg.maxMarketNotionalPct / 100;
    if (Math.abs(netAfter) * mark > perMarketCap && Math.abs(netAfter) > Math.abs(netBefore)) {
      const capped = Math.sign(netAfter) * perMarketCap / mark; why.push(`per-market cap ${fmt(perMarketCap, 0)} USDso (${this.cfg.maxMarketNotionalPct}% of equity) trims ${fmt(Math.abs(netAfter) * mark, 0)} → ${fmt(perMarketCap, 0)} USDso`);
      target = target + (capped - netAfter); netAfter = capped;
    }
    const grossOther = this.grossMirroredUsd() - Math.abs(netBefore) * mark;
    const levCap = equity * this.cfg.maxLeverage;
    if (grossOther + Math.abs(netAfter) * mark > levCap && Math.abs(netAfter) > Math.abs(netBefore)) {
      const room = Math.max(0, levCap - grossOther) / mark; const capped = Math.sign(netAfter) * Math.min(Math.abs(netAfter), room);
      why.push(`leverage cap ${this.cfg.maxLeverage}x (gross would be ${fmt(grossOther + Math.abs(netAfter) * mark, 0)} vs ${fmt(levCap, 0)} USDso allowed) trims the add to ${fmt(Math.max(0, Math.abs(capped) - Math.abs(netBefore)) * mark, 0)} USDso`);
      target = target + (capped - netAfter); netAfter = capped;
    }
    let delta = netAfter - netBefore; // signed base units to trade
    let notional = Math.abs(delta) * mark;
    if (notional > this.cfg.maxTradeNotionalUsd) { const s = this.cfg.maxTradeNotionalUsd / notional; why.push(`single-order cap ${this.cfg.maxTradeNotionalUsd} USDso trims this order`); delta *= s; target = ours + (netAfter - netBefore) * s; netAfter = netBefore + delta; notional = Math.abs(delta) * mark; }
    if (notional < this.cfg.minTradeNotionalUsd) {
      this.j.card({ ...base, kind: "skip", headline: `Skipped ${short(leader)} ${c.kind.toLowerCase()} ${m.baseSymbol}: our share would be ${fmt(notional, 2)} USDso, under the ${this.cfg.minTradeNotionalUsd} USDso minimum`, leaderMove, why } as TradeCard);
      this.state.mirrored[key] = Math.abs(target) < 1e-9 ? 0 : target; // remember the intent so later reductions scale correctly
      return;
    }
    const age = live ? 0 : markAgeSec(m);
    if (!live && age > 120) { this.j.card({ ...base, kind: "skip", headline: `Skipped ${m.baseSymbol}: the pool's mark is stale (${age}s), opens are refused`, leaderMove, why: [...why, "we never trade on a stale mark"] } as TradeCard); return; }

    // 3. Size against the pool's own rule (it knows margin, voucher allowlist, position caps).
    const side = delta > 0 ? "long" : "short";
    const slip = BigInt(this.cfg.slippageBps);
    const rawPrice = markRaw;
    const priceUnaligned = side === "long" ? (rawPrice * (10_000n + slip)) / 10_000n : (rawPrice * (10_000n - slip)) / 10_000n;
    const price = alignDown(priceUnaligned, BigInt(m.tickSize));
    let qty = alignDown(toBase(Math.abs(delta), m), BigInt(m.lotSize));
    const isReduce = Math.sign(netBefore) !== 0 && Math.sign(delta) !== Math.sign(netBefore);
    let limitedBy = "";
    try {
      const max: any = await this.markets.client.getMaxPerpOrderSize({ pool: m.poolAddress, marginBank: m.marginBank, account: this.account, isBid: side === "long", price });
      limitedBy = String(max.limitedBy ?? "");
      if (!max.priceable) { this.j.card({ ...base, kind: "skip", headline: `Skipped ${m.baseSymbol}: pool reports no live mark`, leaderMove, why } as TradeCard); return; }
      if (!max.placeable && !isReduce && this.cfg.dryRun && limitedBy === "collateral") { why.push("dry-run: the account holds no margin yet, so the pool's own sizing is skipped"); }
      else if (!max.placeable && !isReduce) { this.j.card({ ...base, kind: "skip", headline: `Skipped ${m.baseSymbol}: pool refuses new size (${limitedBy})`, leaderMove, why: [...why, limitedBy === "voucherBlocked" ? "the paper-USDso credit cannot open positions in this market" : `limited by ${limitedBy}`] } as TradeCard); return; }
      else if (max.placeable && qty > max.maxQuantity) { why.push(`pool caps this order at ${fmt(fromBase(max.maxQuantity, m), 6)} ${m.baseSymbol} (${limitedBy})`); qty = alignDown(max.maxQuantity, BigInt(m.lotSize)); }
    } catch (e) { why.push(`could not pre-size with the pool (${String(e).slice(0, 80)}); sending as computed`); }
    if (qty < BigInt(m.minQuantity)) { this.j.card({ ...base, kind: "skip", headline: `Skipped ${m.baseSymbol}: ${fmt(fromBase(qty, m), 6)} is under the market minimum ${fmt(fromBase(BigInt(m.minQuantity), m), 6)}`, leaderMove, why } as TradeCard); return; }
    const human = fromBase(qty, m);
    const ourMove = `${isReduce ? "reduce" : "open/add"} ${side} ${fmt(human, 6)} ${m.baseSymbol} ≈ ${fmt(human * mark, 2)} USDso, IOC at ${fmt(toUsd(price), 4)} (mark ${fmt(mark, 4)} ± ${this.cfg.slippageBps} bps)`;
    why.push(`checks: gross after ≈ ${fmt((grossOther + Math.abs(netAfter) * mark) / Math.max(1, equity), 2)}x of ${fmt(equity, 0)} USDso equity (cap ${this.cfg.maxLeverage}x); mark read live from the pool; market ${m.baseSymbol}-PERP`);

    if (this.cfg.dryRun) {
      this.j.card({ ...base, kind: "mirror", headline: `[dry-run] would mirror ${short(leader)}: ${side} ${fmt(human, 6)} ${m.baseSymbol}`, leaderMove, ourMove, why, notionalUsd: human * mark } as TradeCard);
      this.state.mirrored[key] = ours + (delta > 0 ? human : -human) * (Math.abs(delta) > 0 ? 1 : 0);
      return;
    }
    try {
      const res: any = await this.markets.trader.placePerpOrder({ pool: m.poolAddress, isBid: side === "long", price, quantity: qty, orderType: ORDER_TYPE.MARKET });
      const hash: string = res.hash ?? res.txHash ?? res.receipt?.transactionHash ?? "";
      const filled = (res.fills ?? []).reduce((s: bigint, f: any) => s + BigInt(f.quantityFilled ?? 0n), 0n);
      const filledH = fromBase(filled, m) || human;
      const signed = delta > 0 ? filledH : -filledH;
      this.state.mirrored[key] = ours + signed;
      if (hash) this.state.txHashes.push(hash);
      this.j.card({ ...base, kind: "mirror", headline: `Mirrored ${short(leader)}: ${side} ${fmt(filledH, 6)} ${m.baseSymbol} at ~${fmt(mark, 2)}`, leaderMove, ourMove, why, txHash: hash, explorer: hash ? this.explorerTx(hash) : undefined, notionalUsd: filledH * mark } as TradeCard);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes("ImmediateOrCancelNoFill")) { this.j.card({ ...base, kind: "skip", headline: `No fill for ${m.baseSymbol}: the book moved; we try again on their next change`, leaderMove, ourMove, why } as TradeCard); return; }
      this.j.card({ ...base, kind: "error", headline: `Order failed for ${m.baseSymbol}: ${msg.slice(0, 160)}`, leaderMove, ourMove, why } as TradeCard);
    }
  }

  /** Close every mirrored position (risk stop or shutdown). */
  async flatten(reason: string) {
    const pos = await this.ourPositions();
    for (const [pool, size] of pos) {
      const m = this.mk.get(pool)!; const side = size > 0 ? "short" : "long"; const mark = markUsd(m);
      const slip = BigInt(this.cfg.slippageBps); const rawPrice = BigInt(m.markPrice);
      const price = alignDown(side === "long" ? (rawPrice * (10_000n + slip)) / 10_000n : (rawPrice * (10_000n - slip)) / 10_000n, BigInt(m.tickSize));
      const qty = alignDown(toBase(Math.abs(size), m), BigInt(m.lotSize));
      if (this.cfg.dryRun) { this.j.card({ t: nowIso(), kind: "risk", market: m.baseSymbol, headline: `[dry-run] would close ${fmt(Math.abs(size), 6)} ${m.baseSymbol}: ${reason}`, why: [reason] }); continue; }
      try {
        const res: any = await this.markets.trader.placePerpOrder({ pool: m.poolAddress, isBid: side === "long", price, quantity: qty, orderType: ORDER_TYPE.MARKET });
        const hash = res.hash ?? res.txHash ?? "";
        if (hash) this.state.txHashes.push(hash);
        this.j.card({ t: nowIso(), kind: "risk", market: m.baseSymbol, headline: `Closed ${fmt(Math.abs(size), 6)} ${m.baseSymbol} at ~${fmt(mark, 2)}: ${reason}`, why: [reason], txHash: hash, explorer: hash ? this.explorerTx(hash) : undefined });
      } catch (e) { this.j.card({ t: nowIso(), kind: "error", market: m.baseSymbol, headline: `Could not close ${m.baseSymbol}: ${String((e as Error).message).slice(0, 160)}`, why: [reason] }); }
    }
    for (const k of Object.keys(this.state.mirrored)) this.state.mirrored[k] = 0;
  }

  /** Risk rules that sit above every leader. Returns true when trading is allowed right now. */
  async riskGate(equity: number): Promise<boolean> {
    const s = this.state; const t = nowIso();
    if (equity > s.peakEquityUsd) s.peakEquityUsd = equity;
    if (new Date(s.dayStartAt).toDateString() !== new Date().toDateString()) { s.dayStartAt = t; s.dayStartEquityUsd = equity; }
    if (s.pausedUntil && new Date(s.pausedUntil) > new Date()) return false;
    if (s.pausedUntil) { s.pausedUntil = undefined; this.j.card({ t, kind: "risk", headline: "Daily pause is over, mirroring resumes", why: [] }); }
    const dd = s.peakEquityUsd > 0 ? (1 - equity / s.peakEquityUsd) * 100 : 0;
    if (dd >= this.cfg.drawdownFlattenPct && Object.values(s.mirrored).some((v) => v !== 0)) {
      this.j.card({ t, kind: "risk", headline: `Drawdown ${fmt(dd, 1)}% from peak ${fmt(s.peakEquityUsd, 0)} → closing everything and stopping`, why: [`rule: flatten at ${this.cfg.drawdownFlattenPct}% drawdown`], equityUsd: equity });
      await this.flatten(`drawdown ${fmt(dd, 1)}% ≥ ${this.cfg.drawdownFlattenPct}%`); s.pausedUntil = new Date(Date.now() + 7 * 86400e3).toISOString(); return false;
    }
    const dayLoss = s.dayStartEquityUsd > 0 ? (1 - equity / s.dayStartEquityUsd) * 100 : 0;
    if (dayLoss >= this.cfg.dailyLossStopPct) {
      this.j.card({ t, kind: "risk", headline: `Lost ${fmt(dayLoss, 1)}% today → closing everything and pausing 24h`, why: [`rule: daily loss stop at ${this.cfg.dailyLossStopPct}%`], equityUsd: equity });
      await this.flatten(`daily loss ${fmt(dayLoss, 1)}% ≥ ${this.cfg.dailyLossStopPct}%`); s.pausedUntil = new Date(Date.now() + 86400e3).toISOString(); return false;
    }
    return true;
  }

  async tick() {
    this.mk = await (await import("./chain.js")).loadMarkets(this.markets); // fresh marks each tick
    const equity = await this.equityUsd();
    this.state.equity.push({ t: nowIso(), equityUsd: equity }); if (this.state.equity.length > 5000) this.state.equity.splice(0, this.state.equity.length - 5000);
    const ok = await this.riskGate(equity);
    const changes = await this.ix.changesAfter(this.state.lastCursorTs, this.state.leaders, this.seen);
    for (const c of changes) {
      this.seen.add(c.id); this.state.seenIds.push(c.id); if (this.state.seenIds.length > 2000) this.state.seenIds.splice(0, 500);
      if (c.timestamp > this.state.lastCursorTs) this.state.lastCursorTs = c.timestamp;
      if (!ok) { this.j.card({ t: nowIso(), kind: "skip", leader: c.account, market: this.mk.get(c.pool)?.baseSymbol, headline: `Ignored ${short(c.account)} ${c.kind.toLowerCase()}: risk pause is active`, why: [] }); continue; }
      await this.handle(c, equity);
    }
    this.j.saveState(this.state);
  }
}
