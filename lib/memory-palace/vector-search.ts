/**
 * Memory Palace — 向量搜索（momo 适配版，主线程）
 *
 * 查询文本 → 向量化（由调用方传入 queryVector）→ 与角色 memory_vectors 做余弦相似度 → 阈值过滤。
 *
 * 与 SullyOS 的区别：
 *  - 去掉 Web Worker 加速（简化；momo 规模下主线程足够，且避免 worker 构建配置负担）。
 *  - 去掉跨设备 supabaseVector 远程路径（一期不做）。
 *  - 保留 prefetchedVectors 以支持 pipeline 同次 retrieve 内多路并行检索复用全量向量。
 */

import type { MemoryNode, MemoryVector } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity } from './embedding';

export interface VectorSearchResult {
    node: MemoryNode;
    similarity: number;
}

export async function vectorSearch(
    queryVector: number[] | Float32Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
    prefetchedVectors?: MemoryVector[],
): Promise<VectorSearchResult[]> {
    const vectors = prefetchedVectors ?? await MemoryVectorDB.getAllByCharId(charId);
    if (vectors.length === 0) return [];

    const scored = mainThreadSearch(queryVector, vectors, threshold, topK);

    const nodes = await Promise.all(scored.map(item => MemoryNodeDB.getById(item.memoryId)));
    const results: VectorSearchResult[] = [];
    for (let i = 0; i < scored.length; i++) {
        const node = nodes[i];
        if (node && !node.archived) {
            results.push({ node, similarity: scored[i].similarity });
        }
    }

    return results;
}

function mainThreadSearch(
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
): { memoryId: string; similarity: number }[] {
    const scored: { memoryId: string; similarity: number }[] = [];
    const qv = ensureFloat32(queryVector);
    for (const vec of vectors) {
        const sim = cosineSimilarity(qv, ensureFloat32(vec.vector));
        if (sim >= threshold) {
            scored.push({ memoryId: vec.memoryId, similarity: sim });
        }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
