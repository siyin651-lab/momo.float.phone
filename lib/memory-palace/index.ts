/**
 * Memory Palace (记忆宫殿) — 统一导出（momo 适配版 · Phase 1 引擎核心）
 *
 * 移植自 SullyOS utils/memoryPalace，一期聚焦"引擎核心"：
 * 房间 / 情感空间 / 混合检索 / 巩固 / 关联 / 扩散激活 / 情绪启动 / 水位线 / 门牌存储。
 * 二期（抽取 / EventBox / 门牌 LLM 整理 / 管线编排）与四期（认知消化 / 期盼 /
 * 远程向量 / 高级召回闸门）在各自模块落地后再从本文件增量导出。
 */

// 类型
export type {
    MemoryRoom, RoomConfig, MemoryEntity, MemoryNode, MemoryVector, MemoryLink,
    LinkType, EventBox, PlateRoom, PlateEntry, RoomPlate, DigestReport,
    DigestReportSection, Anticipation, AnticipationStatus, MemoryBatch,
    PersonalityStyle, EmbeddingConfig, RemoteVectorConfig, LightLLMConfig,
    MemoryPalaceWaterlineConfig, MemoryPalaceWaterlinePreset, ScoredMemory,
} from './types';
export {
    ROOM_CONFIGS, ROOM_LABELS, getRoomLabel, resolveMemoryScoringRoom,
    PERSONALITY_WEIGHTS, EVENT_BOX_COMPRESSION_THRESHOLD, EVENT_BOX_LIVE_HARD_CAP,
    EVENT_BOX_SEAL_THRESHOLD, PLATE_ROOMS, PLATE_TITLES, PLATE_ENTRY_CAPS,
    PLATE_ENTRY_TARGET_CHARS, PLATE_ENTRY_HARD_MAX_CHARS, DIGEST_REPORT_KEEP,
} from './types';

// 数据库
export {
    openDB, MemoryNodeDB, MemoryVectorDB, MemoryLinkDB, MemoryBatchDB,
    AnticipationDB, EventBoxDB, RoomPlateDB, plateId, loadOrCreatePlate,
    mutatePlate, ROOM_PLATES_UPDATED_EVENT, MP_NODES_CHANGED_EVENT,
    ensureFloat32, wipeAllMemoryPalace,
} from './db';

// Embedding
export { getEmbedding, getEmbeddings, cosineSimilarity } from './embedding';

// Rerank
export { rerankDocuments } from './rerank';
export type { RerankApiConfig, RerankResult } from './rerank';

// 向量化 / 存储 / 去重
export {
    vectorizeAndStore, updateStoredMemoryNode, checkModelConsistency, rebuildAllVectors,
} from './vectorStore';
export type { UpdateStoredMemoryNodeResult } from './vectorStore';

// 巩固
export { runConsolidation, calculateEffectiveImportance, shouldPromote } from './consolidation';
export type { ConsolidationResult } from './consolidation';

// 关联网络
export { buildLinks, strengthenCoActivated } from './links';

// 检索
export { vectorSearch } from './vectorSearch';
export type { VectorSearchResult } from './vectorSearch';
export { bm25Search, tokenize } from './bm25';
export type { BM25Result } from './bm25';
export { hybridSearch } from './hybridSearch';
export type { HybridSearchPrefetch } from './hybridSearch';

// 扩散激活 / 情绪启动
export { spreadActivation } from './activation';
export { applyPriming, checkRumination } from './priming';

// 情感空间
export {
    getEmotionVA, moodToVA, emotionDistance, MOOD_TO_VA,
} from './emotionSpace';
export type { EmotionVA } from './emotionSpace';

// 水位线
export {
    DEFAULT_MEMORY_PALACE_WATERLINE, MEMORY_PALACE_WATERLINE_PRESETS,
    MIN_MEMORY_HOT_ZONE_SIZE, MAX_MEMORY_HOT_ZONE_SIZE,
    MIN_MEMORY_BUFFER_THRESHOLD, MAX_MEMORY_BUFFER_THRESHOLD,
    resolveMemoryPalaceWaterline, makeCustomMemoryPalaceWaterline,
} from './waterline';
export type { ResolvedMemoryPalaceWaterline } from './waterline';

// 水位线（消息游标）
export {
    getLocalMemoryPalaceHighWaterMark, getReliableMemoryPalaceHighWaterMark,
    setReliableMemoryPalaceHighWaterMark, healAllMemoryPalaceHighWaterMarks,
} from './high-water-mark';

// 开关 / 配置
export {
    getMemoryPalaceEnabled, setMemoryPalaceEnabled, embedConfigFromParts,
} from './config';
export type { MemoryPalaceCharacterSettings } from './config';
