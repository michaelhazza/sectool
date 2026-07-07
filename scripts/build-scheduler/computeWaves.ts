/**
 * computeWaves.ts
 *
 * Pure wave scheduler: given a chunk dependency graph, produces an ordered
 * list of waves for parallel execution.
 *
 * Public contract: ChunkNode, ComputeWavesInput, Wave, ComputeWavesResult,
 * computeWaves(). Everything else is an implementation detail.
 *
 * Path storage: declaredFiles values are stored in their original casing
 * (required so the coordinator's `git add` is correct on case-sensitive Linux
 * CI). File-identity comparison is case-insensitive (Windows/macOS-safe).
 */

export interface ChunkNode {
  /** Stable chunk id, e.g. "1" or "chunk-4". */
  id: string;
  /** Ids of chunks that must complete before this one can begin. */
  dependsOn: string[];
  /** Exhaustive set of files this chunk creates or modifies. */
  declaredFiles: string[];
  /** Named singleton resources (e.g. "migration:v2.24.0"). */
  exclusiveResources?: string[];
}

export interface ComputeWavesInput {
  chunks: ChunkNode[];
  concurrencyCap: number;
}

/** An ordered collection of chunk ids that may run concurrently. */
export interface Wave {
  /** Chunk ids within this wave, sorted ascending. */
  chunkIds: string[];
}

export interface ComputeWavesResult {
  waves: Wave[];
  serialisedReasons: Array<{
    chunkId: string;
    reason: 'file-overlap' | 'exclusive-resource' | 'dependency' | 'cap-spill';
    /** Names the earlier chunk that triggered a resource or file split. Omitted for dependency/cap-spill. */
    conflictsWith?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Numeric-aware chunk-id comparator. Sorts "1", "2", "10" in numeric order
 * rather than lexicographic order ("1", "10", "2"). The architect contract
 * uses heading-number ids (e.g. "4") and the ADR promises stable chunk-id
 * order matching plan order; lexicographic sort breaks with 10+ chunks.
 */
function compareChunkIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Returns true when the two chunks share at least one exclusive resource. */
function hasResourceConflict(a: ChunkNode, b: ChunkNode): boolean {
  const aRes = new Set(a.exclusiveResources ?? []);
  for (const r of b.exclusiveResources ?? []) {
    if (aRes.has(r)) return true;
  }
  return false;
}

/** Returns true when the two chunks share at least one declared file (case-insensitive). */
function hasFileConflict(a: ChunkNode, b: ChunkNode): boolean {
  const aFiles = new Set(a.declaredFiles.map((f) => f.toLowerCase()));
  for (const f of b.declaredFiles) {
    if (aFiles.has(f.toLowerCase())) return true;
  }
  return false;
}

/**
 * Kahn's algorithm: returns chunks in topological order, stable by id within
 * each layer. Throws on cycle or unknown dependency id.
 *
 * Returns an array of layers; each layer is an array of ChunkNodes in
 * stable id-ascending order. Chunks within a layer may run concurrently
 * (subject to file/resource/cap constraints resolved below).
 */
function topologicalLayers(chunks: ChunkNode[]): ChunkNode[][] {
  const idSet = new Set(chunks.map((c) => c.id));

  // Validate: unknown dependency ids.
  for (const chunk of chunks) {
    for (const dep of chunk.dependsOn) {
      if (!idSet.has(dep)) {
        throw new Error(`unknown dependency id: ${dep}`);
      }
    }
  }

  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  // successors[id] = list of chunk ids whose dependsOn includes id.
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const chunk of chunks) {
    indegree.set(chunk.id, chunk.dependsOn.length);
    if (!successors.has(chunk.id)) {
      successors.set(chunk.id, []);
    }
    for (const dep of chunk.dependsOn) {
      const list = successors.get(dep) ?? [];
      list.push(chunk.id);
      successors.set(dep, list);
    }
  }

  const layers: ChunkNode[][] = [];
  const placed = new Set<string>();
  let frontier = chunks
    .filter((c) => (indegree.get(c.id) ?? 0) === 0)
    .sort((a, b) => compareChunkIds(a.id, b.id));

  while (frontier.length > 0) {
    layers.push(frontier);
    for (const node of frontier) {
      placed.add(node.id);
    }

    // Collect successors whose all deps are now placed.
    const nextSet = new Set<string>();
    for (const node of frontier) {
      for (const succId of successors.get(node.id) ?? []) {
        nextSet.add(succId);
      }
    }

    frontier = [];
    for (const succId of nextSet) {
      const chunk = chunkById.get(succId)!;
      if (chunk.dependsOn.every((dep) => placed.has(dep))) {
        frontier.push(chunk);
      }
    }
    frontier.sort((a, b) => compareChunkIds(a.id, b.id));
  }

  // Cycle detection.
  if (placed.size !== chunks.length) {
    const cycleIds = chunks
      .filter((c) => !placed.has(c.id))
      .map((c) => c.id)
      .sort((a, b) => compareChunkIds(a, b));
    throw new Error(`dependency cycle: ${cycleIds.join(', ')}`);
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeWaves(input: ComputeWavesInput): ComputeWavesResult {
  const { chunks, concurrencyCap } = input;

  if (concurrencyCap < 1) {
    throw new Error('concurrencyCap must be >= 1');
  }

  if (chunks.length === 0) {
    return { waves: [], serialisedReasons: [] };
  }

  const layers = topologicalLayers(chunks);

  const waves: Wave[] = [];
  const serialisedReasons: ComputeWavesResult['serialisedReasons'] = [];

  // Process each topological layer independently. Chunks within a layer are
  // already in stable id-ascending order from topologicalLayers().
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];

    // sub-waves[i] = the ChunkNodes assigned to that sub-wave within this layer.
    const subWaves: ChunkNode[][] = [];

    for (const chunk of layer) {
      let assigned = false;

      for (let wi = 0; wi < subWaves.length; wi++) {
        const wave = subWaves[wi];

        // Cap check.
        if (wave.length >= concurrencyCap) continue;

        // Pairwise resource + file disjointness check against every member.
        let blocked = false;
        for (const member of wave) {
          if (hasResourceConflict(chunk, member) || hasFileConflict(chunk, member)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        wave.push(chunk);
        assigned = true;
        break;
      }

      if (!assigned) {
        // Chunk must open a new sub-wave. Determine the serialisation reason.
        const isFirstInLayer = subWaves.length === 0;

        if (isFirstInLayer) {
          // No prior sub-wave within this layer to conflict with.
          // If this is not the very first wave globally (layerIdx > 0), the
          // serialisation is cross-layer: caused by topological dependency.
          // Record 'dependency' only when this chunk is alone in its layer
          // (i.e., it will be the sole occupant of this sub-wave with no
          // siblings to share it — meaning layer.length === 1). When multiple
          // chunks share a layer, they form a natural parallel group; the
          // serialisation from earlier layers is implicit and not recorded
          // per-chunk. When a chunk is alone in layer 1+, the wave boundary
          // is purely a dependency effect and is worth surfacing.
          if (layerIdx > 0 && layer.length === 1) {
            serialisedReasons.push({ chunkId: chunk.id, reason: 'dependency' });
          }
          // (If layerIdx === 0 and isFirstInLayer, this is the very first
          // chunk globally — no reason to record.)
        } else {
          // Prior sub-waves exist within this layer. The chunk was rejected
          // from all of them. Determine the highest-priority reason by
          // inspecting the rejection cause against sub-wave 0 (the earliest
          // available — the one that would be "preferred" placement).
          //
          // Priority: exclusive-resource > file-overlap > cap-spill.

          let conflictChunkId: string | undefined;
          let reason: 'exclusive-resource' | 'file-overlap' | 'cap-spill' = 'cap-spill';

          // Check all prior sub-waves for the first exclusive-resource clash.
          outerRes: for (const sw of subWaves) {
            for (const member of sw) {
              if (hasResourceConflict(chunk, member)) {
                conflictChunkId = member.id;
                reason = 'exclusive-resource';
                break outerRes;
              }
            }
          }

          // If no resource clash, check for file overlap.
          if (reason === 'cap-spill') {
            outerFile: for (const sw of subWaves) {
              for (const member of sw) {
                if (hasFileConflict(chunk, member)) {
                  conflictChunkId = member.id;
                  reason = 'file-overlap';
                  break outerFile;
                }
              }
            }
          }

          // If still 'cap-spill', all existing sub-waves were full.
          // No conflictsWith for cap-spill.

          serialisedReasons.push({
            chunkId: chunk.id,
            reason,
            ...(conflictChunkId !== undefined ? { conflictsWith: conflictChunkId } : {}),
          });
        }

        subWaves.push([chunk]);
      }
    }

    // Emit waves for this layer in sub-wave creation order, chunk ids sorted ascending.
    for (const sw of subWaves) {
      waves.push({
        chunkIds: sw.map((c) => c.id).sort((a, b) => compareChunkIds(a, b)),
      });
    }
  }

  return { waves, serialisedReasons };
}
