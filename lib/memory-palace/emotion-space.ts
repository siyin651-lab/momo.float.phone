/**
 * Memory Palace — 情感空间 (Russell Circumplex of Affect)
 *
 * 把情绪从离散字符串（'happy' / 'sad'）升级成二维连续坐标：
 *   - valence（效价）: -1 极痛苦 → +1 极愉悦
 *   - arousal（唤醒度）: -1 极平静 → +1 极激烈
 *
 * 下游代码（priming / links / digestion）统一通过 getEmotionVA() 取值，
 * 无需关心节点是新的（带 (v,a) 字段）还是老的（只有 mood 字符串）。
 *
 * 设计原则：
 * 1. **零迁移**：老数据通过 MOOD_TO_VA 查表兜底，不需要回填。
 * 2. **精度渐进**：新记忆由 LLM 直接给 (v,a)，精度高；老记忆走查表，精度中。
 * 3. **兼容 LLM 拼错**：查不到的 mood 字符串 fallback 到 neutral (0, 0)，不会抛错。
 */

import type { MemoryNode } from './types';

/** 情感坐标：效价 × 唤醒度 */
export interface EmotionVA {
    v: number;
    a: number;
}

export const MOOD_TO_VA: Record<string, EmotionVA> = {
    happy:      { v:  0.7, a:  0.5 },
    sad:        { v: -0.7, a: -0.5 },
    angry:      { v: -0.7, a:  0.8 },
    anxious:    { v: -0.6, a:  0.7 },
    tender:     { v:  0.6, a: -0.2 },
    excited:    { v:  0.8, a:  0.8 },
    peaceful:   { v:  0.5, a: -0.6 },
    confused:   { v: -0.2, a:  0.2 },
    hurt:       { v: -0.7, a:  0.3 },
    grateful:   { v:  0.6, a:  0.3 },
    nostalgic:  { v:  0.2, a: -0.3 },
    neutral:    { v:  0.0, a:  0.0 },

    ecstatic:      { v:  0.9, a:  0.9 },
    joyful:        { v:  0.8, a:  0.6 },
    content:       { v:  0.4, a: -0.4 },
    melancholic:   { v: -0.5, a: -0.4 },
    afraid:        { v: -0.8, a:  0.9 },
    fearful:       { v: -0.8, a:  0.9 },
    disappointed:  { v: -0.6, a: -0.2 },
    lonely:        { v: -0.6, a: -0.3 },
    proud:         { v:  0.7, a:  0.4 },
    curious:       { v:  0.3, a:  0.4 },
    bored:         { v: -0.2, a: -0.7 },
    surprised:     { v:  0.2, a:  0.8 },
    embarrassed:   { v: -0.3, a:  0.5 },
    guilty:        { v: -0.6, a:  0.2 },
    relieved:      { v:  0.5, a: -0.3 },

    开心: { v:  0.7, a:  0.5 },
    难过: { v: -0.7, a: -0.5 },
    悲伤: { v: -0.7, a: -0.5 },
    愤怒: { v: -0.7, a:  0.8 },
    焦虑: { v: -0.6, a:  0.7 },
    温柔: { v:  0.6, a: -0.2 },
    兴奋: { v:  0.8, a:  0.8 },
    平静: { v:  0.5, a: -0.6 },
    困惑: { v: -0.2, a:  0.2 },
    受伤: { v: -0.7, a:  0.3 },
    感激: { v:  0.6, a:  0.3 },
    怀念: { v:  0.2, a: -0.3 },
    失落: { v: -0.5, a: -0.4 },
    孤独: { v: -0.6, a: -0.3 },
    中性: { v:  0.0, a:  0.0 },
};

export function getEmotionVA(node: Pick<MemoryNode, 'valence' | 'arousal' | 'mood'>): EmotionVA {
    if (typeof node.valence === 'number' && typeof node.arousal === 'number') {
        return { v: node.valence, a: node.arousal };
    }
    const mood = (node.mood || '').trim();
    if (!mood) return { v: 0, a: 0 };
    return MOOD_TO_VA[mood] ?? MOOD_TO_VA[mood.toLowerCase()] ?? { v: 0, a: 0 };
}

export function moodToVA(mood: string | undefined | null): EmotionVA {
    if (!mood) return { v: 0, a: 0 };
    const key = mood.trim();
    if (!key) return { v: 0, a: 0 };
    return MOOD_TO_VA[key] ?? MOOD_TO_VA[key.toLowerCase()] ?? { v: 0, a: 0 };
}

export function emotionDistance(a: EmotionVA, b: EmotionVA): number {
    const dv = a.v - b.v;
    const da = a.a - b.a;
    return Math.hypot(dv, da);
}
