export interface CandidateHit {
  repo: string;
  filePath: string;
  lastModifiedDate: string;
  isFrameworkAligned: boolean;
  hasColocatedTest: boolean;
}

export interface RankAndTrimInput {
  hits: CandidateHit[];
  asOfDate: string;
}

export interface RankedResult {
  repo: string;
  filePath: string;
  lastModifiedDate: string;
  isFrameworkAligned: boolean;
  hasColocatedTest: boolean;
  compositeScore: number;
}

function parseISODate(dateStr: string, fieldName: string): number {
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date string for ${fieldName}: "${dateStr}"`);
  }
  return ms;
}

export function rankAndTrim(input: RankAndTrimInput): RankedResult[] {
  const { hits, asOfDate } = input;

  const asOfMs = parseISODate(asOfDate, 'asOfDate');

  if (hits.length === 0) {
    return [];
  }

  interface Scored {
    hit: CandidateHit;
    effectiveLastModifiedDays: number;
    compositeScore: number;
  }

  const scored: Scored[] = hits.map((hit) => {
    const lastModMs = parseISODate(hit.lastModifiedDate, `hits[].lastModifiedDate (repo=${hit.repo}, file=${hit.filePath})`);
    const rawDays = Math.floor((asOfMs - lastModMs) / 86_400_000);
    const effectiveLastModifiedDays = Math.max(0, rawDays);

    const recency = 40 * Math.max(0, 1 - effectiveLastModifiedDays / 90);
    const alignment = hit.isFrameworkAligned ? 40 : 0;
    const testPresence = hit.hasColocatedTest ? 20 : 0;
    const raw = recency + alignment + testPresence;
    const compositeScore = Math.round(raw * 10) / 10;

    return { hit, effectiveLastModifiedDays, compositeScore };
  });

  scored.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (a.effectiveLastModifiedDays !== b.effectiveLastModifiedDays) return a.effectiveLastModifiedDays - b.effectiveLastModifiedDays;
    if (a.hit.repo !== b.hit.repo) return a.hit.repo < b.hit.repo ? -1 : 1;
    if (a.hit.filePath !== b.hit.filePath) return a.hit.filePath < b.hit.filePath ? -1 : 1;
    return 0;
  });

  return scored.slice(0, 3).map((s) => ({
    repo: s.hit.repo,
    filePath: s.hit.filePath,
    lastModifiedDate: s.hit.lastModifiedDate,
    isFrameworkAligned: s.hit.isFrameworkAligned,
    hasColocatedTest: s.hit.hasColocatedTest,
    compositeScore: s.compositeScore,
  }));
}
