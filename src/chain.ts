// One SomniaMarkets client for the Tokyo (Hideki) testnet, plus market helpers.
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets, ORDER_TYPE, type UnifiedMarket } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits, parseUnits } from "viem";
import type { EchoConfig } from "./config.js";

export type Market = UnifiedMarket & {
  poolAddress: `0x${string}`; marginBank: `0x${string}`; baseSymbol: string; baseDecimals: number;
  tickSize: bigint; lotSize: bigint; minQuantity: bigint; markPrice: bigint; markPriceUpdatedAt: bigint | string;
};

export { ORDER_TYPE };

export async function connect(cfg: EchoConfig) {
  const markets = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: cfg.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    ...(cfg.privateKey ? { privateKey: cfg.privateKey } : {}),
  });
  return markets;
}

export async function loadMarkets(markets: SomniaMarkets): Promise<Map<string, Market>> {
  const perps = (await markets.client.listPerpMarkets()) as unknown as Market[];
  const map = new Map<string, Market>();
  for (const m of perps) map.set(m.poolAddress.toLowerCase(), m);
  return map;
}

export const X18 = 10n ** 18n;
export const toUsd = (x18: bigint) => Number(formatUnits(x18, 18));
export const fromBase = (raw: bigint, m: Market) => Number(formatUnits(raw < 0n ? -raw : raw, m.baseDecimals)) * (raw < 0n ? -1 : 1);
export const toBase = (qty: number, m: Market) => parseUnits(qty.toFixed(m.baseDecimals), m.baseDecimals);
export const alignDown = (x: bigint, step: bigint) => (step > 0n ? (x / step) * step : x);
export const markUsd = (m: Market) => toUsd(BigInt(m.markPrice));
export const markAgeSec = (m: Market) => Math.max(0, Math.floor(Date.now() / 1000) - Number(m.markPriceUpdatedAt));
