/**
 * Memory Palace — Embedding 服务（momo 适配版，自包含）
 *
 * 调用 OpenAI 兼容的 Embedding API，将文本转为向量。
 * 移植自 SullyOS utils/memoryPalace/embedding.ts，去掉 maintenanceMode 依赖，
 * 保留分批 / 截断 / 重试 / 逐条降级逻辑。
 *
 * 接入说明：本文件默认直连 OpenAI 兼容端点。若想复用 momo 已有的
 * lib/memory-embedding.ts（含各服务商 baseUrl/headers 映射），可在调用方用
 * 集成指南里的 `embedConfigFromMomoApiConfig` 把 ApiConfig 转成 EmbeddingConfig，
 * 或直接把本文件的 callEmbeddingAPI 换成 momo 的 generateEmbedding。
 */

import type { EmbeddingConfig } from './types';

// ─── 核心 API 调用 ────────────────────────────────────

export async function getEmbedding(text: string, config: EmbeddingConfig): Promise<Float32Array> {
    const results = await getEmbeddings([text], config);
    return results[0];
}

export async function getEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 10;
    const MAX_ITEM_CHARS = 4000;
    const BATCH_CHAR_BUDGET = 6000;
    const MAX_CONCURRENCY = 5;

    const truncatedNotes: string[] = [];
    const safeTexts = texts.map((t, i) => {
        if (t.length <= MAX_ITEM_CHARS) return t;
        truncatedNotes.push(`第${i + 1}条(${t.length}字, 开头"${t.slice(0, 30).replace(/\n/g, ' ')}")`);
        return t.slice(0, MAX_ITEM_CHARS);
    });
    if (truncatedNotes.length > 0) {
        console.error(
            `⚠️ [Embedding] ${truncatedNotes.length} 条输入超 ${MAX_ITEM_CHARS} 字上限，已截断出向量（内容本体不受影响，仅按前 ${MAX_ITEM_CHARS} 字建索引）：${truncatedNotes.join('；')}`,
        );
    }

    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentChars = 0;
    for (const t of safeTexts) {
        if (currentChunk.length > 0
            && (currentChunk.length >= BATCH_SIZE || currentChars + t.length > BATCH_CHAR_BUDGET)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }
        currentChunk.push(t);
        currentChars += t.length;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const results: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
        const window = chunks.slice(i, i + MAX_CONCURRENCY);
        const windowResults = await Promise.all(
            window.map(chunk => callEmbeddingAPI(chunk, config)),
        );
        for (const batchResult of windowResults) {
            results.push(...batchResult.map(v => new Float32Array(v)));
        }
    }

    return results;
}

function modelSupportsDimensions(model: string): boolean {
    return /qwen3?-?embedding/i.test(model);
}

async function callEmbeddingAPI(
    input: string[], config: EmbeddingConfig, retryCount: number = 0
): Promise<number[][]> {
    let baseUrl = config.baseUrl.replace(/\/+$/, '');
    baseUrl = baseUrl.replace('ai.siliconflow.cn', 'api.siliconflow.cn');
    const url = `${baseUrl}/embeddings`;

    const body: Record<string, unknown> = {
        model: config.model,
        input,
        encoding_format: 'float',
    };
    if (modelSupportsDimensions(config.model) && config.dimensions) {
        body.dimensions = config.dimensions;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error(
                `❌ [Embedding] API ${response.status} (model=${config.model}, batch=${input.length} 条, 各条字符数=[${input.map(s => s.length).join(', ')}])`,
                errorText,
            );
            const err = new Error(`Embedding API error ${response.status}: ${errorText}`) as Error & { status?: number };
            err.status = response.status;
            throw err;
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) {
            throw new Error(`Embedding API returned unexpected format: ${JSON.stringify(data).slice(0, 200)}`);
        }

        const sorted = [...data.data].sort((a: any, b: any) => a.index - b.index);
        return sorted.map((item: any) => item.embedding as number[]);

    } catch (err: any) {
        const status: number | undefined = err?.status;
        const retryable = status === undefined || status >= 500 || status === 429;
        if (retryable && retryCount < 1) {
            console.warn(`⚡ [Embedding] Retry after error: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
            return callEmbeddingAPI(input, config, retryCount + 1);
        }
        if (status === 400 && input.length > 1) {
            console.warn(`⚡ [Embedding] 批量 ${input.length} 条被 400 拒，自动降级为逐条向量化`);
            const results: number[][] = [];
            for (let i = 0; i < input.length; i++) {
                try {
                    const single = await callEmbeddingAPI([input[i]], config, 1);
                    results.push(single[0]);
                } catch (itemErr: any) {
                    const preview = input[i].slice(0, 80).replace(/\n/g, ' ');
                    throw new Error(
                        `Embedding 逐条降级后第 ${i + 1}/${input.length} 条仍失败（${input[i].length} 字，开头："${preview}"）: ${itemErr.message}`,
                    );
                }
            }
            console.error(
                `⚠️ [Embedding] 上面的批量 400 已自动降级为逐条向量化并全部成功，本次结果完整无缺。若频繁出现，请把日志里 400 那条的完整响应反馈给开发者`,
            );
            return results;
        }
        throw err;
    }
}

// ─── 数学工具 ──────────────────────────────────────────

export function cosineSimilarity(
    a: number[] | Float32Array,
    b: number[] | Float32Array,
): number {
    const len = a.length;
    if (len !== b.length) {
        throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    const limit = len - (len % 4);
    let i = 0;
    for (; i < limit; i += 4) {
        const a0 = a[i], a1 = a[i + 1], a2 = a[i + 2], a3 = a[i + 3];
        const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
        dotProduct += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
        normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
        normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
    }
    for (; i < len; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}
