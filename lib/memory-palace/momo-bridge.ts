/**
 * Memory Palace — momo 接线层（bridge）
 *
 * 这是"引擎"与"momo 现有功能"之间唯一的耦合点。包内其他文件保持纯净、
 * 不依赖 momo 的业务模块；所有对 momo 的依赖都收敛到本文件。
 *
 * 设计原则（重要）：
 *  1. **只读分流，不侵入**：调用方（lib/memory-service.ts）以"返回 null 就回退老逻辑"
 *     的方式使用本文件。任何异常、任何前置条件不满足，一律 return null，
 *     绝不让记忆库把聊天主流程带崩。
 *  2. **有数据才接管**：palace 里没有任何节点时直接返回 null。所以"没做迁移"
 *     = 行为与接入前完全一致，不存在"记忆突然消失"的风险。
 *  3. **开关可关**：getMemoryPalaceEnabled(charId) 为 false 时一律走老逻辑。
 *
 * 对外提供三组能力：
 *  - 召回：recallLongTermFromPalace / recallCoreFromPalace
 *  - 写入：mirrorEntryToPalace（老的总结管线产出后镜像进房间）
 *  - 迁移：migrateLegacyMemoriesForCharacter（把已有 long_term/core 全量导入）
 */

import type { ApiConfig } from '../settings-types';
import type { ContentAppId } from '../settings-types';
import type { MemoryConfig, MemoryEntry } from '../memory-types';
import type { EmbeddingConfig, MemoryNode, MemoryRoom } from './types';
import { PLATE_ROOMS, PLATE_TITLES } from './types';
import { MemoryNodeDB, RoomPlateDB } from './db';
import { hybridSearch } from './hybrid-search';
import { applyPriming } from './priming';
import { spreadActivation } from './activation';
import { getMemoryPalaceEnabled } from './config';
import { runConsolidation } from './consolidation';
import { resolveAuxiliaryApiConfig } from '../settings-storage';
import { loadMemoryEntriesByType } from '../memory-storage';
import { generateEmbedding, resolveEmbeddingModel } from '../memory-embedding';
import { estimateTokens } from '../token-counter';
import { kvGet, kvSet } from '../kv-db';

/** 镜像写入时给节点打的前缀，便于识别"来源是老记忆条目"。 */
const MIRROR_ID_PREFIX = 'mp_';

/** 老条目 type → palace 房间。long_term 进客厅，core 进自我房（关于关系与自身的固化认知）。 */
const LEGACY_TYPE_ROOM: Record<MemoryEntry['type'], MemoryRoom> = {
    long_term: 'living_room',
    core: 'self_room',
};

// ─── 公共小工具 ────────────────────────────────────────

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function toIso(ts: number): string {
    return new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
}

/** 把 momo 的 ApiConfig 转成引擎的 EmbeddingConfig（真实维度在拿到向量后回填）。 */
function toEmbeddingConfig(apiConfig: ApiConfig, dimensions: number): EmbeddingConfig {
    return {
        baseUrl: (apiConfig.baseUrl || '').trim(),
        apiKey: apiConfig.apiKey,
        model: resolveEmbeddingModel(apiConfig) || '',
        dimensions,
    };
}

/** 解析可用的 embedding 配置；不可用返回 null（调用方据此回退）。 */
function resolveUsableEmbeddingApi(): ApiConfig | null {
    const apiConfig = resolveAuxiliaryApiConfig('embeddingApiConfigId');
    if (!apiConfig || !apiConfig.apiKey) return null;
    if (!resolveEmbeddingModel(apiConfig)) return null;
    return apiConfig;
}

/** 老条目 → palace 节点（不落库，纯转换）。 */
function legacyEntryToNode(entry: MemoryEntry): MemoryNode {
    const created = new Date(entry.createdAt).getTime();
    const updated = new Date(entry.updatedAt).getTime();
    return {
        id: `${MIRROR_ID_PREFIX}${entry.id}`,
        charId: entry.characterId,
        content: entry.content,
        room: LEGACY_TYPE_ROOM[entry.type] ?? 'living_room',
        tags: [entry.type, entry.sourceApp].filter(Boolean),
        importance: clamp01(entry.importance) * 10,
        mood: '平静',
        embedded: false,
        createdAt: Number.isFinite(created) ? created : Date.now(),
        lastAccessedAt: Number.isFinite(updated) ? updated : Date.now(),
        accessCount: 0,
        sourceId: entry.id,
        origin: 'extraction',
        archived: false,
    };
}

/** palace 节点 → momo MemoryEntry（召回结果回灌给老的格式化函数）。 */
function nodeToMemoryEntry(
    node: MemoryNode,
    characterId: string,
    sourceApp: ContentAppId,
): MemoryEntry {
    return {
        id: `${MIRROR_ID_PREFIX}${node.id}`,
        characterId,
        sourceApp,
        type: 'long_term',
        content: node.content,
        importance: clamp01(node.importance / 10),
        createdAt: toIso(node.createdAt),
        updatedAt: toIso(node.lastAccessedAt || node.createdAt),
        metadata: {
            palace: true,
            room: node.room,
            mood: node.mood,
            tags: node.tags,
            ...(typeof node.valence === 'number' ? { valence: node.valence } : {}),
            ...(typeof node.arousal === 'number' ? { arousal: node.arousal } : {}),
        },
    };
}

/** 按 token 预算截取（与 memory-service 的 fillByBudget 同口径）。 */
function fillEntriesByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}

// ─── 召回：长期记忆 ────────────────────────────────────

export interface PalaceRecallOptions {
    characterId: string;
    /** 当前上下文，作为检索查询。 */
    query: string;
    config: MemoryConfig;
    /** 可选：当前情绪（Russell VA 或情绪词）。缺省不启用情绪启动。 */
    mood?: string | { v: number; a: number };
    /** 来源应用，写进 MemoryEntry.sourceApp。 */
    sourceApp?: ContentAppId;
    /** 混合检索初筛条数。 */
    topK?: number;
}

/**
 * 从记忆宫殿召回长期记忆。
 *
 * @returns 命中则返回 MemoryEntry[]（可能为空数组），**未启用/无数据/出错返回 null**，
 *          调用方见 null 应回退到原有 retrieveMemoriesForPrompt 逻辑。
 */
export async function recallLongTermFromPalace(
    options: PalaceRecallOptions,
): Promise<MemoryEntry[] | null> {
    const { characterId, query, config } = options;
    const sourceApp: ContentAppId = options.sourceApp ?? 'chat';

    try {
        if (!characterId || !query.trim()) return null;
        if (!getMemoryPalaceEnabled(characterId)) return null;

        // 有数据才接管：没有已向量化的节点 → 触发一次后台播种，本次仍回退老逻辑
        const nodes = await MemoryNodeDB.getByCharId(characterId);
        const searchable = nodes.filter(n => n.embedded && !n.archived);
        if (searchable.length === 0) {
            void autoSeedPalace(characterId).catch(() => {});
            return null;
        }

        const apiConfig = resolveUsableEmbeddingApi();
        if (!apiConfig) return null;

        const queryVector = await generateEmbedding(query, apiConfig);
        if (!queryVector || queryVector.length === 0) return null;

        const embeddingConfig = toEmbeddingConfig(apiConfig, queryVector.length);

        // ① 混合检索：85% 向量 + 15% BM25，再叠加房间权重与熟悉度
        const scored = await hybridSearch(
            query,
            characterId,
            embeddingConfig,
            options.topK ?? 12,
            { queryVector: new Float32Array(queryVector), allNodes: nodes },
        );
        if (scored.length === 0) return null;

        // ② 情绪启动：当前情绪与记忆情绪接近的，权重上浮
        const primed = options.mood ? applyPriming(scored, options.mood) : scored;

        // ③ 扩散激活：沿关联网络把相关记忆一并唤起
        const expanded = await spreadActivation(primed, characterId, 'emotional', 3);

        // ④ 去重 + 按最终分排序
        const seen = new Set<string>();
        const rankedNodes: MemoryNode[] = [];
        const sorted = [...expanded].sort((a, b) => b.finalScore - a.finalScore);
        for (const item of sorted) {
            if (seen.has(item.node.id)) continue;
            seen.add(item.node.id);
            if (item.node.archived) continue;
            rankedNodes.push(item.node);
        }
        if (rankedNodes.length === 0) return null;

        // 访问痕迹：被想起的记忆"更熟了"，后续更容易再被想起，也更容易晋升到卧室
        void touchRecalledNodes(rankedNodes).catch(() => {});

        // ⑤ 按老配置的 token 预算截取，保证注入体积不变
        const entries = rankedNodes.map(node => nodeToMemoryEntry(node, characterId, sourceApp));
        return fillEntriesByBudget(entries, config.longTermTokenBudget);
    } catch (error) {
        console.warn('[MemoryPalace] 长期记忆召回失败，已回退原逻辑：', error);
        return null;
    }
}

// ─── 召回：核心记忆 ────────────────────────────────────

export interface PalaceCoreRecallOptions {
    characterId: string;
    config: MemoryConfig;
    sourceApp?: ContentAppId;
}

/**
 * 从记忆宫殿召回核心记忆（角色画像层）。
 * 优先读"门牌"（RoomPlate：TA的事 / 我是谁 / 我们之间 / 我的领域）；
 * 门牌尚未整理时，退而取自我房 + 用户房里重要度最高的节点。
 *
 * @returns 同 recallLongTermFromPalace：不可用返回 null。
 */
export async function recallCoreFromPalace(
    options: PalaceCoreRecallOptions,
): Promise<MemoryEntry[] | null> {
    const { characterId, config } = options;
    const sourceApp: ContentAppId = options.sourceApp ?? 'chat';

    try {
        if (!characterId) return null;
        if (!getMemoryPalaceEnabled(characterId)) return null;

        const plates = await RoomPlateDB.getByCharId(characterId);
        const plateEntries: MemoryEntry[] = [];

        if (plates && plates.length > 0) {
            for (const room of PLATE_ROOMS) {
                const plate = plates.find(p => p.room === room);
                if (!plate || plate.entries.length === 0) continue;
                const title = PLATE_TITLES[room] ?? room;
                for (const entry of plate.entries) {
                    const text = `【${title}】${entry.text}`;
                    plateEntries.push({
                        id: `${MIRROR_ID_PREFIX}plate_${plate.id}_${entry.id}`,
                        characterId,
                        sourceApp,
                        type: 'core',
                        content: text,
                        importance: clamp01(entry.sourceCount / 10),
                        createdAt: toIso(entry.firstLearnedAt),
                        updatedAt: toIso(entry.updatedAt),
                        metadata: { palace: true, plate: room, plateTitle: title },
                    });
                }
            }
        }

        if (plateEntries.length > 0) {
            return fillEntriesByBudget(plateEntries, config.coreMemoryTokenBudget);
        }

        // 兜底：门牌还没整理，用自我房 + 用户房的高重要度节点
        const selfNodes = await MemoryNodeDB.getByRoom(characterId, 'self_room');
        const userNodes = await MemoryNodeDB.getByRoom(characterId, 'user_room');
        const fallback = [...selfNodes, ...userNodes]
            .filter(n => !n.archived && n.content.trim().length > 0)
            .sort((a, b) => b.importance - a.importance);
        if (fallback.length === 0) return null;

        const entries = fallback.map(node => {
            const entry = nodeToMemoryEntry(node, characterId, sourceApp);
            return { ...entry, type: 'core' as const };
        });
        return fillEntriesByBudget(entries, config.coreMemoryTokenBudget);
    } catch (error) {
        console.warn('[MemoryPalace] 核心记忆召回失败，已回退原逻辑：', error);
        return null;
    }
}

// ─── 写入：把老管线的产出镜像进房间 ──────────────────────

export interface MirrorResult {
    stored: boolean;
    embedded: boolean;
    reason?: string;
}

export interface MirrorOptions {
    /**
     * 写入前把同房间的其他"镜像节点"归档。用于 core 记忆：
     * 老系统每次重建核心记忆都生成新 id，若照搬会在房间里堆出一串过期画像，
     * 因此只保留最新一份。
     */
    archiveRoomSiblings?: boolean;
}

/**
 * 把一条老记忆条目镜像成 palace 节点（幂等：同一 entry.id 只会有一个节点）。
 *
 * 调用时机：老的 memory-summarizer / core-memory-builder 刚 saveMemoryEntry 之后。
 * 不会修改、不会删除原条目——老系统仍然是唯一事实源，palace 只是"另一份可检索的副本"。
 */
export async function mirrorEntryToPalace(
    entry: MemoryEntry,
    options: MirrorOptions = {},
): Promise<MirrorResult> {
    try {
        if (!entry?.id || !entry.characterId || !entry.content?.trim()) {
            return { stored: false, embedded: false, reason: 'empty' };
        }
        if (!getMemoryPalaceEnabled(entry.characterId)) {
            return { stored: false, embedded: false, reason: 'disabled' };
        }

        const node = legacyEntryToNode(entry);
        const existing = await MemoryNodeDB.getById(node.id);
        if (existing) {
            // 内容没变就不重复向量化
            if (existing.content === node.content) {
                return { stored: true, embedded: existing.embedded, reason: 'exists' };
            }
            node.createdAt = existing.createdAt;
            node.accessCount = existing.accessCount;
        }

        if (options.archiveRoomSiblings) {
            const siblings = await MemoryNodeDB.getByRoom(entry.characterId, node.room);
            const stale = siblings.filter(
                old => old.id !== node.id
                    && !old.archived
                    && old.id.startsWith(MIRROR_ID_PREFIX)
                    && old.sourceId !== entry.id,
            );
            for (const old of stale) {
                await MemoryNodeDB.save({ ...old, archived: true });
            }
        }

        const apiConfig = resolveUsableEmbeddingApi();
        if (!apiConfig) {
            await MemoryNodeDB.save({ ...node, embedded: false });
            void maybeConsolidate(entry.characterId).catch(() => {});
            return { stored: true, embedded: false, reason: 'no-embedding-api' };
        }

        const vector = await generateEmbedding(node.content, apiConfig);
        if (!vector || vector.length === 0) {
            await MemoryNodeDB.save({ ...node, embedded: false });
            void maybeConsolidate(entry.characterId).catch(() => {});
            return { stored: true, embedded: false, reason: 'embedding-failed' };
        }

        node.embedded = true;
        await MemoryNodeDB.saveVectorizedMany([{
            node,
            vector: {
                memoryId: node.id,
                charId: node.charId,
                vector,
                dimensions: vector.length,
                model: resolveEmbeddingModel(apiConfig) || '',
            },
        }]);
        // 新记忆进客厅后顺手跑一次巩固（节流 1 小时/角色）：重要度够或被反复想起的晋升到卧室，
        // 客厅超 200 条时把最不重要的沉到阁楼——遗忘曲线就是在这里生效的。
        void maybeConsolidate(entry.characterId).catch(() => {});
        return { stored: true, embedded: true };
    } catch (error) {
        console.warn('[MemoryPalace] 镜像写入失败（不影响原有记忆）：', error);
        return { stored: false, embedded: false, reason: 'error' };
    }
}

// ─── 迁移：把已有老记忆全量导入房间 ──────────────────────

export interface MigrationResult {
    total: number;
    stored: number;
    embedded: number;
    skipped: number;
    failed: number;
}

/**
 * 把某个角色已有的 long_term / core 条目全量导入 palace。
 * 幂等：重复执行只会更新已存在的节点，不会产生重复。
 *
 * @param onProgress 可选进度回调（当前序号 / 总数）。
 */
export async function migrateLegacyMemoriesForCharacter(
    characterId: string,
    onProgress?: (done: number, total: number) => void,
): Promise<MigrationResult> {
    const result: MigrationResult = { total: 0, stored: 0, embedded: 0, skipped: 0, failed: 0 };

    const longTerm = await loadMemoryEntriesByType(characterId, 'long_term');
    const coreAll = await loadMemoryEntriesByType(characterId, 'core');

    // core 只取最新一条：老系统每次重建核心记忆都新增一条（靠 metadata.active 区分），
    // 全量导入会把自我房塞满过期画像。long_term 则全量导入。
    const coreLatest = coreAll.length > 0
        ? [...coreAll].sort((a, b) => {
            const aActive = a.metadata?.active ? 1 : 0;
            const bActive = b.metadata?.active ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
        })[0]
        : null;

    const all = coreLatest ? [...longTerm, coreLatest] : longTerm;
    result.total = all.length;
    if (all.length === 0) return result;

    let done = 0;
    for (const entry of all) {
        const outcome = await mirrorEntryToPalace(
            entry,
            entry.type === 'core' ? { archiveRoomSiblings: true } : {},
        );
        if (outcome.stored) {
            result.stored++;
            if (outcome.embedded) result.embedded++;
            if (outcome.reason === 'exists') result.skipped++;
        } else {
            result.failed++;
        }
        done++;
        onProgress?.(done, result.total);
    }

    return result;
}

/**
 * 迁移所有"有记忆的角色"。
 * 与 memory-bank-page 里 getAllCharacterIdsWithMemories 的口径一致，但为避免
 * 反向依赖 UI 层，这里由调用方传入角色 id 列表。
 */
export async function migrateLegacyMemoriesForCharacters(
    characterIds: string[],
    onProgress?: (characterId: string, done: number, total: number) => void,
): Promise<Record<string, MigrationResult>> {
    const summary: Record<string, MigrationResult> = {};
    for (const characterId of characterIds) {
        summary[characterId] = await migrateLegacyMemoriesForCharacter(
            characterId,
            (done, total) => onProgress?.(characterId, done, total),
        );
    }
    return summary;
}

/** 某个角色在 palace 里是否已经有可检索的数据（UI 用来判断"要不要提示做迁移"）。 */
export async function hasPalaceData(characterId: string): Promise<boolean> {
    try {
        const nodes = await MemoryNodeDB.getByCharId(characterId);
        return nodes.some(n => n.embedded && !n.archived);
    } catch {
        return false;
    }
}

// ─── 访问痕迹（熟悉度 / 晋升判定的数据源） ──────────────

/**
 * 回写被召回记忆的访问痕迹：accessCount +1、lastAccessedAt 刷新。
 *
 * 这一步不能省——`shouldPromote` 靠 accessCount 判断"被反复想起就该晋升到卧室"，
 * `hybridSearch` 的熟悉度加成也读它。不回写的话这两套机制永远是 0，引擎只退化成一个普通向量库。
 * 异步 fire-and-forget，不拖慢召回。
 */
async function touchRecalledNodes(nodes: MemoryNode[]): Promise<void> {
    const now = Date.now();
    for (const node of nodes) {
        try {
            await MemoryNodeDB.save({
                ...node,
                accessCount: (node.accessCount || 0) + 1,
                lastAccessedAt: now,
            });
        } catch {
            // 单条写失败不影响其余，也不影响本次召回结果
        }
    }
}

// ─── 巩固（晋升 / 沉底）调度 ────────────────────────────

/** 同一角色两次巩固之间的最小间隔，避免每次镜像都全量扫房间。 */
const CONSOLIDATION_INTERVAL_MS = 60 * 60 * 1000;
const lastConsolidationAt = new Map<string, number>();

/**
 * 触发一次巩固：客厅 → 卧室晋升（重要度够高 / 被反复想起），
 * 客厅超容量时把最不重要的沉到阁楼。
 *
 * 这就是"仿脑遗忘"真正生效的地方——不做这一步，palace 只是个普通向量库。
 * 节流到每小时最多一次；纯本地 IDB 操作，不调外部 API。
 */
async function maybeConsolidate(characterId: string): Promise<void> {
    const last = lastConsolidationAt.get(characterId) ?? 0;
    if (Date.now() - last < CONSOLIDATION_INTERVAL_MS) return;
    lastConsolidationAt.set(characterId, Date.now());
    try {
        const result = await runConsolidation(characterId);
        if (result.promoted.length > 0 || result.evicted.length > 0) {
            console.log('[MemoryPalace] 巩固完成：', result);
        }
    } catch (error) {
        console.warn('[MemoryPalace] 巩固失败（不影响记忆读写）：', error);
    }
}

// ─── 自动播种（首次接管时把老记忆搬进房间） ──────────────

const SEEDED_KEY = (charId: string) => `mp_seeded_${charId}`;

/** 进程内的在途标记，避免同一次会话里重复触发。 */
const seedingCharacters = new Set<string>();

/**
 * 首次接管时自动把老记忆搬进房间。
 *
 * 设计要点：**不阻塞召回**。调用方 fire-and-forget 触发后本次仍返回 null（走老逻辑），
 * 等后台搬完，下一次聊天就自动切到新引擎——用户不需要点任何按钮。
 */
async function autoSeedPalace(characterId: string): Promise<void> {
    if (seedingCharacters.has(characterId)) return;
    if (kvGet(SEEDED_KEY(characterId)) === 'done') return;
    // 没有可用的 embedding 配置就别搬了，否则搬进来也检索不了，还会反复重试
    if (!resolveUsableEmbeddingApi()) return;

    seedingCharacters.add(characterId);
    try {
        const result = await migrateLegacyMemoriesForCharacter(characterId);
        if (result.total > 0 && result.embedded > 0 && result.failed === 0) {
            kvSet(SEEDED_KEY(characterId), 'done');
        }
        console.log('[MemoryPalace] 自动播种完成：', result);
        // 一次搬进来一大批，顺手巩固一遍：重要度高的升卧室，客厅超容量的沉阁楼
        void maybeConsolidate(characterId).catch(() => {});
    } catch (error) {
        console.warn('[MemoryPalace] 自动播种失败（下次会重试）：', error);
    } finally {
        seedingCharacters.delete(characterId);
    }
}

