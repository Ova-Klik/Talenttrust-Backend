const slaRaw = Number(process.env.DISPUTE_SLA_HOURS);

export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  txTimeoutSeconds: Math.max(1, Number.parseInt(process.env.TX_TIMEOUT_SECONDS || '300', 10) || 300),
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  disputeSlaHours: Number.isFinite(slaRaw) && slaRaw > 0 ? slaRaw : 72,
  version: '1.0.0',
  requireIfMatch: process.env.REQUIRE_IF_MATCH === 'true',
  apiPaused: process.env.API_PAUSED === 'true',
  pauseCheckTtlMs: Number(process.env.PAUSE_CHECK_TTL_MS) || 10000,
  pauseFailMode: (process.env.PAUSE_FAIL_MODE === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
  /** Set PAUSE_CHECK_CHAIN=false to skip the on-chain is_paused probe (tests, offline dev). */
  pauseCheckChain: process.env.PAUSE_CHECK_CHAIN !== 'false',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
