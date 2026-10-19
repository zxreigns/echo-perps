// Leader discovery: who on Tokyo testnet is actually worth copying?
// Scores every account from its public position changes, with the rules written
// out so a user can read WHY an account ranks where it does.
import { Indexer, type PositionChange } from "./indexer.js";
import type { Market } from "./chain.js";
import { toUsd, fromBase, markUsd } from "./chain.js";

export interface LeaderStats {
  account: string;
  score: number;
  eligible: boolean;
  reasons: string[];         // why it is / is not eligible, in plain words
  realizedPnlUsd: number;    // over the window
  pnlFirstHalfUsd: number;
  pnlSecondHalfUsd: number;
  closes: number;            // REDUCE/CLOSE/FLIP events with realized pnl
  wins: number;
  winRate: number;
  profitFactor: number;
  biggestWinShare: number;   // largest single realized win / gross wins
  eventsPerDay: number;
  medianHoldMin: number;
  markets: string[];
  maxNotionalUsd: number;    // largest |position| seen, at today's mark
  estLeverage: number;       // maxNotional / assumed funding
  lastActive: number;
}

export interface LeaderRules {
  windowDays: number; minCloses: number; minProfitFactor: number; maxEventsPerDay: number;
  minMedianHoldMin: number; maxBiggestWinShare: number; maxEstLeverage: number; fundedUsd: number;
}
export const DEFAULT_RULES: LeaderRules = { windowDays: 5, minCloses: 8, minProfitFactor: 1.3, maxEventsPerDay: 400, minMedianHoldMin: 5, maxBiggestWinShare: 0.6, maxEstLeverage: 6, fundedUsd: 1000 };

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function scoreLeaders(ix: Indexer, markets: Map<string, Market>, rules: LeaderRules = DEFAULT_RULES, log = (s: string) => {}): Promise<LeaderStats[] & { coverage?: { from: number; to: number; rows: number } }> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - rules.windowDays * 86400;
  log(`reading every position change on Tokyo testnet since ${new Date(since * 1000).toISOString()} …`);
  const rows = await ix.changesSince(since);
  const effSince = rows.length ? Math.max(since, rows[rows.length - 1].timestamp) : since;
  log(`${rows.length} changes by ${new Set(rows.map((r) => r.account)).size} accounts, covering ${((now - effSince) / 3600).toFixed(1)} h (${new Date(effSince * 1000).toISOString()} → now)`);
  const byAcct = new Map<string, PositionChange[]>();
  for (const r of rows) { const a = byAcct.get(r.account) ?? []; a.push(r); byAcct.set(r.account, a); }
  const mid = effSince + (now - effSince) / 2;
  const out: LeaderStats[] = [];
  for (const [account, evs] of byAcct) {
    evs.sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex);
    let pnl = 0, pnl1 = 0, pnl2 = 0, grossWin = 0, grossLoss = 0, closes = 0, wins = 0, biggestWin = 0, maxNotional = 0;
    const mkts = new Set<string>(); const holds: number[] = []; const openedAt = new Map<string, number>();
    for (const e of evs) {
      mkts.add(e.market_id);
      const m = markets.get(e.pool) ?? markets.get(e.market_id);
      if (m) { const notional = Math.abs(fromBase(e.sizeAfter, m)) * markUsd(m); if (notional > maxNotional) maxNotional = notional; }
      if (e.kind === "OPEN" || (e.kind === "INCREASE" && e.sizeBefore === 0n)) openedAt.set(e.market_id, e.timestamp);
      if (e.kind === "FLIP") { const t0 = openedAt.get(e.market_id); if (t0) holds.push((e.timestamp - t0) / 60); openedAt.set(e.market_id, e.timestamp); }
      if (e.kind === "CLOSE") { const t0 = openedAt.get(e.market_id); if (t0) holds.push((e.timestamp - t0) / 60); openedAt.delete(e.market_id); }
      const p = toUsd(e.realizedPnl);
      if (e.kind === "REDUCE" || e.kind === "CLOSE" || e.kind === "FLIP") {
        closes++; pnl += p; (e.timestamp < mid ? (pnl1 += p) : (pnl2 += p));
        if (p > 0) { wins++; grossWin += p; if (p > biggestWin) biggestWin = p; } else grossLoss += -p;
      }
    }
    const days = Math.max(1 / 24, (evs[evs.length - 1].timestamp - evs[0].timestamp) / 86400);
    const eventsPerDay = evs.length / Math.max(days, 1);
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
    const winRate = closes ? wins / closes : 0;
    const biggestWinShare = grossWin > 0 ? biggestWin / grossWin : 0;
    const medianHoldMin = median(holds);
    const estLeverage = maxNotional / rules.fundedUsd;
    const reasons: string[] = [];
    if (closes < rules.minCloses) reasons.push(`only ${closes} closes (need ${rules.minCloses})`);
    if (pnl <= 0) reasons.push(`realized P&L is ${pnl.toFixed(0)} USDso`);
    if (!(pnl1 > 0 && pnl2 > 0)) reasons.push(`not positive in both halves of the window (${pnl1.toFixed(0)} / ${pnl2.toFixed(0)})`);
    if (profitFactor < rules.minProfitFactor) reasons.push(`profit factor ${profitFactor.toFixed(2)} < ${rules.minProfitFactor}`);
    if (eventsPerDay > rules.maxEventsPerDay) reasons.push(`${eventsPerDay.toFixed(0)} changes/day looks like a market maker, not copyable`);
    if (medianHoldMin < rules.minMedianHoldMin) reasons.push(`median hold ${medianHoldMin.toFixed(1)} min is too fast to copy with a few seconds of lag`);
    if (biggestWinShare > rules.maxBiggestWinShare) reasons.push(`${(biggestWinShare * 100).toFixed(0)}% of profit came from one trade`);
    if (estLeverage > rules.maxEstLeverage) reasons.push(`runs ~${estLeverage.toFixed(1)}x on ${rules.fundedUsd} USDso, above the ${rules.maxEstLeverage}x we copy`);
    const eligible = reasons.length === 0;
    if (eligible) reasons.push(`${closes} closes, ${(winRate * 100).toFixed(0)}% wins, profit factor ${profitFactor.toFixed(2)}, +${pnl.toFixed(0)} USDso with both halves positive, median hold ${medianHoldMin.toFixed(0)} min`);
    // Score: consistent money, discounted for luck (few trades, one-trade profits) and for leverage we would have to cap.
    const pfTerm = Math.min(profitFactor, 5) / 5;
    const sizeTerm = Math.min(closes, 60) / 60;
    const luckTerm = 1 - biggestWinShare;
    const levTerm = 1 / Math.max(1, estLeverage / 3);
    const score = eligible ? pnl * pfTerm * (0.5 + 0.5 * sizeTerm) * luckTerm * levTerm : 0;
    out.push({ account, score, eligible, reasons, realizedPnlUsd: pnl, pnlFirstHalfUsd: pnl1, pnlSecondHalfUsd: pnl2, closes, wins, winRate, profitFactor, biggestWinShare, eventsPerDay, medianHoldMin, markets: [...mkts].map((id) => markets.get(id)?.baseSymbol ?? id.slice(0, 8)), maxNotionalUsd: maxNotional, estLeverage, lastActive: evs[evs.length - 1].timestamp });
  }
  out.sort((a, b) => b.score - a.score || b.realizedPnlUsd - a.realizedPnlUsd);
  (out as any).coverage = { from: effSince, to: now, rows: rows.length };
  return out;
}
