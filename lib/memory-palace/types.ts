/**
 * Memory Palace (记忆宫殿) — 类型定义
 *
 * 模拟人脑七个脑区的记忆系统。
 * 移植自 SullyOS utils/memoryPalace/types.ts，适配 momo.float.phone。
 * 所有类型集中在此文件，供其他模块导入。
 */

// ─── 七个房间 ─────────────────────────────────────────

export type MemoryRoom =
    | 'living_room'   // 客厅 — 日常闲聊、近期互动（海马体）
    | 'bedroom'       // 卧室 — 亲密情感、深层羁绊（新皮层）
    | 'study'         // 书房 — 工作学习、技能成长（前额叶）
    | 'user_room'     // 用户房间 — 用户个人信息、习惯（颞顶联合区）
    | 'self_room'     // 自我房间 — 角色自我认同、演变（默认模式网络）
    | 'attic'         // 阁楼 — 未消化的困惑、潜意识（杏仁核–海马体）
    | 'windowsill';   // 窗台 — 期盼、目标、憧憬（多巴胺奖赏系统）

export interface RoomConfig {
    capacity: number | null;    // null = 无限
    decayRate: number | null;   // null = 永不遗忘，数值为每小时衰减基数
    description: string;
}

export const ROOM_CONFIGS: Record<MemoryRoom, RoomConfig> = {
    living_room: { capacity: 200,  decayRate: 0.9972, description: '日常闲聊、近期互动' },
    bedroom:     { capacity: null, decayRate: 0.9995, description: '亲密情感、深层羁绊' },
    study:       { capacity: null, decayRate: 0.9995, description: '工作学习、技能成长' },
    user_room:   { capacity: null, decayRate: 0.9995, description: '用户个人信息、习惯' },
    self_room:   { capacity: null, decayRate: null,   description: '角色自我认同、演变' },
    attic:       { capacity: null, decayRate: null,   description: '未消化的困惑、潜意识' },
    windowsill:  { capacity: null, decayRate: null,   description: '期盼、目标、憧憬' },
};

/** 检索读到旧档/远程异常房间时沿用提取入口的客厅兜底，不改写原始记录。 */
export function resolveMemoryScoringRoom(room: unknown): MemoryRoom {
    return typeof room === 'string' && Object.prototype.hasOwnProperty.call(ROOM_CONFIGS, room)
        ? room as MemoryRoom : 'living_room';
}

export const ROOM_LABELS: Record<MemoryRoom, string> = {
    living_room: '客厅',
    bedroom:     '卧室',
    study:       '书房',
    user_room:   '用户房间',
    self_room:   '自我房间',
    attic:       '阁楼',
    windowsill:  '窗台',
};

/**
 * 获取房间的动态显示标签。
 * user_room 在有用户名时显示为"【用户名】的房间"，其余房间返回静态标签。
 */
export function getRoomLabel(room: MemoryRoom, userName?: string): string {
    if (room === 'user_room' && userName) {
        return `${userName}的房间`;
    }
    return ROOM_LABELS[room];
}

// ─── 记忆节点 ─────────────────────────────────────────

export interface MemoryEntity {
    name: string;
    type?: 'person' | 'place' | 'organization' | 'project' | 'product' | 'account' | 'domain' | 'other';
    aliases?: string[];
}

export interface MemoryNode {
    relativeTimeAnchor?: { dateKey: string; source: 'message'; messageId?: number };
    id: string;
    charId: string;
    content: string;
    room: MemoryRoom;
    tags: string[];
    entities?: MemoryEntity[];
    importance: number;
    mood: string;
    valence?: number;
    arousal?: number;
    embedded: boolean;
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    pinnedUntil?: number | null;
    sourceId?: string | null;
    origin?: 'extraction' | 'digestion' | 'system';
    digestedAt?: number | null;

    // 兼容旧版迁移残留（新代码不应写入）
    legacyCsy?: {
        originalId: string;
        title: string;
        originalContent: string;
        emotionalJourney?: string;
        source?: 'auto' | 'manual' | 'import';
        sourceMessageIds?: number[];
        deprecated?: boolean;
        deprecatedReason?: string;
        hormoneSnapshot?: Record<string, number | undefined>;
        salienceScore?: number;
        updatedAt?: number;
        modelId?: string;
    };

    // ─── EventBox 绑定（新） ─────────────────
    eventBoxId?: string | null;
    archived?: boolean;
    isBoxSummary?: boolean;

    // ─── 群聊记忆来源 ─────────────
    groupId?: string;
    groupName?: string;

    // ─── 已弃用字段（保留以兼容历史数据读取） ───
    boxId?: string;
    boxTopic?: string;
}

// ─── 向量存储 ─────────────────────────────────────────

export interface MemoryVector {
    memoryId: string;
    charId: string;
    vector: number[] | Float32Array | Uint8Array;
    dimensions: number;
    model?: string;
}

// ─── 关联网络 ─────────────────────────────────────────

export type LinkType =
    | 'temporal'
    | 'emotional'
    | 'causal'
    | 'person'
    | 'metaphor';

export interface MemoryLink {
    id: string;
    sourceId: string;
    targetId: string;
    type: LinkType;
    strength: number;
}

// ─── 事件盒 (EventBox) ─────────────────────────────────

export interface EventBox {
    id: string;
    charId: string;
    name: string;
    tags: string[];
    summaryNodeId: string | null;
    liveMemoryIds: string[];
    archivedMemoryIds: string[];
    compressionCount: number;
    createdAt: number;
    updatedAt: number;
    lastCompressedAt: number | null;
    sealed?: boolean;
    predecessorBoxId?: string | null;
}

export const EVENT_BOX_COMPRESSION_THRESHOLD = 4;
export const EVENT_BOX_LIVE_HARD_CAP = 15;
export const EVENT_BOX_SEAL_THRESHOLD = 12;
export const EVENT_BOX_SUMMARY_TARGET_MIN_CHARS = 400;
export const EVENT_BOX_SUMMARY_TARGET_MAX_CHARS = 700;
export const EVENT_BOX_SUMMARY_HARD_MAX_CHARS = 900;

// ─── 房间门牌（Room Plate — 情景→语义的固化终点） ──────

export type PlateRoom = 'user_room' | 'self_room' | 'bedroom' | 'study';

export const PLATE_ROOMS: PlateRoom[] = ['user_room', 'self_room', 'bedroom', 'study'];

export interface PlateEntry {
    id: string;
    text: string;
    firstLearnedAt: number;
    updatedAt: number;
    sourceCount: number;
    tag?: string;
}

export interface RoomPlate {
    id: string;
    charId: string;
    room: PlateRoom;
    entries: PlateEntry[];
    updatedAt: number;
    version: number;
}

export const PLATE_ENTRY_CAPS: Record<PlateRoom, number> = {
    user_room: 12,
    self_room: 10,
    bedroom:   10,
    study:     8,
};

export const PLATE_ENTRY_TARGET_CHARS = 50;
export const PLATE_ENTRY_HARD_MAX_CHARS = 90;

export const PLATE_TITLES: Record<PlateRoom, string> = {
    user_room: 'TA的事',
    self_room: '我是谁',
    bedroom:   '我们之间',
    study:     '我的领域',
};

// ─── 消化日志（DigestReport） ───

export interface DigestReportSection {
    label: string;
    items: string[];
}

export interface DigestReport {
    id: string;
    charId: string;
    createdAt: number;
    trigger: 'auto' | 'manual';
    examined: DigestReportSection[];
    outcomes: DigestReportSection[];
    plateSubmissions: DigestReportSection[];
    plateUpdated: string[];
    plateCloudPending?: boolean;
}

export const DIGEST_REPORT_KEEP = 30;

// ─── 期盼（窗台） ─────────────────────────────────────

export type AnticipationStatus = 'active' | 'anchor' | 'fulfilled' | 'disappointed';

export interface Anticipation {
    id: string;
    charId: string;
    content: string;
    status: AnticipationStatus;
    createdAt: number;
    anchoredAt: number | null;
    resolvedAt: number | null;
}

// ─── 处理批次日志 ─────────────────────────────────────

export interface MemoryBatch {
    id: string;
    charId: string;
    boxId: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    nodesCreated: number;
    error: string | null;
    createdAt: number;
    completedAt: number | null;
}

// ─── 人格风格 ─────────────────────────────────────────

export type PersonalityStyle = 'emotional' | 'narrative' | 'imagery' | 'analytical';

export const PERSONALITY_WEIGHTS: Record<PersonalityStyle, Record<LinkType, number>> = {
    emotional:  { emotional: 1.0, person: 0.6, metaphor: 0.5, temporal: 0.3, causal: 0.2 },
    narrative:  { temporal: 1.0, person: 0.8, causal: 0.4, emotional: 0.3, metaphor: 0.2 },
    imagery:    { metaphor: 1.0, emotional: 0.5, temporal: 0.3, person: 0.3, causal: 0.2 },
    analytical: { causal: 1.0, temporal: 0.4, person: 0.3, emotional: 0.2, metaphor: 0.2 },
};

// ─── Embedding 配置（独立于聊天 API） ─────────────────

export interface EmbeddingConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
}

export interface RemoteVectorConfig {
    enabled: boolean;
    supabaseUrl: string;
    supabaseAnonKey: string;
    initialized: boolean;
}

// ─── LLM 配置（抽取/关联/门牌等本地调用） ─────────────
//
// 与聊天 API 共用服务商；仅在需要 LLM 参与的子系统（links 深层关联、
// extraction 抽取、roomPlates 整理）里传入。

export interface LightLLMConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 水位线配置（写入管线触发阈值） ───────────────────

export type MemoryPalaceWaterlinePreset = 'online' | 'balanced' | 'offline' | 'custom';

export interface MemoryPalaceWaterlineConfig {
    preset: MemoryPalaceWaterlinePreset;
    hotZoneSize?: number;
    bufferThreshold?: number;
}

// ─── 检索结果 ─────────────────────────────────────────

export interface ScoredMemory {
    node: MemoryNode;
    finalScore: number;
    similarity: number;
    bm25Score: number;
    roomScore: number;
    recallGuarantee?: 'explicit_entity';
}
