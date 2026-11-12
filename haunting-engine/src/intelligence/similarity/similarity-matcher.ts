// Pure cosine similarity and best-match selection (R8.1-R8.5, R8.7, R8.8, R8.10).
import type { Incident } from '@haunted-cluster/shared';
import type { FeatureVector } from './feature-extractor';

/** Cosine similarity clamped to [0, 1]; 0 for length mismatch or a zero norm. */
export function cosineSimilarity(a: FeatureVector, b: FeatureVector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const result = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(result)) return 0;
  return Math.min(1, Math.max(0, result));
}

export interface Candidate {
  incident: Incident;
  vector: FeatureVector;
}

/** similarity is unrounded. */
export interface Match {
  incident: Incident;
  similarity: number;
}

function resolvedMs(incident: Incident): number {
  if (incident.resolvedAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(incident.resolvedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Highest similarity wins; exact ties go to the latest resolvedAt.
 * Returns null for no candidates or a best below threshold (unrounded compare).
 */
export function selectSimilar(
  target: FeatureVector,
  candidates: readonly Candidate[],
  threshold: number,
): Match | null {
  let best: Match | null = null;
  let bestResolved = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(target, candidate.vector);
    const resolved = resolvedMs(candidate.incident);
    if (
      best === null ||
      similarity > best.similarity ||
      (similarity === best.similarity && resolved > bestResolved)
    ) {
      best = { incident: candidate.incident, similarity };
      bestResolved = resolved;
    }
  }
  if (best === null || best.similarity < threshold) return null;
  return best;
}
