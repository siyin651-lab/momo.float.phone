/**
 * Memory Palace — Rerank（cross-encoder 二次排序，momo 适配版）
 *
 * 通用 /rerank 协议，兼容 SiliconFlow / Jina / Cohere / Voyage。
 * 移植自 SullyOS utils/memoryPalace/rerank.ts，改用本包 safe-api 的 safeFetchJson。
 */

import { safeFetchJson } from './safe-api';

export interface RerankApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface RerankResult {
    index: number;
    relevance_score: number;
}

export async function rerankDocuments(
    config: RerankApiConfig,
    query: string,
    documents: string[],
    topN: number,
): Promise<RerankResult[]> {
    if (documents.length === 0 || !query.trim()) return [];

    const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`;
    const body = {
        model: config.model,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        return_documents: false,
    };

    const data = await safeFetchJson(
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
        },
        1,
        30_000,
    );

    const rows: any[] = Array.isArray(data?.results) ? data.results
                     : Array.isArray(data?.data)    ? data.data
                     : [];

    return rows
        .filter(r => typeof r?.index === 'number')
        .map(r => ({
            index: r.index,
            relevance_score: typeof r.relevance_score === 'number' ? r.relevance_score
                          : typeof r.score === 'number'            ? r.score
                          : 0,
        }));
}
