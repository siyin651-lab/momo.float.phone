/**
 * Memory Palace — 混合搜索 + 房间评分（momo 适配版）
 *
 * 85% 向量 + 15% BM25 融合，然后按房间特性调整评分。
 * 与 SullyOS 的区别：去掉倒排索引（bm25Index）灰度路径，统一用朴素 bm25Search；
 * 去掉跨设备远程向量配置。
 */

import type { EmbeddingConfig, MemoryNode, MemoryRoom, MemoryVector, ScoredMemory } from './types';
import { resolveMemoryScoringRoom } from './types';
import { MemoryNodeDB } from './db';
import { getEmbedding } from './embedding';
import { vectorSearch } from './vector-search';
import { bm25Search } from './bm25';
import { calculateEffectiveImportance } from './consolidation';

const ROOM_WEIGHTS: Record<MemoryRoom, { similarity: number; recency: number; importance: number }> = {
    living_room: { similarity: 0.50, recency: 0.30, importance: 0.20 },
    bedroom:     { similarity: 0.60, recency: 0.10, importance: 0.30 },
    study:       { similarity: 0.55, recency: 0.15, importance: 0.30 },
    user_room:   { similarity: 0.55, recency: 0.15, importance: 0.30 },
    self_room:   { similarity: 0.55, recency: 0.15, importance: 0.30 },
    attic:       { similarity: 0.70, recency: 0.00, importance: 0.30 },
    windowsill:  { similarity: 0.55, recency: 0.15, importance: 0.30 },
};

const VECTOR_WEIGHT = 0.85;
const BM25_WEIGHT = 0.15;
const RECENCY_DECAY = 0.999; // per hour

const FAMILIARITY_WEIGHT = 0.05;

function familiarityBonus(accessCount: number): number {
    const n = Math.max(0, (accessCount || 0) - 1);
    if (n === 0) return 0;
    return Math.min(1, Math.pow(n, 0.3) / 4);
}

export interface HybridSearchPrefetch {
    queryVector?: Float32Array;
    allNodes?: MemoryNode[];
    allVectors?: MemoryVector[];
}

export async function hybridSearch(
    query: string,
    charId: string,
    embeddingConfig: EmbeddingConfig,
    topK: number = 15,
    prefetch?: HybridSearchPrefetch,
): Promise<ScoredMemory[]> {
    const queryVector = prefetch?.queryVector ?? await getEmbedding(query, embeddingConfig);

    const vectorResults = await vectorSearch(queryVector, charId, 0.3, 30, prefetch?.allVectors);

    const allNodes = prefetch?.allNodes ?? await MemoryNodeDB.getByCharId(charId);
    const searchableNodes = allNodes.filter(n => n.embedded && !n.archived);

    const bm25Results = bm25Search(query, searchableNodes, 30);

    const localNodeMap = new Map(allNodes.map(n => [n.id, n]));

    const scoreMap = new Map<string, { node: MemoryNode; vectorSim: number; bm25Score: number }>();

    const maxBm25 = bm25Results.length > 0 ? bm25Results[0].score : 1;

    for (const vr of vectorResults) {
        const fullNode = localNodeMap.get(vr.node.id) || vr.node;
        if (fullNode.archived) continue;
        scoreMap.set(vr.node.id, { node: fullNode, vectorSim: vr.similarity, bm25Score: 0 });
    }

    for (const br of bm25Results) {
        const normalized = maxBm25 > 0 ? br.score / maxBm25 : 0;
        const existing = scoreMap.get(br.node.id);
        if (existing) existing.bm25Score = normalized;
        else scoreMap.set(br.node.id, { node: br.node, vectorSim: 0, bm25Score: normalized });
    }

    const now = Date.now();
    const results: ScoredMemory[] = [];

    for (const [, entry] of scoreMap) {
        const { node, vectorSim, bm25Score } = entry;
        const hybridSim = VECTOR_WEIGHT * vectorSim + BM25_WEIGHT * bm25Score;

        const hoursAgo = (now - node.lastAccessedAt) / (1000 * 60 * 60);
        const recency = Math.pow(RECENCY_DECAY, hoursAgo);

        const effectiveImp = calculateEffectiveImportance(node, now) / 10;

        const weights = ROOM_WEIGHTS[resolveMemoryScoringRoom(node.room)];

        let simW = weights.similarity;
        let recW = weights.recency;
        let impW = weights.importance;
        if (weights.recency > 0 && recency < 0.1) {
            const redistribute = weights.recency / 2;
            simW += redistribute;
            impW += redistribute;
            recW = 0;
        }

        const baseScore = simW * hybridSim + recW * recency + impW * effectiveImp;
        const familiarity = familiarityBonus(node.accessCount);
        const roomScore = baseScore + FAMILIARITY_WEIGHT * familiarity;

        results.push({ node, finalScore: roomScore, similarity: vectorSim, bm25Score, roomScore });
    }

    results.sort((a, b) => b.finalScore - a.finalScore);
    return results.slice(0, topK);
}
