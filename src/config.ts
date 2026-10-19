// Echo configuration: everything a user tunes lives in .env (see .env.example).
import "dotenv/config";
import fs from "node:fs";

export interface EchoConfig {
  privateKey?: `0x${string}`;
  rpcUrl: string;
  indexerUrl: string;
  explorerUrl: string;
  dataDir: string;
  dryRun: boolean;
  /** Accounts to mirror (lowercase). Empty = top N from leaders.json. */
  leaders: string[];
  /** How many leaders to follow when LEADERS is empty. */
  followTop: number;
  /** Fraction of our equity that mirrors each leader's equity (1.0 = same size as they trade relative to their equity). */
  copyScale: number;
  /** Hard caps. */
  maxLeverage: number;        // gross notional / equity
  maxMarketNotionalPct: number; // one market's notional / equity
  maxTradeNotionalUsd: number; // single order
  minTradeNotionalUsd: number; // skip dust
  slippageBps: number;
  dailyLossStopPct: number;   // pause 24h after losing this % of start-of-day equity
  drawdownFlattenPct: number; // close everything if equity falls this % from peak
  pollMs: number;
  /** Assumed Arena funding per leader when equity can't be read (USDso). */
  leaderFundedUsd: number;
  /** Equity assumed in DRY_RUN when the account holds nothing yet, so the dry run shows real sizing. */
  dryRunEquityUsd: number;
}

export function loadConfig(): EchoConfig {
  const env = process.env;
  let pk = env.PRIVATE_KEY?.trim();
  if (!pk && env.PRIVATE_KEY_FILE) pk = fs.readFileSync(env.PRIVATE_KEY_FILE, "utf8").trim();
  const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);
  return {
    privateKey: pk ? (pk as `0x${string}`) : undefined,
    rpcUrl: env.RPC_URL ?? "https://api.hideki2.infra.testnet.somnia.network",
    indexerUrl: env.INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql",
    explorerUrl: env.EXPLORER_URL ?? "https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app",
    dataDir: env.DATA_DIR ?? "data",
    dryRun: (env.DRY_RUN ?? "true") !== "false",
    leaders: (env.LEADERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    followTop: num("FOLLOW_TOP", 3),
    copyScale: num("COPY_SCALE", 1.0),
    maxLeverage: num("MAX_LEVERAGE", 3),
    maxMarketNotionalPct: num("MAX_MARKET_NOTIONAL_PCT", 150),
    maxTradeNotionalUsd: num("MAX_TRADE_NOTIONAL_USD", 500),
    minTradeNotionalUsd: num("MIN_TRADE_NOTIONAL_USD", 5),
    slippageBps: num("SLIPPAGE_BPS", 30),
    dailyLossStopPct: num("DAILY_LOSS_STOP_PCT", 10),
    drawdownFlattenPct: num("DRAWDOWN_FLATTEN_PCT", 30),
    pollMs: num("POLL_MS", 5000),
    leaderFundedUsd: num("LEADER_FUNDED_USD", 1000),
    dryRunEquityUsd: num("DRY_RUN_EQUITY_USD", 1000),
  };
}
