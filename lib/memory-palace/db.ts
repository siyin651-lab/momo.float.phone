/**
 * Memory Palace — IndexedDB CRUD 操作（momo 适配版）
 *
 * 与 SullyOS 版的区别：
 *  - 自建独立数据库 `momo_memory_palace_v1`（不污染 momo 现有记忆库 /
 *    ai_phone_memory_db_v1），迁移期两者可并存。
 *  - 复用 momo 的 `openIndexedDbAtLeast`（lib/idb-open.ts）打开数据库，
 *    兼容备份还原后版本号被抬高导致 VersionError 的情况。
 *  - 去掉 SullyOS 的 satellite 依赖：bm25Index / nodeChanges（改为轻量事件
 *    总线）/ linkPrecision（内联 compactMemoryLink）/ supabaseVector（一期不做
 *    跨设备同步）/ backupFormat（导出另立模块）。
 *  - 配置类（远程向量开关等）一期用不到，统一走 momo 的 kv-db 即可，本文件不碰。
 */

import { openIndexedDbAtLeast } from '../idb-open';
import type {
    MemoryNode, MemoryVector, MemoryLink, MemoryBatch,
    Anticipation, MemoryRoom,
    EventBox, RoomPlate, PlateRoom, DigestReport,
} from './types';
import { DIGEST_REPORT_KEEP, EVENT_BOX_SEAL_THRESHOLD } from './types';

// ─── Store 名称常量 ────────────────────────────────────

export const STORE_MEMORY_NODES   = 'memory_nodes';
export const STORE_MEMORY_VECTORS = 'memory_vectors';
export const STORE_MEMORY_LINKS   = 'memory_links';
export const STORE_MEMORY_BATCHES = 'memory_batches';
export const STORE_ANTICIPATIONS  = 'anticipations';
export const STORE_EVENT_BOXES    = 'event_boxes';
export const STORE_ROOM_PLATES    = 'room_plates';
export const STORE_DIGEST_REPORTS = 'digest_reports';

const DB_NAME = 'momo_memory_palace_v1';
const DB_VERSION = 1;

// ─── 打开数据库 ───────────────────────────────────────

export function openDB(): Promise<IDBDatabase> {
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, _tx) => {
        if (!db.objectStoreNames.contains(STORE_MEMORY_NODES)) {
            const nodes = db.createObjectStore(STORE_MEMORY_NODES, { keyPath: 'id' });
            nodes.createIndex('charId', 'charId', { unique: false });
            nodes.createIndex('eventBoxId', 'eventBoxId', { unique: false });
            nodes.createIndex('boxId', 'boxId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEMORY_VECTORS)) {
            const vectors = db.createObjectStore(STORE_MEMORY_VECTORS, { keyPath: 'memoryId' });
            vectors.createIndex('charId', 'charId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEMORY_LINKS)) {
            const links = db.createObjectStore(STORE_MEMORY_LINKS, { keyPath: 'id' });
            links.createIndex('sourceId', 'sourceId', { unique: false });
            links.createIndex('targetId', 'targetId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEMORY_BATCHES)) {
            const batches = db.createObjectStore(STORE_MEMORY_BATCHES, { keyPath: 'id' });
            batches.createIndex('charId', 'charId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ANTICIPATIONS)) {
            const ants = db.createObjectStore(STORE_ANTICIPATIONS, { keyPath: 'id' });
            ants.createIndex('charId', 'charId', { unique: false });
            ants.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_EVENT_BOXES)) {
            const boxes = db.createObjectStore(STORE_EVENT_BOXES, { keyPath: 'id' });
            boxes.createIndex('charId', 'charId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ROOM_PLATES)) {
            const plates = db.createObjectStore(STORE_ROOM_PLATES, { keyPath: 'id' });
            plates.createIndex('charId', 'charId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DIGEST_REPORTS)) {
            const reports = db.createObjectStore(STORE_DIGEST_REPORTS, { keyPath: 'id' });
            reports.createIndex('charId', 'charId', { unique: false });
        }
    });
}

// ─── 轻量事件总线（替代 SullyOS 的 nodeChanges） ───────

export const MP_NODES_CHANGED_EVENT = 'mp-nodes-changed';

function notifyMemoryNodesChanged(charId?: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(MP_NODES_CHANGED_EVENT, { detail: { charId } }));
    } catch { /* 非浏览器环境忽略 */ }
}

// ─── 通用辅助 ──────────────────────────────────────────

async function getAllByIndex<T>(
    storeName: string, indexName: string, value: IDBValidKey
): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.getAll(IDBKeyRange.only(value));
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
    });
}

async function put<T>(storeName: string, data: T): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(data);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getByKey<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
    });
}

async function deleteByKey(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getAll<T>(storeName: string): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
    });
}

// ─── Float32Array ↔ Uint8Array 存储转换 ──────────────

export function ensureFloat32(vec: number[] | Float32Array | Uint8Array): Float32Array {
    if (vec instanceof Float32Array) return vec;
    if (vec instanceof Uint8Array) {
        return new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
    }
    return new Float32Array(vec);
}

function vecForStorage(vec: number[] | Float32Array | Uint8Array): Uint8Array {
    if (vec instanceof Uint8Array) return vec;
    const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
    return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function isLegacyVec(vec: unknown): boolean {
    return Array.isArray(vec);
}

// ─── MemoryNode CRUD ──────────────────────────────────

export const MemoryNodeDB = {
    saveVectorizedMany: async (entries: { node: MemoryNode; vector: MemoryVector }[]): Promise<void> => {
        if (!entries.length) return;
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction([STORE_MEMORY_NODES, STORE_MEMORY_VECTORS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('记忆和向量保存已回滚'));
            try {
                for (const { node, vector } of entries) {
                    tx.objectStore(STORE_MEMORY_NODES).put(node);
                    tx.objectStore(STORE_MEMORY_VECTORS).put({ ...vector, vector: vecForStorage(vector.vector) });
                }
            } catch (error) { tx.abort(); reject(error); }
        });
        for (const charId of new Set(entries.map(e => e.node.charId))) notifyMemoryNodesChanged(charId);
    },

    save: async (node: MemoryNode) => {
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
        const verify = await getByKey<MemoryNode>(STORE_MEMORY_NODES, node.id);
        if (!verify) {
            console.error(`❌ [MemoryNodeDB] WRITE VERIFICATION FAILED for ${node.id}`);
            throw new Error(`Memory node write failed: ${node.id}`);
        }
        notifyMemoryNodesChanged(node.charId);
    },

    getById: (id: string) => getByKey<MemoryNode>(STORE_MEMORY_NODES, id),

    delete: async (id: string) => {
        await deleteByKey(STORE_MEMORY_NODES, id);
        notifyMemoryNodesChanged();
    },

    getByCharId: (charId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId),

    getByRoom: (charId: string, room: MemoryRoom): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => n.room === room)),

    getUnembedded: (charId: string): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => !n.embedded)),

    getByEventBoxId: (eventBoxId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'eventBoxId', eventBoxId),

    saveMany: async (nodes: MemoryNode[]): Promise<void> => {
        if (nodes.length === 0) return;
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_NODES, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_NODES);
            for (const node of nodes) store.put(node);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        for (const charId of new Set(nodes.map(n => n.charId))) notifyMemoryNodesChanged(charId);
    },

    touchAccess: async (id: string): Promise<void> => {
        const node = await getByKey<MemoryNode>(STORE_MEMORY_NODES, id);
        if (!node) return;
        node.lastAccessedAt = Date.now();
        node.accessCount += 1;
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
    },
};

// ─── MemoryVector CRUD ────────────────────────────────

export const MemoryVectorDB = {
    save: async (vec: MemoryVector) => {
        const stored = { ...vec, vector: vecForStorage(vec.vector) };
        await put<MemoryVector>(STORE_MEMORY_VECTORS, stored);
        const verify = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, vec.memoryId);
        if (!verify) {
            console.error(`❌ [MemoryVectorDB] WRITE VERIFICATION FAILED for ${vec.memoryId}`);
            throw new Error(`Memory vector write failed: ${vec.memoryId}`);
        }
    },

    getByMemoryId: async (memoryId: string): Promise<MemoryVector | undefined> => {
        const v = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, memoryId);
        if (!v) return undefined;
        return { ...v, vector: ensureFloat32(v.vector) };
    },

    delete: (memoryId: string) => deleteByKey(STORE_MEMORY_VECTORS, memoryId),

    getAllByCharId: async (charId: string): Promise<MemoryVector[]> => {
        const migrateLegacyByCharId = (cid: string): void => {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const idx = store.index('charId');
                    const req = idx.openCursor(IDBKeyRange.only(cid));
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) return;
                        const v = cursor.value;
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                        }
                        cursor.continue();
                    };
                } catch (e) {
                    console.warn('[MemoryVectorDB] cursor migration failed', e);
                }
            })();
        };

        try {
            const indexed = await getAllByIndex<MemoryVector>(STORE_MEMORY_VECTORS, 'charId', charId);
            if (indexed.length > 0) {
                if (indexed.some(v => isLegacyVec(v.vector))) migrateLegacyByCharId(charId);
                return indexed.map(v => ({ ...v, vector: ensureFloat32(v.vector) }));
            }
        } catch {
            // 索引不存在（旧版本 DB），走兼容路径
        }

        const nodes = await getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId);
        const embeddedIds = new Set(nodes.filter(n => n.embedded).map(n => n.id));
        if (embeddedIds.size === 0) return [];

        const allVectors = await getAll<MemoryVector>(STORE_MEMORY_VECTORS);
        const matched = allVectors.filter(v => embeddedIds.has(v.memoryId));
        if (matched.length > 0) {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    for (const m of matched) {
                        const req = store.openCursor(IDBKeyRange.only(m.memoryId));
                        req.onsuccess = () => {
                            const cursor = req.result;
                            if (!cursor) return;
                            const cur = cursor.value;
                            const needsCharId = !cur.charId;
                            const needsMigration = isLegacyVec(cur.vector);
                            if (needsCharId || needsMigration) {
                                cursor.update({
                                    ...cur,
                                    charId: cur.charId || charId,
                                    vector: vecForStorage(cur.vector),
                                });
                            }
                        };
                    }
                } catch (e) {
                    console.warn('[MemoryVectorDB] charId backfill failed', e);
                }
            })();
        }
        return matched.map(v => ({ ...v, charId, vector: ensureFloat32(v.vector) }));
    },

    saveMany: async (vectors: MemoryVector[]): Promise<void> => {
        if (vectors.length === 0) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_VECTORS);
            for (const vec of vectors) store.put({ ...vec, vector: vecForStorage(vec.vector) });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    scanAndMigrateLegacy: async (
        onProgress?: (migrated: number, scanned: number) => void,
    ): Promise<number> => {
        const BATCH_SIZE = 500;
        let migrated = 0;
        let scanned = 0;
        let lastKey: IDBValidKey | null = null;
        let done = false;

        while (!done) {
            const batch = await new Promise<{
                migrated: number; scanned: number; lastKey: IDBValidKey | null; done: boolean;
            }>(async (resolve, reject) => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const range = lastKey !== null ? IDBKeyRange.lowerBound(lastKey, true) : undefined;
                    const req = store.openCursor(range);
                    let bMig = 0, bScan = 0;
                    let bLast: IDBValidKey | null = lastKey;
                    let bDone = false;

                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) { bDone = true; return; }
                        if (bScan >= BATCH_SIZE) return;
                        const v = cursor.value;
                        bScan++;
                        bLast = cursor.primaryKey;
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                            bMig++;
                        }
                        cursor.continue();
                    };
                    req.onerror = () => reject(req.error);
                    tx.oncomplete = () => resolve({ migrated: bMig, scanned: bScan, lastKey: bLast, done: bDone });
                    tx.onerror = () => reject(tx.error);
                } catch (e) { reject(e); }
            });

            migrated += batch.migrated;
            scanned += batch.scanned;
            lastKey = batch.lastKey;
            done = batch.done;
            if (onProgress) onProgress(migrated, scanned);
            if (!done) await new Promise(r => setTimeout(r, 50));
        }
        return migrated;
    },
};

// ─── MemoryLink CRUD ──────────────────────────────────

/** 内联 linkPrecision：幂等的 strength 取整（保留 2 位小数） */
function compactMemoryLink(link: MemoryLink): MemoryLink {
    const s = Math.round(link.strength * 100) / 100;
    return s === link.strength ? link : { ...link, strength: s };
}

export const MemoryLinkDB = {
    save: (link: MemoryLink) => put<MemoryLink>(STORE_MEMORY_LINKS, compactMemoryLink(link)),

    delete: (id: string) => deleteByKey(STORE_MEMORY_LINKS, id),

    getBySourceId: (sourceId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', sourceId),

    getByTargetId: (targetId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', targetId),

    getByNodeId: async (nodeId: string): Promise<MemoryLink[]> => {
        const [asSource, asTarget] = await Promise.all([
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', nodeId),
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', nodeId),
        ]);
        const seen = new Set<string>();
        const result: MemoryLink[] = [];
        for (const link of [...asSource, ...asTarget]) {
            if (!seen.has(link.id)) {
                seen.add(link.id);
                result.push(link);
            }
        }
        return result;
    },

    saveMany: async (links: MemoryLink[]): Promise<void> => {
        if (links.length === 0) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_LINKS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_LINKS);
            for (const link of links) store.put(compactMemoryLink(link));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    compactStrengths: async (onProgress?: (changed: number, scanned: number) => void): Promise<number> => {
        let lastKey: IDBValidKey | undefined;
        let changed = 0;
        for (;;) {
            const db = await openDB();
            const batch = await new Promise<{ count: number; changed: number; lastKey?: IDBValidKey }>((resolve, reject) => {
                const tx = db.transaction(STORE_MEMORY_LINKS, 'readwrite');
                const req = tx.objectStore(STORE_MEMORY_LINKS).openCursor(
                    lastKey === undefined ? undefined : IDBKeyRange.lowerBound(lastKey, true),
                );
                let count = 0;
                let updated = 0;
                let key = lastKey;
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) return;
                    const original = cursor.value;
                    const compacted = compactMemoryLink(original);
                    if (compacted !== original) { cursor.update(compacted); updated++; }
                    key = cursor.primaryKey;
                    if (++count < 500) cursor.continue();
                };
                tx.oncomplete = () => resolve({ count, changed: updated, lastKey: key });
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('记忆连接整理未完成'));
            });
            changed += batch.changed;
            lastKey = batch.lastKey;
            onProgress?.(changed, batch.count);
            if (batch.count < 500) return changed;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    },
};

// ─── MemoryBatch CRUD ─────────────────────────────────

export const MemoryBatchDB = {
    save: (batch: MemoryBatch) => put<MemoryBatch>(STORE_MEMORY_BATCHES, batch),
    getByCharId: (charId: string) =>
        getAllByIndex<MemoryBatch>(STORE_MEMORY_BATCHES, 'charId', charId),
};

// ─── Anticipation CRUD ────────────────────────────────

export const AnticipationDB = {
    save: (ant: Anticipation) => put<Anticipation>(STORE_ANTICIPATIONS, ant),
    getById: (id: string) => getByKey<Anticipation>(STORE_ANTICIPATIONS, id),
    delete: (id: string) => deleteByKey(STORE_ANTICIPATIONS, id),
    getByCharId: (charId: string) =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId),
    getByStatus: (charId: string, status: Anticipation['status']): Promise<Anticipation[]> =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId)
            .then(ants => ants.filter(a => a.status === status)),
    getActive: (charId: string) => AnticipationDB.getByStatus(charId, 'active'),
};

// ─── EventBox CRUD ────────────────────────────────────

export const EventBoxDB = {
    save: (box: EventBox) => put<EventBox>(STORE_EVENT_BOXES, box),
    getById: (id: string) => getByKey<EventBox>(STORE_EVENT_BOXES, id),
    delete: (id: string) => deleteByKey(STORE_EVENT_BOXES, id),
    getByCharId: (charId: string) =>
        getAllByIndex<EventBox>(STORE_EVENT_BOXES, 'charId', charId),
    saveMany: async (boxes: EventBox[]): Promise<void> => {
        if (boxes.length === 0) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_EVENT_BOXES, 'readwrite');
            const store = tx.objectStore(STORE_EVENT_BOXES);
            for (const box of boxes) store.put(box);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};

// ─── RoomPlate CRUD（房间门牌） ───────────────────────

export function plateId(charId: string, room: PlateRoom): string {
    return `${charId}:${room}`;
}

export const RoomPlateDB = {
    save: (plate: RoomPlate) => put<RoomPlate>(STORE_ROOM_PLATES, plate),
    get: (charId: string, room: PlateRoom) =>
        getByKey<RoomPlate>(STORE_ROOM_PLATES, plateId(charId, room)),
    getByCharId: (charId: string) =>
        getAllByIndex<RoomPlate>(STORE_ROOM_PLATES, 'charId', charId),
    delete: (charId: string, room: PlateRoom) =>
        deleteByKey(STORE_ROOM_PLATES, plateId(charId, room)),
};

/** 门牌被后台改写过的窗口事件（detail: { charId, rooms }）。 */
export const ROOM_PLATES_UPDATED_EVENT = 'room-plates-updated';

export async function loadOrCreatePlate(charId: string, room: PlateRoom): Promise<RoomPlate> {
    const existing = await RoomPlateDB.get(charId, room);
    if (existing) return existing;
    return {
        id: plateId(charId, room),
        charId,
        room,
        entries: [],
        updatedAt: Date.now(),
        version: 0,
    };
}

/** 改一块门牌：现读 → 改 → 整块存回，同一块门牌排队串行，避免并发覆盖。 */
const plateWriteQueues = new Map<string, Promise<unknown>>();

export async function mutatePlate(
    charId: string,
    room: PlateRoom,
    change: (plate: RoomPlate) => RoomPlate | null,
): Promise<RoomPlate | null> {
    const key = plateId(charId, room);
    const run = async (): Promise<RoomPlate | null> => {
        const fresh = await loadOrCreatePlate(charId, room);
        const next = change(fresh);
        if (!next) return null;
        await RoomPlateDB.save(next);
        if (typeof window !== 'undefined') {
            try {
                window.dispatchEvent(new CustomEvent(ROOM_PLATES_UPDATED_EVENT, {
                    detail: { charId, rooms: [room] },
                }));
            } catch { /* ignore */ }
        }
        return next;
    };
    const write = (plateWriteQueues.get(key) ?? Promise.resolve()).then(run, run);
    plateWriteQueues.set(key, write.catch(() => {}));
    return write;
}

// ─── DigestReport CRUD ────────────────────────────────

export const DigestReportDB = {
    save: async (report: DigestReport): Promise<void> => {
        await put<DigestReport>(STORE_DIGEST_REPORTS, report);
        try {
            const all = await getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', report.charId);
            if (all.length > DIGEST_REPORT_KEEP) {
                const overflow = all
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(DIGEST_REPORT_KEEP);
                for (const old of overflow) await deleteByKey(STORE_DIGEST_REPORTS, old.id);
            }
        } catch { /* 修剪失败不影响本条保存 */ }
    },

    getByCharId: (charId: string): Promise<DigestReport[]> =>
        getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', charId)
            .then(list => list.sort((a, b) => b.createdAt - a.createdAt)),

    delete: (id: string) => deleteByKey(STORE_DIGEST_REPORTS, id),
};

/** 仅供迁移/清理：删除某角色的全部记忆宫殿数据（含向量/链接/门牌/盒）。 */
export async function wipeAllMemoryPalace(charId?: string): Promise<void> {
    const db = await openDB();
    const stores = [
        STORE_MEMORY_NODES, STORE_MEMORY_VECTORS, STORE_MEMORY_LINKS,
        STORE_MEMORY_BATCHES, STORE_ANTICIPATIONS, STORE_EVENT_BOXES,
        STORE_ROOM_PLATES, STORE_DIGEST_REPORTS,
    ];
    await Promise.all(stores.map(store => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = charId
            ? tx.objectStore(store).index('charId').openKeyCursor(IDBKeyRange.only(charId))
            : tx.objectStore(store).clear();
        if (charId) {
            const c = req as IDBRequest;
            (c as any).onsuccess = () => {
                const cursor = (req as IDBRequest).result;
                if (!cursor) return;
                tx.objectStore(store).delete(cursor.primaryKey);
                cursor.continue();
            };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    })));
    notifyMemoryNodesChanged(charId);
}
