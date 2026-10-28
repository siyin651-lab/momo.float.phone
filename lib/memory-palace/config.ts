/**
 * Memory Palace — 全局 / 角色级开关（momo 适配版）
 *
 * 一期通过 momo 的 kv-db 持久化一个"记忆库是否启用"的开关。
 * 角色级的人格风格（personalityStyle）/ 水位线（memoryPalaceWaterline）由角色卡
 * 携带，pipeline 在运行时读取，本文件只管"总开关"与默认值。
 */

import { kvGet, kvSet } from '../kv-db';
import type { MemoryPalaceWaterlineConfig, PersonalityStyle } from './types';

const ENABLED_KEY = (charId: string) => `mp_enabled_${charId}`;

/** 读取角色记忆库开关；缺省 true（默认开启，与 SullyOS 行为一致）。 */
export function getMemoryPalaceEnabled(charId: string): boolean {
    const raw = kvGet(ENABLED_KEY(charId));
    if (raw === null) return true;
    return raw !== 'false';
}

export function setMemoryPalaceEnabled(charId: string, enabled: boolean): void {
    kvSet(ENABLED_KEY(charId), enabled ? 'true' : 'false');
}

/** 角色卡上可选的记忆库相关字段（pipeline 读取用，供 momo 角色卡扩展参考）。 */
export interface MemoryPalaceCharacterSettings {
    memoryPalaceEnabled?: boolean;
    memoryPalaceWaterline?: MemoryPalaceWaterlineConfig;
    personalityStyle?: PersonalityStyle;
}

/**
 * 把 momo 的 ApiConfig / 角色卡里能用到的字段，转成引擎的 EmbeddingConfig。
 * 接入示例见《记忆库集成指南》。
 */
export function embedConfigFromParts(opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions?: number;
}): import('./types').EmbeddingConfig {
    return {
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        dimensions: opts.dimensions ?? 1024,
    };
}
