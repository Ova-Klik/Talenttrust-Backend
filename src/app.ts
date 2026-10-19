import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHash, timingSafeEqual } from 'crypto';
import { config, explorerUrl } from './config';
import {
  DEFAULT_DISPUTE_LIMIT,
  DisputeSort,
  DisputeStatusFilter,
  EscrowStore,
  HttpError,
  MAX_DISPUTE_LIMIT,
  publicContract,
} from './store';
import { openapi, docsHtml } from './openapi';

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    next(err);
  }
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Hashing first equalizes lengths, so timingSafeEqual never sees mismatched buffers.
const tokensMatch = (provided: string, expected: string) => timingSafeEqual(sha256(provided), sha256(expected));

const requireAdminRead = (req: Request, res: Response, next: NextFunction) => {
  const expected = process.env.ADMIN_READ_TOKEN;
  if (!expected) {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
    return;
  }
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
  if (!match || !tokensMatch(match[1], expected)) {
    res.status(401).json({ error: 'unauthorized', message: 'Valid admin bearer token required' });
    return;
  }
  next();
};

const queryString = (value: unknown, name: string, allowed: string[], fallback: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
};

const disputeStatus = (q: unknown): DisputeStatusFilter =>
  queryString(q, 'status', ['open', 'resolved', 'all'], 'all') as DisputeStatusFilter;

const disputeSort = (q: unknown): DisputeSort =>
  queryString(q, 'sort', ['oldest', 'newest', 'value'], 'oldest') as DisputeSort;

const disputeOverdue = (q: unknown): boolean => {
  if (q === undefined) return false;
  if (q === 'true') return true;
  if (q === 'false') return false;
  throw new HttpError(400, 'invalid_overdue', 'overdue must be true or false');
};

const disputeLimit = (q: unknown): number => {
  if (q === undefined) return DEFAULT_DISPUTE_LIMIT;
  const n = typeof q === 'string' ? Number(q) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPUTE_LIMIT) {
    throw new HttpError(400, 'invalid_limit', `limit must be an integer 1..${MAX_DISPUTE_LIMIT}`);
  }
  return n;
};

export function createApp(store: EscrowStore = new EscrowStore().seed(), options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const app = express();
  app.disable('x-powered-by');
  // CSP disabled so the /docs page can load Swagger UI from a CDN.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get(
    '/',
    wrap(() => ({
      name: 'TalentTrust API',
      version: config.version,
      description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
      docs: '/docs',
      openapi: '/openapi.json',
      website: config.frontendUrl,
      chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
      endpoints: [
        'GET  /health',
        'GET  /docs',
        'GET  /openapi.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/stats',
        'GET  /api/v1/contracts',
        'POST /api/v1/contracts',
        'GET  /api/v1/contracts/:id',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'GET  /api/v1/reputation/:address',
        'GET  /api/v1/disputes (admin)',
        'GET  /api/v1/disputes/:contractId (admin)',
      ],
    })),
  );

  app.get(
    '/health',
    wrap(() => ({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: 'in-memory',
      timestamp: new Date().toISOString(),
    })),
  );

  app.get('/openapi.json', wrap(() => openapi));
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(docsHtml);
  });

  const v1 = express.Router();
  v1.get(
    '/chain',
    wrap(() => ({
      network: config.network,
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      explorer: explorerUrl(),
    })),
  );
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    wrap((req) => ({
      data: store
        .list({
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          party: typeof req.query.party === 'string' ? req.query.party : undefined,
        })
        .map(publicContract),
    })),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      res.status(201).json(publicContract(store.create(req.body ?? {})));
    }),
  );
  v1.get('/contracts/:id', wrap((req) => publicContract(store.get(id(req)))));
  v1.post('/contracts/:id/deposit', wrap((req) => publicContract(store.deposit(id(req), req.body?.amount))));
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req) => publicContract(store.release(id(req), Number(req.params.index)))),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req) => publicContract(store.openDispute(id(req), req.body?.raisedBy, req.body?.reason))),
  );
  v1.post(
    '/contracts/:id/resolve',
    wrap((req) => publicContract(store.resolveDispute(id(req), req.body?.freelancerBps))),
  );
  v1.post('/contracts/:id/cancel', wrap((req) => publicContract(store.cancel(id(req)))));
  v1.post('/contracts/:id/reputation', wrap((req) => store.rate(id(req), req.body?.rating)));
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));
  v1.get(
    '/disputes',
    requireAdminRead,
    wrap((req) => {
      const cursor = req.query.cursor;
      if (cursor !== undefined && typeof cursor !== 'string') {
        throw new HttpError(400, 'invalid_cursor', 'cursor must be a single string value');
      }
      return store.listDisputes({
        status: disputeStatus(req.query.status),
        sort: disputeSort(req.query.sort),
        overdueOnly: disputeOverdue(req.query.overdue),
        limit: disputeLimit(req.query.limit),
        cursor,
        now: now(),
        slaHours: config.disputeSlaHours,
      });
    }),
  );
  v1.get(
    '/disputes/:contractId',
    requireAdminRead,
    wrap((req) => {
      const n = Number(req.params.contractId);
      if (!Number.isInteger(n) || n < 1) {
        throw new HttpError(400, 'invalid_id', 'contractId must be a positive integer');
      }
      return store.getDispute(n, now(), config.disputeSlaHours);
    }),
  );
  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body' });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
  });

  return app;
}

export default createApp;
