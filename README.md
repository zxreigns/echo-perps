# echo — copy the best perps traders on dreamDEX, with your own risk budget

**Echo** watches every account trading perps on dreamDEX's Somnia **Tokyo testnet**, ranks them with rules you can read, and mirrors the ones you follow in your own account — scaled to your equity, bounded by caps you set, and with **every decision written up as a card a human can read**: what the leader did, what Echo did, the math, the checks, and the transaction hash.

Built for the [dreamDEX Perps Builder Bounty](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail) (MVP track, category: bots & agents). Testnet only. Not financial advice.

## Who it is for

- Traders who joined the Perps Arena but do not have time to watch 21 markets: pick leaders who are *actually* consistent, let Echo copy them, and read why each trade happened.
- Leaders: a public, verifiable track record on dreamDEX becomes something others can follow — the loop that makes a perps venue sticky.
- Builders: a small, readable codebase on top of `@somnia-chain/markets-sdk` showing the full life of a perps order on Tokyo testnet (sizing against the pool's own rules, IOC orders, live mark, equity reads, the public indexer).

## What it does

1. **`echo leaders`** reads every `PerpPositionChange` on the testnet from dreamDEX's public indexer (hundreds of thousands of rows) and scores each account. An account is *eligible* only if, over the window, it has enough closes, positive realized P&L in **both halves** of the window, a profit factor ≥ 1.3, no single trade carrying most of its profit, a median hold long enough to copy with a few seconds of lag, and a change rate that does not look like a market maker. Every account gets a one-line reason, eligible or not.
2. **`echo follow`** picks the top N eligible leaders (or any addresses you give it).
3. **`echo run`** polls the leaders' position changes every few seconds and mirrors them:
   - a new leader position → our size = their size × (our slice of equity ÷ their equity);
   - an increase/decrease → our copy scales by the same percentage (so it survives the caps we applied earlier);
   - a close or flip → we close our copy;
   - caps on gross leverage, per-market notional, per-order notional and a dust minimum; a daily loss stop (pause 24 h) and a drawdown flatten (close everything, stop a week);
   - sizing is checked against the pool's own `getMaxPerpOrderSize` (margin, voucher allowlist, position caps) and orders go out as IOC at the live pool mark ± slippage.
4. **The journal** (`data/journal.jsonl`) and the **dashboard** (`npm run dashboard`) show every card: mirrored, skipped (and why), risk actions, tx hashes with explorer links, equity curve, the leaders table with their reasons.
5. **`echo replay 24`** dry-runs the last 24 h of your leaders' moves through the same engine, so you can read what Echo *would* have done before you go live.

## Run it

```bash
git clone https://github.com/zxreigns/echo-perps && cd echo-perps
npm install
cp .env.example .env            # add PRIVATE_KEY (a fresh key just for the bot)

npx tsx src/cli.ts leaders      # score the testnet (≈1–2 min), writes data/leaders.json
npx tsx src/cli.ts follow       # follow the top FOLLOW_TOP eligible leaders
npx tsx src/cli.ts replay 24    # dry-run the last 24h of their moves
npx tsx src/cli.ts claim        # one-time 1,000 paper-USDso credit for this key (needs a little STT for gas)
DRY_RUN=false npx tsx src/cli.ts run   # live on Tokyo testnet
npm run dashboard               # http://localhost:4317
```

Gas: the bot key needs a little **STT** on the Tokyo testnet (orders cost ~0.001 STT). There is no public faucet for this chain; ask in the [dreamDEX Discord](https://discord.gg/dreamdex) or top it up from an app wallet (*Link a bot → Send it STT*).

## Architecture

```
src/
  config.ts    .env → EchoConfig (caps, scale, poll, dry-run)
  chain.ts     SomniaMarkets client on hidekiTestnet (chain 50383), market map, unit helpers
  indexer.ts   dreamDEX public indexer (Hasura GraphQL): paged PerpPositionChange reads, cursor polling
  leaders.ts   scoring rules → LeaderStats with plain-English reasons
  mirror.ts    the engine: proportional copy, caps, risk gate, live mark (getPerpHealthSnapshot),
               pool sizing (getMaxPerpOrderSize), IOC orders (trader.placePerpOrder, ORDER_TYPE.MARKET)
  journal.ts   trade cards (jsonl) + state (mirrored sub-positions, cursor, equity, tx hashes)
  cli.ts       leaders | follow | unfollow | replay | claim | run | status | flatten
dashboard/     static dashboard reading data/ (serve.mjs), exportable with scripts/export-dashboard.mjs
```

Why sub-positions per (leader, market): if two leaders hold ETH, Echo keeps one copy per leader and trades the *net* change, so one leader closing never flattens the other's copy — and a copy trimmed by a cap still scales correctly when its leader scales.

Network: Somnia Tokyo testnet = Hideki, chain 50383. RPC `https://api.hideki2.infra.testnet.somnia.network`, indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. SDK `@somnia-chain/markets-sdk` 0.32.1.

## Evidence of building (Tokyo testnet)

Bot account: `0xAfE18B28752DBA89674Fd84D22Ffcb2CAE089E16`

| when (UTC) | what | tx |
|---|---|---|
| _pending gas_ | claim 1,000 paper USDso | _to be added_ |
| _pending gas_ | first mirrored order | _to be added_ |

The full list lives in `data/state.json` → `txHashes`, and each card in `data/journal.jsonl` carries its hash and explorer link.

## X posts

- _to be added_
- _to be added_

## Roadmap

- Leader discovery from the Perps Arena leaderboard handles (needs the app's session token today).
- Mainnet: same code, `NETWORK=mainnet` once dreamDEX perps launch; Echo already reads per-market `baseDecimals`, `tickSize`, `lotSize` and the voucher allowlist from the chain instead of hardcoding anything.
- Stops armed on the exchange (`armBracket` in the dreamDEX bot kit) instead of software-watched.

## License

MIT. Built on the [dreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit) ideas and the Somnia Markets SDK.
