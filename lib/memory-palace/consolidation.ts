/**
 * Memory Palace — 巩固 (Consolidation)（momo 适配版）
 *
 * 模拟短期记忆 → 长期记忆的过程：
 * - 客厅 → 卧室晋升
 * - 艾宾浩斯遗忘曲线 + 有效重要性 floor
 * - 客厅容量管理
 *
 * 与 SullyOS 的区别：去掉跨设备 Supabase 同步（一期不做）。
 */

import type { MemoryNode, MemoryRoom } from './types';
import { ROOM_CONFIGS, resolveMemoryScoringRoom } from './types';
import { MemoryNodeDB } from './db';

const EFFECTIVE_IMPORTANCE_FLOOR_RATIOS: Record<MemoryRoom, number> = {
    living_room: 0.80,
    bedroom:     0.90,
    study:       0.90,
    user_room:   0.90,
    self_room:   1.00,
    attic:       1.00,
    windowsill:  1.00,
};

export function calculateEffectiveImportance(node: MemoryNode, now: number = Date.now()): number {
    const room = resolveMemoryScoringRoom(node.room);
    const config = ROOM_CONFIGS[room];

    if (config.decayRate === null) return node.importance;

    const hours = (now - node.createdAt) / (1000 * 60 * 60);
    if (hours <= 0) return node.importance;

    const decayed = node.importance * Math.pow(config.decayRate, hours);
    const floor = node.importance * EFFECTIVE_IMPORTANCE_FLOOR_RATIOS[room];
    return Math.max(decayed, floor);
}

export function shouldPromote(node: MemoryNode, now: number = Date.now()): boolean {
    if (node.room !== 'living_room') return false;
    if (node.importance >= 8) return true;
    const ageHours = (now - node.createdAt) / (1000 * 60 * 60);
    if (node.importance >= 6 && ageHours >= 24) return true;
    if (node.accessCount >= 3) return true;
    return false;
}

export interface ConsolidationResult {
    promoted: string[];
    evicted: string[];
}

export async function runConsolidation(charId: string): Promise<ConsolidationResult> {
    const now = Date.now();
    const result: ConsolidationResult = { promoted: [], evicted: [] };

    const livingRoomNodes = await MemoryNodeDB.getByRoom(charId, 'living_room');

    for (const node of livingRoomNodes) {
        if (shouldPromote(node, now)) {
            node.room = 'bedroom';
            await MemoryNodeDB.save(node);
            result.promoted.push(node.id);
            console.log(`⬆️ [Consolidation] Promoted to bedroom: "${node.content.slice(0, 30)}..."`);
        }
    }

    const capacity = ROOM_CONFIGS.living_room.capacity;
    if (capacity !== null) {
        const remainingNodes = await MemoryNodeDB.getByRoom(charId, 'living_room');
        if (remainingNodes.length > capacity) {
            const scored = remainingNodes.map(n => ({
                node: n,
                effective: calculateEffectiveImportance(n, now),
            }));
            scored.sort((a, b) => a.effective - b.effective);
            const toEvict = scored.slice(0, remainingNodes.length - capacity);
            for (const { node } of toEvict) {
                node.room = 'attic';
                await MemoryNodeDB.save(node);
                result.evicted.push(node.id);
                console.log(`📦 [Consolidation] Evicted to attic: "${node.content.slice(0, 30)}..."`);
            }
        }
    }

    if (result.promoted.length > 0 || result.evicted.length > 0) {
        console.log(`✅ [Consolidation] ${result.promoted.length} promoted, ${result.evicted.length} evicted`);
    }

    return result;
}
