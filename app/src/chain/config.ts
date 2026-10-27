// The Solana cluster and RPC the app reads and simulates on. Mainnet by default (Phantom on mainnet). A test build sets
// VITE_SOLANA_CLUSTER=localnet|devnet and VITE_RPC_URL (the program builder's local validator: http://127.0.0.1:8899).
// GET /api/health may name the program id and an RPC the server proxies; the build's own settings win.
import { createStore } from '../state/store.ts';

export type Cluster = 'mainnet-beta' | 'devnet' | 'localnet';

const envCluster = import.meta.env.VITE_SOLANA_CLUSTER as string | undefined;
const envRpc = import.meta.env.VITE_RPC_URL as string | undefined;
const envProgram = import.meta.env.VITE_FLIPFEE_PROGRAM as string | undefined;

interface ChainState {
  cluster: Cluster;
  /** the flipfee program id (from the build, the server, or the client's default) */
  programId: string | null;
  /** an RPC the server offers (same origin), used when the build names none */
  serverRpc: string | null;
}

export const chain = createStore<ChainState>({
  cluster: envCluster === 'localnet' ? 'localnet' : envCluster === 'devnet' ? 'devnet' : 'mainnet-beta',
  programId: envProgram && envProgram.length >= 32 ? envProgram : null,
  serverRpc: null,
});

export const cluster = (): Cluster => chain.get().cluster;

export function rpcUrl(): string {
  if (envRpc) return envRpc;
  const s = chain.get().serverRpc;
  if (s) return s.startsWith('/') ? window.location.origin + s : s;
  switch (cluster()) {
    case 'localnet':
      return 'http://127.0.0.1:8899';
    case 'devnet':
      return 'https://api.devnet.solana.com';
    default:
      return 'https://solana-rpc.publicnode.com';
  }
}

/** Explorer link for a transaction or an account on this cluster. */
export function explorer(kind: 'tx' | 'address', id: string): string {
  const c = cluster();
  if (c === 'localnet') return `https://explorer.solana.com/${kind}/${id}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl())}`;
  return `https://solscan.io/${kind === 'tx' ? 'tx' : 'account'}/${id}${c === 'devnet' ? '?cluster=devnet' : ''}`;
}

/** Reads what the server says about the chain (program id, RPC proxy); the build's settings win. */
export function applyServerChain(h: { programId?: unknown; rpc?: unknown; cluster?: unknown } | null): void {
  if (!h) return;
  const patch: Partial<ChainState> = {};
  if (!chain.get().programId && typeof h.programId === 'string' && h.programId.length >= 32) patch.programId = h.programId;
  if (typeof h.rpc === 'string' && (h.rpc.startsWith('/') || h.rpc.startsWith('https://'))) patch.serverRpc = h.rpc;
  if (!envCluster && (h.cluster === 'devnet' || h.cluster === 'localnet')) patch.cluster = h.cluster;
  if (Object.keys(patch).length) chain.set(patch);
}
