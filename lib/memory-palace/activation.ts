/**
 * Memory Palace — 扩散激活 (Spreading Activation)（momo 适配版）
 *
 * 检索命中的记忆沿关联网络"联想"到相关记忆。人格风格影响不同关联类型的权重。
 * 移植自 SullyOS utils/memoryPalace/activation.ts，去 satellite 依赖。
 */

import type { MemoryNode, PersonalityStyle, ScoredMemory } from './types';
import { PERSONALITY_WEIGHTS } from './types';
import { MemoryNodeDB, MemoryLinkDB } from './db';

const ACTIVATION_DECAY = 0.3;

export async function spreadActivation(
    seeds: ScoredMemory[],
    charId: string,
    style: PersonalityStyle = 'emotional',
    maxExpand: number = 3,
): Promise<ScoredMemory[]> {
    const weights = PERSONALITY_WEIGHTS[style];
    const seedIds = new Set(seeds.map(s => s.node.id));
    const activated = new Map<string, number>();

    for (const seed of seeds) {
        const links = await MemoryLinkDB.getByNodeId(seed.node.id);
        for (const link of links) {
            const neighborId = link.sourceId === seed.node.id ? link.targetId : link.sourceId;
            if (seedIds.has(neighborId)) continue;
            const typeWeight = weights[link.type] || 0.2;
            const activationScore = seed.finalScore * link.strength * typeWeight * ACTIVATION_DECAY;
            const existing = activated.get(neighborId) || 0;
            if (activationScore > existing) activated.set(neighborId, activationScore);
        }
    }

    const sortedActivations = [...activated.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxExpand);

    const expandedResults: ScoredMemory[] = [];
    for (const [nodeId, score] of sortedActivations) {
        const node = await MemoryNodeDB.getById(nodeId);
        if (node && !node.archived) {
            expandedResults.push({ node, finalScore: score, similarity: 0, bm25Score: 0, roomScore: score });
        }
    }

    return [...seeds, ...expandedResults];
}
