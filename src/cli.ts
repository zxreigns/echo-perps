#!/usr/bin/env tsx
// echo — copy the best perps traders on dreamDEX Tokyo testnet, with your own risk budget.
//   echo leaders            score every account on the testnet and write data/leaders.json
//   echo follow <0x…>       add a leader (or pick from leaders.json with FOLLOW_TOP)
//   echo run                mirror the followed leaders (DRY_RUN=true by default)
//   echo status             equity, positions, followed leaders, last cards
//   echo claim              claim the 1,000 paper-USDso credit for this key (once)
//   echo flatten            close every mirrored position now
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { connect, loadMarkets, toUsd, markUsd, fromBase } from "./chain.js";
import { Indexer } from "./indexer.js";
import { scoreLeaders, DEFAULT_RULES } from "./leaders.js";
import { Journal, type EchoState } from "./journal.js";
import { Mirror } from "./mirror.js";

const cfg = loadConfig();
const cmd = process.argv[2] ?? "status";
const j = new Journal(cfg.dataDir);
const say = (s: string) => console.log(s);
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });

async function main() {
  const markets = await connect(cfg);
  const mk = await loadMarkets(markets);
  const ix = new Indexer(cfg.indexerUrl);
  const account = (markets as any).walletAddress as `0x${string}` | undefined;

  if (cmd === "leaders") {
    const rules = { ...DEFAULT_RULES, fundedUsd: cfg.leaderFundedUsd, windowDays: Number(process.env.WINDOW_DAYS ?? DEFAULT_RULES.windowDays) };
    const stats = await scoreLeaders(ix, mk, rules, say);
    const eligible = stats.filter((s) => s.eligible);
    const outPath = path.join(cfg.dataDir, "leaders.json");
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rules, coverage: (stats as any).coverage, scored: stats.length, eligible: eligible.length, leaders: stats.slice(0, 200) }, null, 2));
    say(`\n${stats.length} accounts scored, ${eligible.length} eligible. Top ${Math.min(10, eligible.length)}:\n`);
    for (const s of eligible.slice(0, 10)) say(`${s.account}  score ${fmt(s.score, 0)}  P&L +${fmt(s.realizedPnlUsd, 0)}  ${s.closes} closes  win ${fmt(s.winRate * 100, 0)}%  PF ${fmt(s.profitFactor)}  hold ${fmt(s.medianHoldMin, 0)}m  ~${fmt(s.estLeverage, 1)}x  ${s.markets.slice(0, 5).join(",")}\n    ${s.reasons[0]}`);
    say(`\nwritten to ${outPath}`);
    return;
  }

  const state = j.loadState((): EchoState => ({ startedAt: new Date().toISOString(), startEquityUsd: 0, peakEquityUsd: 0, dayStartEquityUsd: 0, dayStartAt: new Date().toISOString(), lastCursorTs: Math.floor(Date.now() / 1000), seenIds: [], mirrored: {}, leaders: [], txHashes: [], equity: [] }));

  if (cmd === "follow") {
    const addrs = process.argv.slice(3).map((a) => a.toLowerCase());
    if (addrs.length) { for (const a of addrs) if (!state.leaders.includes(a)) state.leaders.push(a); }
    else {
      const lp = path.join(cfg.dataDir, "leaders.json");
      if (!fs.existsSync(lp)) throw new Error("run `echo leaders` first, or pass addresses");
      const top = JSON.parse(fs.readFileSync(lp, "utf8")).leaders.filter((l: any) => l.eligible).slice(0, cfg.followTop).map((l: any) => l.account);
      state.leaders = top;
    }
    j.saveState(state); say(`following ${state.leaders.length}: ${state.leaders.join(", ")}`); return;
  }
  if (cmd === "unfollow") { const a = (process.argv[3] ?? "").toLowerCase(); state.leaders = state.leaders.filter((x) => x !== a); j.saveState(state); say(`following ${state.leaders.join(", ") || "nobody"}`); return; }

  if (!account) throw new Error("PRIVATE_KEY (or PRIVATE_KEY_FILE) is required for this command");
  const bank = [...mk.values()][0].marginBank;

  if (cmd === "claim") {
    const el = await markets.client.getPerpVoucherEligibility(bank, account);
    if (!el.eligible) { say(`not eligible for the credit: ${JSON.stringify(el, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`); return; }
    const res: any = await markets.trader.claimPerpVoucher({ marginBank: bank });
    say(`claimed ${toUsd(el.grantAmount)} paper USDso; tx ${res.hash ?? res.txHash}`);
    j.card({ t: new Date().toISOString(), kind: "info", headline: `Claimed ${toUsd(el.grantAmount)} paper USDso credit`, why: ["one-time testnet credit from the VoucherDistributor"], txHash: res.hash ?? res.txHash, explorer: `${cfg.explorerUrl}/tx/${res.hash ?? res.txHash}` });
    return;
  }

  if (cfg.leaders.length) state.leaders = cfg.leaders;
  const mirror = new Mirror(cfg, markets, ix, mk, j, state, account);

  if (cmd === "status") {
    const eq = await mirror.equityUsd(); const pos = await mirror.ourPositions();
    const stt = await markets.client.getNativeBalance(account);
    say(`account   ${account}\nequity    ${fmt(eq)} USDso   gas ${fmt(Number(stt) / 1e18, 4)} STT   mode ${cfg.dryRun ? "DRY-RUN" : "LIVE"}`);
    say(`leaders   ${state.leaders.length ? state.leaders.join(", ") : "none (run: echo follow)"}`);
    say(`positions ${pos.size ? [...pos].map(([p, s]) => `${fmt(s, 6)} ${mk.get(p)!.baseSymbol} (${fmt(s * markUsd(mk.get(p)!), 0)} USDso)`).join(", ") : "none"}`);
    say(`tx hashes ${state.txHashes.length}`);
    for (const c of j.readCards(8)) say(`  ${c.t.slice(0, 19)} ${c.kind.padEnd(6)} ${c.headline}`);
    return;
  }
  if (cmd === "replay") {
    // Dry-run the last N hours of the followed leaders' moves through the engine, so you can read what Echo would have done.
    const hours = Number(process.argv[3] ?? 24);
    const rcfg = { ...cfg, dryRun: true, dataDir: path.join(cfg.dataDir, "replay") };
    const rj = new Journal(rcfg.dataDir); try { fs.unlinkSync(rj.journalPath); } catch {}
    const rstate: EchoState = { ...state, mirrored: {}, seenIds: [], txHashes: [], equity: [], lastCursorTs: 0, startEquityUsd: cfg.dryRunEquityUsd, peakEquityUsd: cfg.dryRunEquityUsd, dayStartEquityUsd: cfg.dryRunEquityUsd };
    const rm = new Mirror(rcfg, markets, ix, mk, rj, rstate, account);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = (await ix.changesSince(since, { accounts: state.leaders })).sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex);
    say(`replaying ${rows.length} changes by ${state.leaders.length} leaders over the last ${hours}h (dry-run, ${cfg.dryRunEquityUsd} USDso)`);
    for (const c of rows) await rm.handle(c, cfg.dryRunEquityUsd);
    rj.saveState(rstate);
    const cards = rj.readCards(100000); const mirrors = cards.filter((c) => c.kind === "mirror"); const skips = cards.filter((c) => c.kind === "skip");
    say(`
${mirrors.length} orders would have been sent, ${skips.length} moves skipped. Journal: ${rj.journalPath}`);
    return;
  }
  if (cmd === "flatten") { await mirror.flatten("manual flatten"); j.saveState(state); return; }

  if (cmd === "run") {
    if (!state.leaders.length) throw new Error("nobody to follow: run `echo leaders` then `echo follow`, or set LEADERS");
    const eq = await mirror.equityUsd();
    if (!state.startEquityUsd) { state.startEquityUsd = eq; state.peakEquityUsd = eq; state.dayStartEquityUsd = eq; }
    j.card({ t: new Date().toISOString(), kind: "info", headline: `Echo ${cfg.dryRun ? "dry-run" : "LIVE"} on ${account}: ${fmt(eq)} USDso equity, following ${state.leaders.length} leader(s)`, why: [`caps: ${cfg.maxLeverage}x gross, ${cfg.maxMarketNotionalPct}% per market, ${cfg.maxTradeNotionalUsd} USDso per order, daily stop ${cfg.dailyLossStopPct}%, flatten at ${cfg.drawdownFlattenPct}% drawdown`, `leaders: ${state.leaders.join(", ")}`], equityUsd: eq });
    let stop = false; process.on("SIGINT", () => { stop = true; }); process.on("SIGTERM", () => { stop = true; });
    while (!stop) {
      try { await mirror.tick(); } catch (e) { j.card({ t: new Date().toISOString(), kind: "error", headline: `tick failed: ${String((e as Error).message ?? e).slice(0, 200)}`, why: [] }); }
      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
    j.saveState(state); say("stopped"); return;
  }
  throw new Error(`unknown command ${cmd}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
