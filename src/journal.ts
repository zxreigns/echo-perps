// The journal is the product: every decision Echo makes is one card a human can read,
// with the leader's move, our move, the math, the checks, and the transaction hash.
import fs from "node:fs";
import path from "node:path";

export interface TradeCard {
  t: string;                       // ISO time
  kind: "mirror" | "skip" | "risk" | "info" | "error";
  leader?: string;
  market?: string;
  headline: string;                // one line, e.g. "Mirrored @L0908S: long 0.004 ETH at 3,934.1"
  leaderMove?: string;             // what they did
  ourMove?: string;                // what we did
  why: string[];                   // the math and the checks, one per line
  txHash?: string;
  explorer?: string;
  notionalUsd?: number;
  equityUsd?: number;
  dryRun?: boolean;
}

export interface EchoState {
  startedAt: string;
  startEquityUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  dayStartAt: string;
  pausedUntil?: string;
  lastCursorTs: number;
  seenIds: string[];
  /** mirrored sub-positions: key leader|market -> signed base qty (human units) */
  mirrored: Record<string, number>;
  leaders: string[];
  txHashes: string[];
  equity: { t: string; equityUsd: number }[];
}

export class Journal {
  private dir: string;
  constructor(dir: string) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  get journalPath() { return path.join(this.dir, "journal.jsonl"); }
  get statePath() { return path.join(this.dir, "state.json"); }
  card(c: TradeCard) {
    fs.appendFileSync(this.journalPath, JSON.stringify(c) + "\n");
    const tag = c.kind === "mirror" ? "MIRROR" : c.kind.toUpperCase();
    console.log(`[${c.t.slice(11, 19)}] ${tag} ${c.headline}` + (c.txHash ? ` | ${c.txHash}` : ""));
    for (const w of c.why) console.log(`           · ${w}`);
  }
  loadState(init: () => EchoState): EchoState {
    if (fs.existsSync(this.statePath)) return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    const s = init(); this.saveState(s); return s;
  }
  saveState(s: EchoState) { fs.writeFileSync(this.statePath, JSON.stringify(s, null, 2)); }
  readCards(limit = 200): TradeCard[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const lines = fs.readFileSync(this.journalPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  }
}
