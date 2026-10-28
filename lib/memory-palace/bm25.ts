/**
 * Memory Palace — BM25 搜索（momo 适配版，朴素扫描）
 *
 * 关键词精确匹配，补偿向量搜索对专有名词的弱点。
 * 中文 2-gram 分词 + 英文空格分词 + TF-IDF 评分。纯前端计算，无需外部服务。
 *
 * 与 SullyOS 的区别：去掉独立的倒排索引模块（bm25Index），直接对候选集扫描。
 * momo 的记忆规模下朴素版足够快；后续若需更高性能可再加回增量索引。
 */

import type { MemoryNode } from './types';

export const K1 = 1.2;
export const B = 0.75;

export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const parts = text.split(/([a-zA-Z0-9]+)/);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        if (/^[a-zA-Z0-9]+$/.test(trimmed)) {
            tokens.push(trimmed.toLowerCase());
        } else {
            const cleaned = trimmed.replace(/[\s\p{P}]/gu, '');
            for (let i = 0; i < cleaned.length - 1; i++) {
                tokens.push(cleaned.slice(i, i + 2));
            }
            if (cleaned.length === 1) {
                tokens.push(cleaned);
            }
        }
    }

    return tokens;
}

export interface BM25Result {
    node: MemoryNode;
    score: number;
}

export function bm25Search(
    query: string,
    nodes: MemoryNode[],
    topK: number = 20,
): BM25Result[] {
    if (nodes.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

    const docTokens: string[][] = nodes.map(n => tokenize(n.content));
    const avgDl = docTokens.reduce((sum, t) => sum + t.length, 0) / docTokens.length;
    const docCount = nodes.length;
    const idf: Record<string, number> = {};

    for (const qt of queryTokens) {
        if (idf[qt] !== undefined) continue;
        const df = docTokens.filter(dt => dt.includes(qt)).length;
        idf[qt] = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    }

    const results: BM25Result[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const dl = docTokens[i].length;
        if (dl === 0) continue;

        let score = 0;
        const tf: Record<string, number> = {};
        for (const t of docTokens[i]) tf[t] = (tf[t] || 0) + 1;

        for (const qt of queryTokens) {
            const termFreq = tf[qt] || 0;
            if (termFreq === 0) continue;
            const tfNorm = (termFreq * (K1 + 1)) / (termFreq + K1 * (1 - B + B * dl / avgDl));
            score += (idf[qt] || 0) * tfNorm;
        }

        if (score > 0) results.push({ node: nodes[i], score });
    }

    results.sort((a, b) => b.score - a.score);

    if (t0 && nodes.length >= 500) {
        const dt = performance.now() - t0;
        console.log(`[bm25] ${nodes.length} nodes / ${queryTokens.length} qtokens → ${dt.toFixed(1)}ms`);
    }

    return results.slice(0, topK);
}
