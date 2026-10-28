/**
 * Memory Palace — 水位线（已处理消息游标，momo 适配版）
 *
 * 记录每个角色"已处理进记忆宫殿"的最后一条消息 ID，避免重复提取。
 * 移植自 SullyOS utils/memoryPalace/highWaterMark.ts，但持久化改用 momo 的 kv-db
 * （IndexedDB 兜底）+ localStorage（快速读路径），不再依赖 SullyOS 的 assets 表。
 *
 * 接入：pipeline 在每轮处理完消息后调用 setReliableMemoryPalaceHighWaterMark；
 * 检索/上下文过滤用 getLocalMemoryPalaceHighWaterMark 做同步判断；启动自愈调用
 * healAllMemoryPalaceHighWaterMarks。
 */

import { kvGet, kvSet, kvSetAsync, kvKeysWithPrefix } from '../kv-db';

const LOCAL_KEY = (charId: string) => `mp_lastMsgId_${charId}`;
const MIRROR_KEY = (charId: string) => `mp_hwm_v1_${charId}`;

interface HighWaterMarkMirror {
    version: 1;
    charId: string;
    msgId: number;
    updatedAt: number;
}

function normalizeMessageId(value: unknown): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 同步读取供聊天上下文过滤使用；后台管线会再用 kv 镜像校准。 */
export function getLocalMemoryPalaceHighWaterMark(charId: string): number {
    try {
        return normalizeMessageId(localStorage.getItem(LOCAL_KEY(charId)));
    } catch {
        return 0;
    }
}

/**
 * 读取 localStorage 与 kv-db 中较新的水位线。
 * 取两者最大值：浏览器清除 localStorage 但保留 kv（IndexedDB）时仍可修复。
 */
export async function getReliableMemoryPalaceHighWaterMark(charId: string): Promise<number> {
    try {
        const localValue = getLocalMemoryPalaceHighWaterMark(charId);
        const mirrorValue = normalizeMessageId(kvGet(MIRROR_KEY(charId)));
        const reliableValue = Math.max(localValue, mirrorValue);
        if (reliableValue > mirrorValue) {
            kvSet(MIRROR_KEY(charId), JSON.stringify({
                version: 1, charId, msgId: reliableValue, updatedAt: Date.now(),
            } satisfies HighWaterMarkMirror));
        }
        if (reliableValue > localValue) {
            try { localStorage.setItem(LOCAL_KEY(charId), String(reliableValue)); } catch { /* kv 仍可用 */ }
        }
        return reliableValue;
    } catch {
        return getLocalMemoryPalaceHighWaterMark(charId);
    }
}

/** 成功处理消息后同时写两份；任意一份幸存即可避免旧消息被整批重复提取。 */
export async function setReliableMemoryPalaceHighWaterMark(charId: string, msgId: number): Promise<void> {
    const normalized = normalizeMessageId(msgId);
    try { localStorage.setItem(LOCAL_KEY(charId), String(normalized)); } catch { /* 继续尝试 kv */ }
    try {
        await kvSetAsync(MIRROR_KEY(charId), JSON.stringify({
            version: 1, charId, msgId: normalized, updatedAt: Date.now(),
        } satisfies HighWaterMarkMirror));
    } catch { /* 与旧行为一致：持久化故障不抹掉已写入的记忆 */ }
}

/**
 * 启动自愈：扫描 kv-db 里的 mp_hwm_v1_* 镜像，把 localStorage 中缺失的水位线回填回去，
 * 防止浏览器清除 localStorage 后角色首次回复把全量历史读进上下文。
 */
export async function healAllMemoryPalaceHighWaterMarks(): Promise<string[]> {
    try {
        const keys = kvKeysWithPrefix('mp_hwm_v1_');
        const restored: string[] = [];
        for (const key of keys) {
            const charId = key.slice('mp_hwm_v1_'.length);
            if (!charId) continue;
            const mirrorValue = normalizeMessageId(kvGet(key));
            if (mirrorValue <= 0) continue;
            const localKey = LOCAL_KEY(charId);
            try {
                if (localStorage.getItem(localKey) === null) {
                    localStorage.setItem(localKey, String(mirrorValue));
                    restored.push(localKey);
                }
            } catch { /* ignore */ }
        }
        return restored;
    } catch {
        return [];
    }
}
