/**
 * Fault attribution: decides which service actually broke and which services
 * are only failing because of it.
 *
 * Propagating breaches (`down`, `errors`, `latency`) all go to the most
 * downstream service that has one; `memory` stays with the service it occurs
 * in. Two independent propagating faults at once are reported as one
 * attribution rooted downstream (see design.md, Known limitation).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type {
  AffectedService,
  ServiceHealth,
  ServiceName,
  SignalKind,
} from '@haunted-cluster/shared';

export interface Attribution {
  rootService: ServiceName;
  /** The root's own breached kinds. */
  kinds: SignalKind[];
  /** Upstream services with a propagating breach, in chain order. */
  affected: AffectedService[];
}

const PROPAGATING_KINDS: readonly SignalKind[] = ['down', 'errors', 'latency'];

/** The service's breached kinds that propagate upstream, in their reported order. */
function propagatingKinds(health: ServiceHealth): SignalKind[] {
  return health.breachedKinds.filter((k) => PROPAGATING_KINDS.includes(k));
}

/** Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 */
export function attributeFaults(
  chain: ServiceName[],
  health: Record<ServiceName, ServiceHealth>,
): Attribution[] {
  // A service missing from `health` is as invisible as an unknown one.
  const known = chain
    .map((service) => health[service])
    .filter((h): h is ServiceHealth => h !== undefined && h.status !== 'unknown');

  const byRoot = new Map<ServiceName, Attribution>();

  let rootIndex = -1;
  for (let i = known.length - 1; i >= 0; i--) {
    if (propagatingKinds(known[i]).length > 0) {
      rootIndex = i;
      break;
    }
  }
  if (rootIndex >= 0) {
    const root = known[rootIndex];
    byRoot.set(root.service, {
      rootService: root.service,
      kinds: propagatingKinds(root),
      affected: known
        .slice(0, rootIndex)
        .map((u) => ({ service: u.service, kinds: propagatingKinds(u) }))
        .filter((a) => a.kinds.length > 0),
    });
  }

  for (const h of known) {
    if (!h.breachedKinds.includes('memory')) continue;
    const existing = byRoot.get(h.service);
    if (existing) existing.kinds.push('memory');
    else byRoot.set(h.service, { rootService: h.service, kinds: ['memory'], affected: [] });
  }

  return chain.flatMap((service) => byRoot.get(service) ?? []);
}
