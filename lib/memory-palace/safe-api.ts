/**
 * Memory Palace — 安全 fetch 辅助
 *
 * 轻量版 safeFetchJson：带超时与有限重试，用于 rerank / 关联判断等
 * 本地 LLM 调用。失败时抛出，交由调用方决定降级。
 */

export interface SafeFetchOptions {
    /** 额外重试次数（默认 1） */
    retries?: number;
    /** 单次超时（毫秒，默认 30000） */
    timeoutMs?: number;
}

export async function safeFetchJson(
    url: string,
    init: RequestInit,
    retries: number = 1,
    timeoutMs: number = 30_000,
    _opts?: { appName?: string; purpose?: string },
): Promise<any> {
    let lastError: unknown;
    const attempts = 1 + Math.max(0, retries);
    for (let i = 0; i < attempts; i++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            }
            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            lastError = err;
            if (i < attempts - 1) {
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
