"use client";

/**
 * 记忆宫殿（Memory Palace）—— 七房间视图
 *
 * 这是「记忆库」的新界面：把引擎里七个脑区房间的记忆摊开给人看。
 * 数据全部来自 momo_memory_palace_v1（引擎自有库），不再读老的
 * ai_phone_memory_db_v1；老页面 components/memory/memory-bank-page.tsx 原样保留，
 * phone-resources-app 里用一个常量决定走哪个视图，随时可回退。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
    Archive, BedDouble, BookOpen, Brain, ChevronLeft, Download, Home,
    RefreshCw, Sparkles, Sun, User, Users, type LucideIcon,
} from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    MemoryNodeDB, RoomPlateDB, ROOM_CONFIGS, ROOM_LABELS,
    PLATE_ROOMS, PLATE_TITLES, runConsolidation, calculateEffectiveImportance,
} from "@/lib/memory-palace";
import type { MemoryNode, MemoryRoom, RoomPlate } from "@/lib/memory-palace";
import { migrateLegacyMemoriesForCharacter } from "@/lib/memory-palace/momo-bridge";

type PalaceView =
    | { kind: "rooms" }
    | { kind: "room"; room: MemoryRoom }
    | { kind: "plates" };

const ROOM_ORDER: MemoryRoom[] = [
    "living_room", "bedroom", "study", "user_room", "self_room", "attic", "windowsill",
];

const ROOM_ICONS: Record<MemoryRoom, LucideIcon> = {
    living_room: Home,
    bedroom: BedDouble,
    study: BookOpen,
    user_room: Users,
    self_room: User,
    attic: Archive,
    windowsill: Sun,
};

/** 房间色调，沿用主题的图标色板，保证浅色/深色主题都协调。 */
const ROOM_TONES: Record<MemoryRoom, string> = {
    living_room: "var(--c-icon-amber)",
    bedroom: "var(--c-icon-rose)",
    study: "var(--c-icon-blue)",
    user_room: "var(--c-icon-green)",
    self_room: "var(--c-icon-violet)",
    attic: "var(--c-icon-slate)",
    windowsill: "var(--c-icon-teal)",
};

const ROOM_HINTS: Record<MemoryRoom, string> = {
    living_room: "日常闲聊、近期互动",
    bedroom: "亲密情感、深层羁绊",
    study: "工作学习、技能成长",
    user_room: "关于你的信息与习惯",
    self_room: "角色自我认同、演变",
    attic: "未消化的困惑、潜意识",
    windowsill: "期盼、目标、憧憬",
};

function formatRelative(ts: number): string {
    if (!Number.isFinite(ts)) return "—";
    const diff = Date.now() - ts;
    if (diff < 0) return "刚刚";
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(ts).toLocaleDateString("zh-CN");
}

function truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** 情绪温度：把 valence/arousal 映射成一句人话，方便扫视。 */
function moodLabel(node: MemoryNode): string | null {
    const v = node.valence;
    if (typeof v !== "number") return node.mood && node.mood !== "平静" ? node.mood : null;
    if (v >= 0.4) return "愉快";
    if (v <= -0.4) return "低落";
    return node.mood && node.mood !== "平静" ? node.mood : "平稳";
}

export function MemoryPalacePage({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string>("");
    const [nodes, setNodes] = useState<MemoryNode[]>([]);
    const [plates, setPlates] = useState<RoomPlate[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<"" | "migrate" | "consolidate">("");
    const [progress, setProgress] = useState<string>("");
    const [view, setView] = useState<PalaceView>({ kind: "rooms" });

    // 角色列表只在客户端读（localStorage / IndexedDB）
    useEffect(() => {
        const list = loadCharacters();
        setCharacters(list);
        setActiveCharId(prev => prev || (list[0]?.id ?? ""));
    }, []);

    const reload = useCallback(async (charId: string) => {
        if (!charId) {
            setNodes([]);
            setPlates([]);
            return;
        }
        setLoading(true);
        try {
            const [loadedNodes, loadedPlates] = await Promise.all([
                MemoryNodeDB.getByCharId(charId),
                RoomPlateDB.getByCharId(charId),
            ]);
            setNodes(loadedNodes);
            setPlates(loadedPlates);
        } catch (error) {
            console.warn("[MemoryPalace] 读取房间数据失败", error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload(activeCharId);
    }, [activeCharId, reload]);

    const stats = useMemo(() => {
        const live = nodes.filter(node => !node.archived);
        const byRoom = new Map<MemoryRoom, MemoryNode[]>();
        for (const room of ROOM_ORDER) byRoom.set(room, []);
        for (const node of live) {
            const bucket = byRoom.get(node.room);
            if (bucket) bucket.push(node);
            else byRoom.get("living_room")?.push(node);
        }
        // 每个房间按"有效重要度"（含遗忘衰减）排序，越靠前越是这个房间还记着的事
        for (const [, bucket] of byRoom) {
            bucket.sort((a, b) => calculateEffectiveImportance(b, Date.now()) - calculateEffectiveImportance(a, Date.now()));
        }
        return {
            total: live.length,
            embedded: live.filter(node => node.embedded).length,
            archived: nodes.filter(node => node.archived).length,
            byRoom,
        };
    }, [nodes]);

    const activeChar = useMemo(
        () => characters.find(char => char.id === activeCharId) ?? null,
        [characters, activeCharId],
    );

    const handleMigrate = useCallback(async () => {
        if (!activeCharId || busy) return;
        setBusy("migrate");
        setProgress("");
        try {
            const result = await migrateLegacyMemoriesForCharacter(activeCharId, (done, total) => {
                setProgress(`${done}/${total}`);
            });
            if (result.total === 0) {
                onNotice?.("这个角色还没有可导入的旧记忆");
            } else if (result.embedded === 0) {
                onNotice?.(`导入了 ${result.stored} 条，但没有生成向量——请先在设置里配好 Embedding API`);
            } else {
                onNotice?.(`导入完成：${result.stored} 条，其中 ${result.embedded} 条已建立向量索引`);
            }
            await reload(activeCharId);
        } catch (error) {
            console.warn("[MemoryPalace] 导入失败", error);
            onNotice?.("导入失败，详情见控制台");
        } finally {
            setBusy("");
            setProgress("");
        }
    }, [activeCharId, busy, onNotice, reload]);

    const handleConsolidate = useCallback(async () => {
        if (!activeCharId || busy) return;
        setBusy("consolidate");
        try {
            const result = await runConsolidation(activeCharId);
            onNotice?.(
                result.promoted.length === 0 && result.evicted.length === 0
                    ? "巩固完成：暂时没有需要晋升或沉底的记忆"
                    : `巩固完成：${result.promoted.length} 条晋升到卧室，${result.evicted.length} 条沉入阁楼`,
            );
            await reload(activeCharId);
        } catch (error) {
            console.warn("[MemoryPalace] 巩固失败", error);
            onNotice?.("巩固失败，详情见控制台");
        } finally {
            setBusy("");
        }
    }, [activeCharId, busy, onNotice, reload]);

    const cardStyle: CSSProperties = {
        background: "var(--c-card)",
        border: "1px solid var(--c-card-border)",
        borderRadius: 14,
        padding: "14px 14px",
    };

    const chipStyle: CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        color: "var(--c-text)",
        background: "var(--c-input)",
    };

    const toolButtonStyle: CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 12px",
        borderRadius: 999,
        fontSize: 12,
        color: "var(--c-text-title)",
        background: "var(--c-card)",
        border: "1px solid var(--c-card-border)",
        opacity: busy ? 0.5 : 1,
    };

    // ── 空状态：一个房间都没有 ──────────────────────
    if (!loading && stats.total === 0 && view.kind === "rooms") {
        return (
            <div style={{ padding: "16px 16px 32px" }}>
                {characters.length > 1 ? (
                    <CharacterStrip
                        characters={characters}
                        activeCharId={activeCharId}
                        onSelect={setActiveCharId}
                    />
                ) : null}
                <div style={{ ...cardStyle, marginTop: 14, textAlign: "center", padding: "36px 20px" }}>
                    <Brain size={34} strokeWidth={1.3} style={{ color: "var(--c-icon)", margin: "0 auto 12px" }} />
                    <p style={{ color: "var(--c-text-title)", fontSize: 15, fontWeight: 500 }}>
                        这个角色的记忆宫殿还是空的
                    </p>
                    <p style={{ color: "var(--c-text)", fontSize: 13, marginTop: 8, lineHeight: 1.7 }}>
                        正常聊天几次就会自动搬进来。<br />
                        也可以现在手动把已有的记忆一次性导进来。
                    </p>
                    <button
                        type="button"
                        onClick={() => void handleMigrate()}
                        disabled={busy !== ""}
                        style={{
                            marginTop: 18,
                            padding: "10px 20px",
                            borderRadius: 999,
                            fontSize: 13,
                            color: "#fff",
                            background: "var(--c-action-blue, #4A90D9)",
                            opacity: busy ? 0.6 : 1,
                        }}
                    >
                        {busy === "migrate" ? `正在导入 ${progress}` : "立即导入已有记忆"}
                    </button>
                </div>
            </div>
        );
    }

    // ── 单个房间详情 ───────────────────────────────
    if (view.kind === "room") {
        const room = view.room;
        const bucket = stats.byRoom.get(room) ?? [];
        const Icon = ROOM_ICONS[room];
        const config = ROOM_CONFIGS[room];
        return (
            <div style={{ padding: "12px 16px 32px" }}>
                <button
                    type="button"
                    onClick={() => setView({ kind: "rooms" })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--c-text)" }}
                >
                    <ChevronLeft size={16} strokeWidth={1.8} />
                    所有房间
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                    <span style={{
                        width: 34, height: 34, borderRadius: 10,
                        display: "grid", placeItems: "center",
                        background: ROOM_TONES[room],
                    }}>
                        <Icon size={18} strokeWidth={1.6} style={{ color: "#fff" }} />
                    </span>
                    <div>
                        <p style={{ fontSize: 16, fontWeight: 600, color: "var(--c-text-title)" }}>{ROOM_LABELS[room]}</p>
                        <p style={{ fontSize: 12, color: "var(--c-text)" }}>
                            {bucket.length} 条{config.capacity === null ? " · 不限容量" : ` / 容量 ${config.capacity}`}
                        </p>
                    </div>
                </div>

                {bucket.length === 0 ? (
                    <p style={{ ...cardStyle, marginTop: 16, textAlign: "center", color: "var(--c-text)", fontSize: 13 }}>
                        这个房间还空着。
                    </p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
                        {bucket.map(node => {
                            const mood = moodLabel(node);
                            return (
                                <div key={node.id} style={cardStyle}>
                                    <p style={{ fontSize: 13.5, lineHeight: 1.7, color: "var(--c-text-title)" }}>
                                        {node.content}
                                    </p>
                                    <div style={{
                                        display: "flex", flexWrap: "wrap", gap: 6,
                                        marginTop: 10, alignItems: "center",
                                    }}>
                                        <span style={chipStyle}>重要度 {calculateEffectiveImportance(node, Date.now()).toFixed(1)}</span>
                                        <span style={chipStyle}>想起 {node.accessCount} 次</span>
                                        {mood ? <span style={chipStyle}>{mood}</span> : null}
                                        <span style={{ ...chipStyle, background: "transparent", color: "var(--c-icon)" }}>
                                            {formatRelative(node.createdAt)}
                                        </span>
                                        {!node.embedded ? (
                                            <span style={{ ...chipStyle, color: "var(--c-warning)" }}>未建索引</span>
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    // ── 门牌视图 ───────────────────────────────────
    if (view.kind === "plates") {
        return (
            <div style={{ padding: "12px 16px 32px" }}>
                <button
                    type="button"
                    onClick={() => setView({ kind: "rooms" })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--c-text)" }}
                >
                    <ChevronLeft size={16} strokeWidth={1.8} />
                    所有房间
                </button>
                <p style={{ fontSize: 12, color: "var(--c-text)", marginTop: 10, lineHeight: 1.7 }}>
                    门牌是房间里沉淀下来的稳定认知——不随遗忘衰减，是角色真正"记住"的东西。
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
                    {PLATE_ROOMS.map(room => {
                        const plate = plates.find(item => item.room === room);
                        const entries = plate?.entries ?? [];
                        return (
                            <div key={room} style={cardStyle}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                    <p style={{ fontSize: 14, fontWeight: 600, color: "var(--c-text-title)" }}>
                                        {PLATE_TITLES[room]}
                                    </p>
                                    <span style={{ fontSize: 11, color: "var(--c-icon)" }}>{entries.length} 条</span>
                                </div>
                                {entries.length === 0 ? (
                                    <p style={{ fontSize: 12, color: "var(--c-icon)", marginTop: 8 }}>
                                        还没沉淀出门牌内容。
                                    </p>
                                ) : (
                                    <ul style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                                        {entries.map(entry => (
                                            <li key={entry.id} style={{
                                                fontSize: 12.5, lineHeight: 1.7, color: "var(--c-text)",
                                                paddingLeft: 10, borderLeft: "2px solid var(--c-card-border)",
                                            }}>
                                                {entry.text}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // ── 七房间总览 ─────────────────────────────────
    return (
        <div style={{ padding: "12px 16px 32px" }}>
            {characters.length > 1 ? (
                <CharacterStrip
                    characters={characters}
                    activeCharId={activeCharId}
                    onSelect={setActiveCharId}
                />
            ) : null}

            <div style={{
                display: "flex", alignItems: "baseline", justifyContent: "space-between",
                marginTop: characters.length > 1 ? 16 : 4,
            }}>
                <div>
                    <span style={{ fontSize: 22, fontWeight: 600, color: "var(--c-text-title)" }}>{stats.total}</span>
                    <span style={{ fontSize: 12, color: "var(--c-text)", marginLeft: 6 }}>条记忆</span>
                </div>
                <span style={{ fontSize: 11.5, color: "var(--c-icon)" }}>
                    已索引 {stats.embedded}
                    {stats.archived > 0 ? ` · 归档 ${stats.archived}` : ""}
                </span>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" onClick={() => void handleConsolidate()} disabled={busy !== ""} style={toolButtonStyle}>
                    <RefreshCw size={13} strokeWidth={1.8} />
                    {busy === "consolidate" ? "巩固中…" : "整理房间"}
                </button>
                <button type="button" onClick={() => void handleMigrate()} disabled={busy !== ""} style={toolButtonStyle}>
                    <Download size={13} strokeWidth={1.8} />
                    {busy === "migrate" ? `导入 ${progress}` : "导入旧记忆"}
                </button>
                <button type="button" onClick={() => setView({ kind: "plates" })} style={toolButtonStyle}>
                    <BookOpen size={13} strokeWidth={1.8} />
                    门牌
                </button>
            </div>

            <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr",
                gap: 10, marginTop: 16,
            }}>
                {ROOM_ORDER.map(room => {
                    const bucket = stats.byRoom.get(room) ?? [];
                    const Icon = ROOM_ICONS[room];
                    const config = ROOM_CONFIGS[room];
                    const head = bucket[0];
                    const fill = config.capacity === null
                        ? Math.min(bucket.length / 60, 1)
                        : Math.min(bucket.length / config.capacity, 1);
                    return (
                        <button
                            key={room}
                            type="button"
                            onClick={() => setView({ kind: "room", room })}
                            style={{ ...cardStyle, textAlign: "left", gridColumn: undefined }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{
                                    width: 26, height: 26, borderRadius: 8,
                                    display: "grid", placeItems: "center",
                                    background: ROOM_TONES[room],
                                }}>
                                    <Icon size={14} strokeWidth={1.7} style={{ color: "#fff" }} />
                                </span>
                                <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-text-title)" }}>
                                    {ROOM_LABELS[room]}
                                </span>
                                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--c-text)" }}>
                                    {bucket.length}
                                </span>
                            </div>

                            <p style={{ fontSize: 11, color: "var(--c-icon)", marginTop: 8, lineHeight: 1.5 }}>
                                {head ? truncate(head.content, 26) : ROOM_HINTS[room]}
                            </p>

                            <div style={{
                                height: 3, borderRadius: 2, marginTop: 10,
                                background: "var(--c-card-border)", overflow: "hidden",
                            }}>
                                <div style={{
                                    width: `${Math.max(fill * 100, bucket.length > 0 ? 6 : 0)}%`,
                                    height: "100%",
                                    background: ROOM_TONES[room],
                                }} />
                            </div>
                        </button>
                    );
                })}
            </div>

            <p style={{ fontSize: 11, color: "var(--c-icon)", marginTop: 16, lineHeight: 1.8 }}>
                客厅满 200 条后，最不重要的会沉进阁楼；被反复想起或重要度够高的会晋升到卧室。
                这条遗忘曲线就是"仿脑"的地方——不是所有事都会被记住。
            </p>
        </div>
    );
}

/** 多角色时的横向角色切换条。 */
function CharacterStrip({
    characters,
    activeCharId,
    onSelect,
}: {
    characters: Character[];
    activeCharId: string;
    onSelect: (charId: string) => void;
}) {
    return (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {characters.map(char => {
                const active = char.id === activeCharId;
                return (
                    <button
                        key={char.id}
                        type="button"
                        onClick={() => onSelect(char.id)}
                        style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            padding: "5px 12px 5px 6px", borderRadius: 999,
                            fontSize: 12.5, whiteSpace: "nowrap",
                            color: active ? "var(--c-text-title)" : "var(--c-text)",
                            background: active ? "var(--c-card)" : "transparent",
                            border: `1px solid ${active ? "var(--c-card-border)" : "transparent"}`,
                        }}
                    >
                        {char.avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={char.avatar}
                                alt={char.name}
                                style={{ width: 22, height: 22, borderRadius: 999, objectFit: "cover" }}
                            />
                        ) : (
                            <span style={{
                                width: 22, height: 22, borderRadius: 999,
                                display: "grid", placeItems: "center",
                                background: "var(--c-input)",
                            }}>
                                <Sparkles size={11} strokeWidth={1.8} style={{ color: "var(--c-icon)" }} />
                            </span>
                        )}
                        {char.name}
                    </button>
                );
            })}
        </div>
    );
}
