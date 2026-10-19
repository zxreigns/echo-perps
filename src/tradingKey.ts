// Trading-key mode: Echo's key trades FOR a dreamDEX account it was linked to
// (app: wallet → Link a bot → Perps). The link is an operator grant on every perp
// pool for placeOrderFor / cancelOrderFor / reduceOrderFor; margin locks from the
// owner's MarginBank and fills settle to the owner. The key only pays gas.
// The markets SDK has no perp `…For` writes, so the call is sent with viem.
// Shape follows dreamDEX's open-source bot kit (packages/perp-core/src/operator.ts, MIT).
import { contractErrorsAbi, decodePlaceOrder } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, createWalletClient, http, parseAbi, type PrivateKeyAccount, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const TRADING_KEY_SELECTOR = { placeOrderFor: "0x80054449", cancelOrderFor: "0xe37b444b", reduceOrderFor: "0x364c2587" } as const;

const OPERATOR_ABI = [
  ...parseAbi([
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrderFor(address owner, uint128 orderId)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  ]),
  ...contractErrorsAbi,
] as const;

const ORDER_GAS = 10_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const farFutureNs = () => BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 3600) * 1_000_000_000n;

export interface TradingKey { owner: `0x${string}`; operator: `0x${string}`; account: PrivateKeyAccount; publicClient: PublicClient; walletClient: WalletClient }

export function createTradingKey(owner: `0x${string}`, privateKey: `0x${string}`, rpcUrl: string): TradingKey {
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() === owner.toLowerCase()) throw new Error("OWNER_ADDRESS is this key's own address; leave it blank to trade the key's own account");
  const transport = http(rpcUrl);
  return { owner, operator: account.address, account, publicClient: createPublicClient({ chain: hidekiTestnet, transport }) as PublicClient, walletClient: createWalletClient({ account, chain: hidekiTestnet, transport }) };
}

/** What the pool itself says this key may do for the owner. */
export async function linkStatus(key: TradingKey, pool: `0x${string}`) {
  const ask = (sel: `0x${string}`) => key.publicClient.readContract({ address: pool, abi: OPERATOR_ABI, functionName: "isOperatorAuthorized", args: [key.owner, key.operator, sel] }) as Promise<boolean>;
  const [place, cancel, reduce] = await Promise.all([ask(TRADING_KEY_SELECTOR.placeOrderFor), ask(TRADING_KEY_SELECTOR.cancelOrderFor), ask(TRADING_KEY_SELECTOR.reduceOrderFor)]);
  return { place, cancel, reduce };
}

/** placeOrderFor on a perp pool: simulate (so a revert arrives as its named error), send, wait, decode fills. */
export async function placeFor(key: TradingKey, p: { pool: `0x${string}`; isBid: boolean; price: bigint; quantity: bigint; orderType: number }) {
  const { request } = await key.publicClient.simulateContract({ address: p.pool, abi: OPERATOR_ABI, functionName: "placeOrderFor", args: [key.owner, p.isBid, 0n, p.price, p.quantity, farFutureNs(), p.orderType, 0, ZERO, 0n], account: key.account, gas: ORDER_GAS });
  const hash = await key.walletClient.writeContract(request as never);
  const receipt = await key.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`placeOrderFor REVERTED on-chain (tx ${hash})`);
  const { orderId, fills } = decodePlaceOrder(receipt as any, p.pool);
  return { hash, orderId, fills };
}
