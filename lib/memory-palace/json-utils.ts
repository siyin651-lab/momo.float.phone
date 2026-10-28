/**
 * Memory Palace — JSON 解析辅助
 *
 * 从 LLM 可能夹带 ```json 围栏 / 前后说明文字的回复里，
 * 尽量抠出 JSON 数组。解析失败返回 []。
 */

export function safeParseJsonArray(text: string | undefined | null): any[] {
    if (!text) return [];
    const trimmed = text.trim();

    // 直接就是数组
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            // fall through → 尝试抠 JSON
        }
    }

    // 抠第一个 [ ... ] 区间（兼容 ```json ... ``` 围栏 / 前后说明）
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start !== -1 && end > start) {
        const slice = trimmed.slice(start, end + 1);
        try {
            const parsed = JSON.parse(slice);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    return [];
}

/** 解析 LLM 可能返回的 JSON 对象（非数组）。 */
export function safeParseJsonObject(text: string | undefined | null): Record<string, any> | null {
    if (!text) return null;
    const trimmed = text.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(trimmed.slice(start, end + 1));
            return typeof parsed === 'object' && parsed !== null ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}
