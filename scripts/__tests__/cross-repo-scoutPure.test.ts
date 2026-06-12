/**
 * cross-repo-scoutPure.test.ts
 *
 * Pure-function tests for rankAndTrim (Contract 2).
 * Run via: npx tsx scripts/__tests__/cross-repo-scoutPure.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAndTrim } from '../cross-repo-scoutPure.js';
import type { CandidateHit } from '../cross-repo-scoutPure.js';

// --- Case 1: empty hits ---

test('empty hits returns []', () => {
  const result = rankAndTrim({ hits: [], asOfDate: '2026-06-01' });
  assert.deepEqual(result, []);
});

// --- Case 2: three score-0 hits returned ranked by cascade ---

test('three score-0 hits all returned sorted by repo asc', () => {
  const hits: CandidateHit[] = [
    { repo: 'zrepo', filePath: 'a.ts', lastModifiedDate: '2025-12-01', isFrameworkAligned: false, hasColocatedTest: false },
    { repo: 'arepo', filePath: 'b.ts', lastModifiedDate: '2025-12-01', isFrameworkAligned: false, hasColocatedTest: false },
    { repo: 'mrepo', filePath: 'c.ts', lastModifiedDate: '2025-12-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 3);
  // all score 0, same days, so sorted by repo asc
  assert.equal(result[0].repo, 'arepo');
  assert.equal(result[1].repo, 'mrepo');
  assert.equal(result[2].repo, 'zrepo');
  assert.equal(result[0].compositeScore, 0);
});

// --- Case 3: four hits, three at score 100, returns only top 3 ---

test('four hits, three at score 100 — returns at most 3', () => {
  const hits: CandidateHit[] = [
    { repo: 'a', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: true, hasColocatedTest: true },
    { repo: 'b', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: true, hasColocatedTest: true },
    { repo: 'c', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: true, hasColocatedTest: true },
    { repo: 'd', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 3);
  // top 3 should all be score 100 (repos a, b, c — lexicographic)
  assert.equal(result[0].compositeScore, 100);
  assert.equal(result[0].repo, 'a');
  assert.equal(result[1].repo, 'b');
  assert.equal(result[2].repo, 'c');
});

// --- Case 4: recency boundary: effectiveLastModifiedDays === 90 → recency 0 ---

test('effectiveLastModifiedDays exactly 90 gives recency 0', () => {
  // asOfDate 2026-06-01; lastModifiedDate 90 days before = 2026-03-03
  const hits: CandidateHit[] = [
    { repo: 'x', filePath: 'f.ts', lastModifiedDate: '2026-03-03', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 1);
  assert.equal(result[0].compositeScore, 0);
});

// --- Case 5: recency boundary: effectiveLastModifiedDays === 0 → recency 40 ---

test('effectiveLastModifiedDays 0 (same day) gives full 40 recency', () => {
  const hits: CandidateHit[] = [
    { repo: 'x', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 1);
  assert.equal(result[0].compositeScore, 40);
});

// --- Case 6: future-date clock skew clamps to 0 days (full recency) ---

test('lastModifiedDate 5 days after asOfDate clamps to effectiveDays=0, recency=40', () => {
  const hits: CandidateHit[] = [
    { repo: 'x', filePath: 'f.ts', lastModifiedDate: '2026-06-06', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 1);
  assert.equal(result[0].compositeScore, 40);
});

// --- Case 7: cascade level 1 — tied scores, different recency → newer wins ---

test('cascade level 1: tied compositeScore, newer recency wins', () => {
  // Both isFrameworkAligned=false, hasColocatedTest=false → alignment+test = 0
  // Only recency differs:
  //   hit A: 10 days → recency = 40*(1-10/90) ≈ 35.6 → total 35.6
  //   hit B: 5 days  → recency = 40*(1-5/90) ≈ 37.8 → total 37.8
  // Not tied here; let's make them the same composite but different days:
  // Actually we need same composite score with different days.
  // Use isFrameworkAligned=true for both, hasColocatedTest=false:
  //   A: 45 days → recency = 40*(1-45/90) = 20 → composite = 20+40+0 = 60
  //   B: 45 days → same
  // To get same composite but different days, we need them equal. Let's use
  // same structure: two hits with identical composite but different effectiveDays.
  // Actually identical composites arise from rounding — let's test directly:
  //   A: 44 days → 40*(1-44/90) = 40*(46/90) ≈ 20.444 → rounds to 20.4 → +40 = 60.4
  //   B: 46 days → 40*(1-46/90) = 40*(44/90) ≈ 19.556 → rounds to 19.6 → +40 = 59.6
  // Those aren't equal. Let's use a simpler setup:
  //   A: lastModifiedDate same as asOfDate → effectiveDays=0, recency=40, aligned=true → 80
  //   B: lastModifiedDate 5 days ago → effectiveDays=5, recency≈37.8, aligned=true → 77.8
  // Not tied. Need truly tied composites for this test.
  // Use 10 days apart where rounding produces the same value:
  //   Two hits with non-aligned, no-test:
  //   A: 0 days → 40.0
  //   B: 0 days (via future clamp) → 40.0; both repo='z', filePath differs: 'aaa' vs 'bbb'
  // That's cascade level 3 (filePath), not level 2 (recency).
  // For level 1 (days asc), force same compositeScore via rounding collision + different raw days:
  //   45 days: recency=20.0, total=20.0
  //   45 days (same): total=20.0 — need different days but same rounded score
  //   Let's find a pair: effectiveDays where 40*(1-d/90) rounds to same value:
  //   d=0: 40.0, d=1: 39.6, d=2: 39.1, d=3: 38.7 — all different
  // So actually it's hard to construct same compositeScore with different days unless
  // other dimensions compensate. Let's construct with different aligned/test combos:
  //   A: aligned=true, test=false, 0 days → 40+40+0=80
  //   B: aligned=false, test=true, 0 days → 40+0+20=60
  //   Those differ.
  //
  // Simplest: use same composite via: A aligned=false,test=false,0days=40.0
  //                                   B aligned=false,test=false,0days=40.0
  // Same composite AND same days → goes to repo. Let's use different repos for level-2 test.
  // For level-1, we need same composite, DIFFERENT days. The only way is rounding collision.
  // 40*(1 - 0/90) = 40.0; 40*(1 - 1/90) = 39.555... → round to 39.6. No collision.
  // Without rounding collision we can't have different days with same composite from recency alone.
  // With other dims: aligned=true, test=false: alignment=40
  //   A: d=0  → recency=40.0 → composite=80.0
  //   B: d=1  → recency=39.6 → composite=79.6  (differ)
  // With alignment=40, test=20:
  //   A: d=0  → 40+40+20=100.0
  //   B: d=1  → 39.6+40+20=99.6
  // No collision via simple approach. Use two hits with exact same days but different repos
  // to verify cascade level 2 → 3.
  // For level 1 (same composite, newer recency wins), manufacture via ONE hit (trivially correct)
  // or accept that this test verifies level-1 indirectly via two different inputs.
  //
  // Revised: test "two hits, same compositeScore (from rounding collision), newer wins".
  // Find rounding collision: round(40*(1-d1/90)*10)/10 === round(40*(1-d2/90)*10)/10 for d1 ≠ d2
  // d=4: 40*(86/90)=38.222 → 38.2
  // d=5: 40*(85/90)=37.778 → 37.8
  // d=3: 40*(87/90)=38.667 → 38.7
  // No easy collision without big gaps.
  //
  // Actually the spec example uses non-rounding-colliding cases. Let's just test with
  // two hits that differ only in score (not days) — "higher score goes first" is
  // already covered by Case 15. For cascade level 1 specifically, let's use a
  // manufactured collision:
  //   aligned=false, test=true (20 pts), days=45: 40*(45/90)=20.0 → total=40.0
  //   aligned=false, test=true (20 pts), days=36: 40*(54/90)=24.0 → total=44.0  -- different
  //   Need EXACT SAME composite from rounding. Try:
  //   days=13: 40*(77/90)=34.222 → 34.2 + 20 = 54.2
  //   days=14: 40*(76/90)=33.778 → 33.8 + 20 = 53.8  -- different
  //   days=0 → 40.0 + 20 = 60.0
  //   For a rounding collision to exist we'd need wider gaps. Let's skip the exact
  //   rounding-collision approach and use a different technique:
  //   Same composite via framework + test combination:
  //   A: aligned=true, test=false, d=90 → 0+40+0=40.0
  //   B: aligned=false, test=true, d=45 → 20+0+20=40.0 ← same 40.0! different days.
  //   A.effectiveDays=90, B.effectiveDays=45 → B wins (newer = fewer days)
  const asOfDate = '2026-06-01';
  // A: 90 days ago = 2026-03-03 (recency=0), aligned, no test → 0+40+0=40.0
  // B: 45 days ago = 2026-04-17 (recency=20), not aligned, has test → 20+0+20=40.0
  const hitA: CandidateHit = { repo: 'a', filePath: 'f.ts', lastModifiedDate: '2026-03-03', isFrameworkAligned: true, hasColocatedTest: false };
  const hitB: CandidateHit = { repo: 'b', filePath: 'f.ts', lastModifiedDate: '2026-04-17', isFrameworkAligned: false, hasColocatedTest: true };
  const result = rankAndTrim({ hits: [hitA, hitB], asOfDate });
  assert.equal(result.length, 2);
  assert.equal(result[0].compositeScore, result[1].compositeScore);
  // B has fewer effective days → B wins
  assert.equal(result[0].repo, 'b');
  assert.equal(result[1].repo, 'a');
});

// --- Case 8: cascade level 2 — tied score+recency, different repo → lexicographic ---

test('cascade level 2: tied compositeScore + effectiveDays, repo asc wins', () => {
  const hits: CandidateHit[] = [
    { repo: 'zrepo', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
    { repo: 'arepo', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 2);
  assert.equal(result[0].repo, 'arepo');
  assert.equal(result[1].repo, 'zrepo');
});

// --- Case 9: cascade level 3 — tied score+recency+repo, filePath asc ---

test('cascade level 3: tied compositeScore + effectiveDays + repo, filePath asc wins', () => {
  const hits: CandidateHit[] = [
    { repo: 'same', filePath: 'z-file.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
    { repo: 'same', filePath: 'a-file.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 2);
  assert.equal(result[0].filePath, 'a-file.ts');
  assert.equal(result[1].filePath, 'z-file.ts');
});

// --- Case 10: determinism — shuffle input 10 times, all returns identical ---

test('determinism: shuffled inputs produce identical output', () => {
  const hits: CandidateHit[] = [
    { repo: 'altessa', filePath: 'server/services/slackOAuthService.ts', lastModifiedDate: '2026-05-27', isFrameworkAligned: true, hasColocatedTest: true },
    { repo: 'release-control', filePath: 'server/lib/slackOAuthService.ts', lastModifiedDate: '2026-02-01', isFrameworkAligned: true, hasColocatedTest: false },
    { repo: 'old-app', filePath: 'src/slack.ts', lastModifiedDate: '2026-05-02', isFrameworkAligned: false, hasColocatedTest: true },
    { repo: 'extra-a', filePath: 'f.ts', lastModifiedDate: '2025-01-01', isFrameworkAligned: false, hasColocatedTest: false },
    { repo: 'extra-b', filePath: 'g.ts', lastModifiedDate: '2025-01-01', isFrameworkAligned: false, hasColocatedTest: false },
  ];
  const reference = rankAndTrim({ hits, asOfDate: '2026-06-01' });

  function shuffle(arr: CandidateHit[]): CandidateHit[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  for (let i = 0; i < 10; i++) {
    const shuffled = shuffle(hits);
    const result = rankAndTrim({ hits: shuffled, asOfDate: '2026-06-01' });
    assert.deepEqual(result, reference);
  }
});

// --- Case 11: asOfDate as date-only works ---

test('asOfDate YYYY-MM-DD (date-only) is accepted', () => {
  const result = rankAndTrim({
    hits: [{ repo: 'x', filePath: 'f.ts', lastModifiedDate: '2026-06-01', isFrameworkAligned: false, hasColocatedTest: false }],
    asOfDate: '2026-06-01',
  });
  assert.equal(result.length, 1);
});

// --- Case 12: asOfDate as full ISO 8601 works ---

test('asOfDate full ISO 8601 is accepted', () => {
  const result = rankAndTrim({
    hits: [{ repo: 'x', filePath: 'f.ts', lastModifiedDate: '2026-06-01T00:00:00.000Z', isFrameworkAligned: false, hasColocatedTest: false }],
    asOfDate: '2026-06-01T12:00:00.000Z',
  });
  assert.equal(result.length, 1);
});

// --- Case 13: malformed asOfDate throws ---

test('malformed asOfDate throws', () => {
  assert.throws(
    () => rankAndTrim({ hits: [], asOfDate: 'not-a-date' }),
    /Invalid ISO date string for asOfDate/,
  );
});

// --- Case 14: malformed lastModifiedDate throws ---

test('malformed lastModifiedDate throws', () => {
  assert.throws(
    () => rankAndTrim({
      hits: [{ repo: 'x', filePath: 'f.ts', lastModifiedDate: 'bad-date', isFrameworkAligned: false, hasColocatedTest: false }],
      asOfDate: '2026-06-01',
    }),
    /Invalid ISO date string for hits\[\]\.lastModifiedDate/,
  );
});

// --- Case 15: verbatim spec example ---
// altessa (97.8) > old-app (46.7) > release-control (40.0)

test('verbatim spec example: altessa 97.8 > old-app 46.7 > release-control 40.0', () => {
  const hits: CandidateHit[] = [
    { repo: 'altessa', filePath: 'server/services/slackOAuthService.ts', lastModifiedDate: '2026-05-27', isFrameworkAligned: true, hasColocatedTest: true },
    { repo: 'release-control', filePath: 'server/lib/slackOAuthService.ts', lastModifiedDate: '2026-02-01', isFrameworkAligned: true, hasColocatedTest: false },
    { repo: 'old-app', filePath: 'src/slack.ts', lastModifiedDate: '2026-05-02', isFrameworkAligned: false, hasColocatedTest: true },
  ];
  const result = rankAndTrim({ hits, asOfDate: '2026-06-01' });
  assert.equal(result.length, 3);

  // altessa: effectiveDays=5, recency=40*(1-5/90)=37.778→37.8, +40+20=97.8
  assert.equal(result[0].repo, 'altessa');
  assert.equal(result[0].compositeScore, 97.8);

  // old-app: effectiveDays=30, recency=40*(1-30/90)=26.667→26.7, +0+20=46.7
  assert.equal(result[1].repo, 'old-app');
  assert.equal(result[1].compositeScore, 46.7);

  // release-control: effectiveDays=120 (>90), recency=0, +40+0=40.0
  assert.equal(result[2].repo, 'release-control');
  assert.equal(result[2].compositeScore, 40);

  // lastModifiedDate passed through verbatim
  assert.equal(result[0].lastModifiedDate, '2026-05-27');
  assert.equal(result[1].lastModifiedDate, '2026-05-02');
  assert.equal(result[2].lastModifiedDate, '2026-02-01');
});
