/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  totalAmount: number;
  fundedAmount: number;
  releasedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  createdAt: string;
  updatedAt: string;
}

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
}

export type DisputeStatusFilter = 'open' | 'resolved' | 'all';
export type DisputeSort = 'oldest' | 'newest' | 'value';

export interface DisputeView {
  contractId: number;
  title: string;
  client: string;
  freelancer: string;
  raisedBy: string;
  raisedByRole: 'client' | 'freelancer';
  reason: string;
  openedAt: string;
  ageHours: number;
  held: number;
  slaDeadline: string;
  overdue: boolean;
  resolvedAt?: string;
  freelancerBps?: number;
}

export interface DisputeQueue {
  data: DisputeView[];
  summary: { open: number; overdue: number; totalHeld: number };
  page: { limit: number; count: number; nextCursor: string | null };
}

interface DisputeRecord {
  view: DisputeView;
  open: boolean;
}

interface DisputeCursor {
  s: DisputeSort;
  k: string | number;
  i: number;
}

export const DEFAULT_DISPUTE_LIMIT = 20;
export const MAX_DISPUTE_LIMIT = 100;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Public projection of a contract: dispute reasons are only served by the admin dispute routes. */
export function publicContract(
  c: EscrowContract,
): Omit<EscrowContract, 'dispute'> & { dispute?: Omit<Dispute, 'reason'> } {
  if (!c.dispute) return c;
  const { reason: _reason, ...disputeRest } = c.dispute;
  return { ...c, dispute: disputeRest };
}

const encodeCursor = (c: DisputeCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

const decodeCursor = (raw: string): DisputeCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not a valid queue cursor');
  }
  const c = parsed as { s?: unknown; k?: unknown; i?: unknown };
  if (
    (c?.s !== 'oldest' && c?.s !== 'newest' && c?.s !== 'value') ||
    (typeof c?.k !== 'string' && typeof c?.k !== 'number') ||
    !Number.isInteger(c?.i) ||
    (c.i as number) < 1
  ) {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not a valid queue cursor');
  }
  return { s: c.s, k: c.k, i: c.i as number };
};

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): EscrowContract {
    const { client, freelancer } = input;
    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (input.milestones.length > MAX_MILESTONES) {
      throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    }
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });
    const now = this.now().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount: milestones.reduce((s, m) => s + m.amount, 0),
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = this.now().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (c.fundedAmount + amount > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');
    if (c.fundedAmount - c.releasedAmount < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount += m.amount;
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: this.now().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, bpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const bps = Number(bpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer 0..10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    c.releasedAmount += toFreelancer;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    c.dispute.freelancerBps = bps;
    c.dispute.resolvedAt = this.now().toISOString();
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can be rated');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'already_rated', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer 1..5');
    }
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
  }

  getReputation(address: string): Reputation {
    const r = this.reputation.get(address) ?? { completed: 0, total: 0 };
    return {
      address,
      completedContracts: r.completed,
      totalRating: r.total,
      averageRating: r.completed ? Math.round((r.total / r.completed) * 100) / 100 : 0,
    };
  }

  private toDisputeView(c: EscrowContract, now: Date, slaHours: number): DisputeView {
    const dispute = c.dispute;
    if (!dispute) throw new HttpError(404, 'dispute_not_found', `No dispute for contract ${c.id}`);
    const openedMs = Date.parse(dispute.openedAt);
    const ageHours = Math.max(0, Math.round(((now.getTime() - openedMs) / 3_600_000) * 100) / 100);
    const view: DisputeView = {
      contractId: c.id,
      title: c.title,
      client: c.client,
      freelancer: c.freelancer,
      raisedBy: dispute.raisedBy,
      raisedByRole: dispute.raisedBy === c.client ? 'client' : 'freelancer',
      reason: dispute.reason,
      openedAt: dispute.openedAt,
      ageHours,
      held: c.fundedAmount - c.releasedAmount,
      slaDeadline: new Date(openedMs + slaHours * 3_600_000).toISOString(),
      overdue: c.status === 'Disputed' && now.getTime() > openedMs + slaHours * 3_600_000,
    };
    if (dispute.resolvedAt !== undefined) view.resolvedAt = dispute.resolvedAt;
    if (dispute.freelancerBps !== undefined) view.freelancerBps = dispute.freelancerBps;
    return view;
  }

  private compareDisputes(sort: DisputeSort, a: DisputeRecord, b: DisputeRecord): number {
    if (sort === 'value') {
      return b.view.held - a.view.held || a.view.contractId - b.view.contractId;
    }
    const byOpened =
      a.view.openedAt < b.view.openedAt ? -1 : a.view.openedAt > b.view.openedAt ? 1 : 0;
    if (byOpened !== 0) return sort === 'newest' ? -byOpened : byOpened;
    return sort === 'newest' ? b.view.contractId - a.view.contractId : a.view.contractId - b.view.contractId;
  }

  listDisputes(opts: {
    status: DisputeStatusFilter;
    sort: DisputeSort;
    overdueOnly: boolean;
    limit: number;
    cursor?: string;
    now: Date;
    slaHours: number;
  }): DisputeQueue {
    const { status, sort, overdueOnly, limit, cursor, now, slaHours } = opts;
    const records: DisputeRecord[] = [];
    let open = 0;
    let overdue = 0;
    let totalHeld = 0;
    for (const c of this.contracts.values()) {
      if (!c.dispute) continue;
      const record: DisputeRecord = { view: this.toDisputeView(c, now, slaHours), open: c.status === 'Disputed' };
      records.push(record);
      if (record.open) {
        open += 1;
        totalHeld += record.view.held;
        if (record.view.overdue) overdue += 1;
      }
    }
    records.sort((a, b) => this.compareDisputes(sort, a, b));
    const filtered = records.filter(
      (r) =>
        (status === 'all' || (status === 'open' ? r.open : !r.open)) && (!overdueOnly || r.view.overdue),
    );
    let from = 0;
    if (cursor !== undefined) {
      const cur = decodeCursor(cursor);
      if (cur.s !== sort) {
        throw new HttpError(400, 'invalid_cursor', 'cursor does not match the requested sort');
      }
      const cursorRecord: DisputeRecord = {
        open: true,
        view: {
          contractId: cur.i,
          openedAt: typeof cur.k === 'string' ? cur.k : new Date(0).toISOString(),
          held: typeof cur.k === 'number' ? cur.k : 0,
        } as DisputeView,
      };
      const idx = filtered.findIndex((r) => this.compareDisputes(sort, r, cursorRecord) > 0);
      from = idx === -1 ? filtered.length : idx;
    }
    const data = filtered.slice(from, from + limit).map((r) => r.view);
    const last = data[data.length - 1];
    const nextCursor =
      last && from + limit < filtered.length
        ? encodeCursor({
            s: sort,
            k: sort === 'value' ? last.held : last.openedAt,
            i: last.contractId,
          })
        : null;
    return { data, summary: { open, overdue, totalHeld }, page: { limit, count: data.length, nextCursor } };
  }

  getDispute(contractId: number, now: Date, slaHours: number): DisputeView {
    const c = this.contracts.get(contractId);
    if (!c || !c.dispute) {
      throw new HttpError(404, 'dispute_not_found', `No dispute for contract ${contractId}`);
    }
    return this.toDisputeView(c, now, slaHours);
  }

  stats() {
    const all = this.list();
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      contracts: all.length,
      byStatus,
      totalEscrowed: all.reduce((s, c) => s + (c.fundedAmount - c.releasedAmount), 0),
      totalReleased: all.reduce((s, c) => s + c.releasedAmount, 0),
    };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [
        { title: 'Wireframes', amount: 250 },
        { title: 'Visual design', amount: 500 },
        { title: 'Implementation', amount: 750 },
      ],
    });
    this.deposit(a.id, 1500);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      milestones: [{ title: 'Audit report', amount: 2000 }],
    });
    this.deposit(b.id, 2000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}
