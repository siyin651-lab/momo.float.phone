// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { recallCoreFromPalace, recallLongTermFromPalace } from "./memory-palace/momo-bridge";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    // ── 记忆库（Memory Palace）接管点 ──
    // 未启用 / 房间里还没数据 / 取向量失败 / 任何异常 → 返回 null，自动落回下面的老逻辑。
    // 所以"没做过迁移"时行为与接入前完全一致，不存在记忆突然消失的风险。
    const palaceEntries = await recallLongTermFromPalace({
        characterId,
        query: currentContext,
        config,
    });
    if (palaceEntries && palaceEntries.length > 0) return palaceEntries;

    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    // ── 记忆库（Memory Palace）接管点 ──
    // 优先读门牌（TA的事 / 我是谁 / 我们之间 / 我的领域），门牌没整理时退到自我房+用户房高权重节点。
    // 同样：不可用就返回 null，落回老的核心记忆逻辑。
    const palaceCore = await recallCoreFromPalace({ characterId, config });
    if (palaceCore && palaceCore.length > 0) return palaceCore;

    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
