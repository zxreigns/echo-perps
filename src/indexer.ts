// Reads of the public dreamDEX indexer (Hasura GraphQL). Every leader's position
// change on Tokyo testnet is public here, which is what makes copy-trading possible
// without any leader opting in.
export interface PositionChange {
  id: string; account: string; kind: "OPEN" | "INCREASE" | "REDUCE" | "CLOSE" | "FLIP";
  market_id: string; pool: string; sizeBefore: bigint; sizeAfter: bigint; closedSize: bigint;
  exitPrice: bigint | null; realizedPnl: bigint; timestamp: number; txHash: string; logIndex: number;
}

export class Indexer {
  constructor(private url: string) {}

  async query<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error("indexer: " + json.errors.map((e) => e.message).join("; "));
    return json.data as T;
  }

  private parse(r: any): PositionChange {
    return { id: r.id, account: r.account.toLowerCase(), kind: r.kind, market_id: r.market_id.toLowerCase(), pool: (r.pool ?? r.market_id).toLowerCase(),
      sizeBefore: BigInt(r.sizeBefore), sizeAfter: BigInt(r.sizeAfter), closedSize: BigInt(r.closedSize ?? 0), exitPrice: r.exitPrice == null ? null : BigInt(r.exitPrice),
      realizedPnl: BigInt(r.realizedPnl), timestamp: Number(r.timestamp), txHash: r.txHash, logIndex: Number(r.logIndex ?? 0) };
  }

  /** Every position change since `since` (unix s), newest first, paged. */
  async changesSince(since: number, opts: { accounts?: string[]; kinds?: string[]; maxRows?: number } = {}): Promise<PositionChange[]> {
    const out: PositionChange[] = [];
    let before: number | null = null;
    const limit = 5000;
    const kinds = opts.kinds ? `, kind: {_in: [${opts.kinds.join(",")}]}` : "";
    const accs = opts.accounts?.length ? `, account: {_in: $accounts}` : "";
    for (;;) {
      const ts: string = before === null ? `{_gte: $since}` : `{_gte: $since, _lt: $before}`;
      const q: string = `query($since: numeric!${before === null ? "" : ", $before: numeric!"}${opts.accounts?.length ? ", $accounts: [String!]" : ""}) {
        PerpPositionChange(where: {timestamp: ${ts}${kinds}${accs}}, order_by: {timestamp: desc}, limit: ${limit}) {
          id account kind market_id pool sizeBefore sizeAfter closedSize exitPrice realizedPnl timestamp txHash logIndex } }`;
      const d: { PerpPositionChange: any[] } = await this.query(q, { since, ...(before === null ? {} : { before }), ...(opts.accounts?.length ? { accounts: opts.accounts } : {}) });
      const rows: PositionChange[] = d.PerpPositionChange.map((r: any) => this.parse(r));
      out.push(...rows);
      if (rows.length < limit || out.length >= (opts.maxRows ?? 400_000)) break;
      before = rows[rows.length - 1].timestamp;
    }
    return out;
  }

  /** Changes after a given (timestamp, id) cursor for a set of accounts, oldest first. */
  async changesAfter(sinceTs: number, accounts: string[], seen: Set<string>): Promise<PositionChange[]> {
    const q: string = `query($since: numeric!, $accounts: [String!]) {
      PerpPositionChange(where: {timestamp: {_gte: $since}, account: {_in: $accounts}}, order_by: {timestamp: asc, logIndex: asc}, limit: 500) {
        id account kind market_id pool sizeBefore sizeAfter closedSize exitPrice realizedPnl timestamp txHash logIndex } }`;
    const d = await this.query<{ PerpPositionChange: any[] }>(q, { since: sinceTs, accounts });
    return d.PerpPositionChange.map((r) => this.parse(r)).filter((c) => !seen.has(c.id));
  }

  /** Open positions of an account, from the indexer. */
  async positions(account: string): Promise<{ market_id: string; size: bigint; isLong: boolean; entryPriceX18: bigint }[]> {
    const d = await this.query<{ PerpPosition: any[] }>(`query($a: String!){ PerpPosition(where: {account: {_eq: $a}, size: {_gt: "0"}}) { market_id size isLong entryPriceX18 } }`, { a: account });
    return d.PerpPosition.map((p) => ({ market_id: p.market_id.toLowerCase(), size: BigInt(p.size), isLong: p.isLong, entryPriceX18: BigInt(p.entryPriceX18) }));
  }
}
