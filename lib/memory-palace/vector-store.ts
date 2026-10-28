/**
 * Memory Palace — 向量化 + 存储 + 去重（momo 适配版）
 *
 * 移植自 SullyOS utils/memoryPalace/vectorStore.ts，去掉跨设备同步（supabaseVector），
 * 向量化改用本包的 getEmbeddings。
 */

import type { EmbeddingConfig, MemoryNode, MemoryVector } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity, getEmbeddings } from './embedding';

const DEDUP_THRESHOLD = 0.9;

export async function vectorizeAndStore(
    nodes: MemoryNode[],
    embeddingConfig: EmbeddingConfig,
    options: {
        skipDedup?: boolean;
        commit?: (entries: { node: MemoryNode; vector: MemoryVector }[]) => Promise<void>;
    } = {},
): Promise<{ stored: number; skipped: number }> {
    if (nodes.length === 0) return { stored: 0, skipped: 0 };

    const vectors = await getEmbeddings(nodes.map(n => n.content), embeddingConfig);
    if (vectors.length !== nodes.length
        || vectors.some(vector => !vector.length || !Array.from(vector).every(Number.isFinite))) {
        throw new Error('Embedding 返回的向量不完整或无效，本次没有写入记忆');
    }

    const charId = nodes[0].charId;
    const existingVectors = options.skipDedup ? [] : await MemoryVectorDB.getAllByCharId(charId);

    let stored = 0;
    let skipped = 0;
    const entries: { node: MemoryNode; vector: MemoryVector }[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const vector = vectors[i];

        const queryF32 = ensureFloat32(vector);
        const isDuplicate = !options.skipDedup && existingVectors.some(
            ev => cosineSimilarity(queryF32, ensureFloat32(ev.vector)) > DEDUP_THRESHOLD
        );

        if (isDuplicate) {
            console.log(`♻️ [VectorStore] Skipping duplicate memory: "${node.content.slice(0, 30)}..."`);
            skipped++;
            continue;
        }

        const memoryVector: MemoryVector = {
            memoryId: node.id,
            charId: node.charId,
            vector,
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        entries.push({ node: { ...node, embedded: true }, vector: memoryVector });
        existingVectors.push(memoryVector);
        stored++;
    }

    if (options.commit) await options.commit(entries);
    else await MemoryNodeDB.saveVectorizedMany(entries);
    const committedIds = new Set(entries.map(e => e.node.id));
    for (const node of nodes) if (committedIds.has(node.id)) node.embedded = true;

    console.log(`✅ [VectorStore] Stored ${stored}, skipped ${skipped} duplicates`);
    return { stored, skipped };
}

export interface UpdateStoredMemoryNodeResult {
    node: MemoryNode;
    reembedded: boolean;
}

export async function updateStoredMemoryNode(
    nodeId: string,
    updates: Partial<MemoryNode>,
    embeddingConfig?: EmbeddingConfig,
): Promise<UpdateStoredMemoryNodeResult> {
    const existing = await MemoryNodeDB.getById(nodeId);
    if (!existing) throw new Error('这条记忆已经不存在了');

    const updated: MemoryNode = { ...existing, ...updates, id: existing.id, charId: existing.charId };
    if (!updated.content.trim()) throw new Error('记忆内容不能为空');
    const contentChanged = updated.content !== existing.content;

    if (!contentChanged) {
        await MemoryNodeDB.save(updated);
        return { node: updated, reembedded: false };
    }

    if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKey || !embeddingConfig.model) {
        throw new Error('请先配置 Embedding API，修改正文后需要同步更新向量');
    }

    updated.embedded = false;
    await vectorizeAndStore([updated], embeddingConfig, { skipDedup: true });
    return { node: { ...updated, embedded: true }, reembedded: true };
}

function normalizeModelName(model: string): string {
    return model.replace(/^Pro\//i, '').trim().toLowerCase();
}

export async function checkModelConsistency(
    charId: string,
    currentModel: string,
): Promise<'match' | 'mismatch' | 'empty'> {
    const existing = await MemoryVectorDB.getAllByCharId(charId);
    if (existing.length === 0) return 'empty';

    const sample = existing.find(v => v.model);
    if (!sample) return 'match';

    return normalizeModelName(sample.model!) === normalizeModelName(currentModel)
        ? 'match' : 'mismatch';
}

export async function rebuildAllVectors(
    charId: string,
    embeddingConfig: EmbeddingConfig,
): Promise<{ rebuilt: number }> {
    const nodes = await MemoryNodeDB.getByCharId(charId);
    const embeddedNodes = nodes.filter(n => n.embedded);
    if (embeddedNodes.length === 0) return { rebuilt: 0 };

    console.log(`🔄 [VectorStore] 开始重建 ${embeddedNodes.length} 条向量（${embeddingConfig.model}）...`);
    const vectors = await getEmbeddings(embeddedNodes.map(n => n.content), embeddingConfig);

    for (let i = 0; i < embeddedNodes.length; i++) {
        const mv: MemoryVector = {
            memoryId: embeddedNodes[i].id,
            charId,
            vector: vectors[i],
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        await MemoryVectorDB.save(mv);
    }

    console.log(`✅ [VectorStore] 重建完成：${embeddedNodes.length} 条向量已更新为 ${embeddingConfig.model}`);
    return { rebuilt: embeddedNodes.length };
}
