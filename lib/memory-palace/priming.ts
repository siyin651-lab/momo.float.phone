/**
 * Memory Palace — 启动效应 (Priming) + 反刍 (Rumination)（momo 适配版）
 *
 * 启动效应：当前情绪偏置检索结果（开心时更容易想起开心的事）。
 * 反刍：阁楼里的记忆有概率"不请自来"地浮现。
 * 移植自 SullyOS utils/memoryPalace/priming.ts，去 satellite 依赖。
 */

import type { MemoryNode, ScoredMemory } from './types';
import { MemoryNodeDB } from './db';
import { getEmotionVA, moodToVA, emotionDistance } from './emotion-space';

const PRIMING_MAX_BOOST = 1.3;
const PRIMING_RADIUS = 0.5;

export function applyPriming(
    results: ScoredMemory[],
    currentMood: string | { v: number; a: number } | undefined,
): ScoredMemory[] {
    if (!currentMood) return results;

    const cur = typeof currentMood === 'string' ? moodToVA(currentMood) : currentMood;
    if (cur.v === 0 && cur.a === 0) return results;

    return results.map(r => {
        const memVA = getEmotionVA(r.node);
        const dist = emotionDistance(memVA, cur);
        if (dist >= PRIMING_RADIUS) return r;
        const boost = 1 + (PRIMING_MAX_BOOST - 1) * (1 - dist / PRIMING_RADIUS);
        return { ...r, finalScore: r.finalScore * boost };
    });
}

export async function checkRumination(
    charId: string,
    tendency: number = 0.3,
): Promise<MemoryNode | null> {
    const probability = Math.min(tendency, 1) * 0.2;
    if (Math.random() > probability) return null;

    const atticNodes = await MemoryNodeDB.getByRoom(charId, 'attic');
    if (atticNodes.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * atticNodes.length);
    return atticNodes[randomIndex];
}
