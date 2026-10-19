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

Echo trades **for your dreamDEX account with a key of its own** (the app's *Link a bot*): open your wallet in the app → *Link a bot* → paste the bot key's address, keep *Perps* ticked, leave *Send it … for gas* on → *Add bot*. The link is an operator grant on every perp pool for `placeOrderFor` / `cancelOrderFor` / `reduceOrderFor`; margin locks from your account, fills settle to your account, and the key can never withdraw or send. Put that account in `OWNER_ADDRESS`. (Leave it blank to trade the key's own MarginBank account instead — on testnet the self-claim of the 1,000 USDso credit is disabled now, so the linked mode is the one that works.)

```bash
git clone https://github.com/zxreigns/echo-perps && cd echo-perps
npm install
cp .env.example .env            # add PRIVATE_KEY (a fresh key just for the bot) and OWNER_ADDRESS (your dreamDEX account)

npx tsx src/cli.ts leaders      # score the testnet (≈1–2 min), writes data/leaders.json
npx tsx src/cli.ts follow       # follow the top FOLLOW_TOP eligible leaders
npx tsx src/cli.ts replay 24    # dry-run the last 24h of their moves
npx tsx src/cli.ts status       # equity, positions, and whether the key is linked on each market
DRY_RUN=false npx tsx src/cli.ts run   # live on Tokyo testnet
npm run dashboard               # http://localhost:4317
```

Gas: the bot key needs a little **STT** on the Tokyo testnet (an order measured ~0.02 STT of gas, so 5 STT is a few hundred orders). There is no public faucet for this chain; ask in the [dreamDEX Discord](https://discord.gg/dreamdex) or top it up from an app wallet (*Link a bot → Send it STT*).

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
  tradingKey.ts placeOrderFor / link checks for the linked-key mode (viem; the SDK has no perp …For writes)
  cli.ts       leaders | follow | unfollow | replay | claim | run | status | flatten
dashboard/     static dashboard reading data/ (serve.mjs), exportable with scripts/export-dashboard.mjs
```

Why sub-positions per (leader, market): if two leaders hold ETH, Echo keeps one copy per leader and trades the *net* change, so one leader closing never flattens the other's copy — and a copy trimmed by a cap still scales correctly when its leader scales.

Network: Somnia Tokyo testnet = Hideki, chain 50383. RPC `https://api.hideki2.infra.testnet.somnia.network`, indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. SDK `@somnia-chain/markets-sdk` 0.32.1.

## Evidence of building (Tokyo testnet)

Account traded: Perps Arena wallet `0x8D2a3f94bd13464D6427a4Db8CB70B10d0D8C3aB` (1,000 paper USDso), through the linked **trading key** `0xAfE18B28752DBA89674Fd84D22Ffcb2CAE089E16` (Echo's own key; it signs `placeOrderFor`, pays gas, and cannot withdraw).

| when (UTC) | what | tx |
|---|---|---|
| 2026-10-19 18:26 | Link a bot (app, Wallet 1 → Perps, every market) + 5 STT gas to the bot key | [`0x1ac24267…8fbf`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x1ac242673165fc5a9b180fbaef37ead588824c52775b4178744cdaab4cef8fbf) |
| 2026-10-19 18:30 | mirror 0x9ca8…210c: short 17,900 PUMP at ~0 (PUMP-PERP, IOC) | [`0x6154640d…8d69`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x6154640d0c870ab3cec2d688838279e569ead75aa183a6d14db4887aef9f8d69) |
| 2026-10-19 18:30 | mirror 0x9ca8…210c: short 3.12 VVV at ~23.94 (VVV-PERP, IOC) | [`0x92d0c99b…21d4`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x92d0c99b7101cef208e4a5bf51df7e56d015ab0bac02ca7eae87cc2c5a6f21d4) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: short 83.1 NEAR at ~4.91 (NEAR-PERP, IOC) | [`0x171ccef4…e800`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x171ccef414f3950df9a70fb0d99f825f855a7e4b6a8879b2f5c1669852f4e800) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: long 38.5 NEAR at ~4.91 (NEAR-PERP, IOC) | [`0xd799c7af…15f3`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xd799c7afb97c5471d326bceb6da1e3cd32a04ac4a160940fd2db7d322c0915f3) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: long 43.6 NEAR at ~4.91 (NEAR-PERP, IOC) | [`0x92d11ec4…6082`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x92d11ec4b768962ab677ceb66494e1b446f10950b9c35618fa174db745cc6082) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: short 21,200 PUMP at ~0 (PUMP-PERP, IOC) | [`0x3ec77dc5…07d2`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x3ec77dc53d095ec909b1d87f6ff4b25c055e313c42a23f76cab74caecea907d2) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: short 5,100 PUMP at ~0 (PUMP-PERP, IOC) | [`0xbafa79db…1c15`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xbafa79db212ac205aae756a63b2caf42b68dc126f2110a3284d3df91453c1c15) |
| 2026-10-19 18:31 | mirror 0x9ca8…210c: long 3.45 HYPE at ~77.82 (HYPE-PERP, IOC) | [`0xe17b67af…fe9c`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xe17b67af4832c990072d1c8259645572eb1ab0774ef3ae5b920b7bb432c8fe9c) |

Echo went live at 18:30:58 UTC on Oct 19 2026 and mirrored 8 moves by leader `0x9ca8…210c` in its first 30 seconds (short PUMP, VVV, NEAR; long HYPE), equity 999.14 USDso after fills. Two earlier `claim` attempts from the bot key reverted with `SelfClaimDisabled()` — the testnet VoucherDistributor no longer lets an address self-claim; the credit now comes with a Perps Arena wallet, which is why the trading-key mode exists. The full list lives in `data/state.json` → `txHashes`, and each card in `data/journal.jsonl` carries its hash and explorer link.

## X posts

- _to be added_
- _to be added_

## Roadmap

- Leader discovery from the Perps Arena leaderboard handles (needs the app's session token today).
- Mainnet: same code, `NETWORK=mainnet` once dreamDEX perps launch; Echo already reads per-market `baseDecimals`, `tickSize`, `lotSize` and the voucher allowlist from the chain instead of hardcoding anything.
- Stops armed on the exchange (`armBracket` in the dreamDEX bot kit) instead of software-watched.

## License

MIT. Built on the [dreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit) ideas and the Somnia Markets SDK.
