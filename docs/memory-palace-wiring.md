# 记忆库（Memory Palace）接线说明

本文说明「记忆宫殿」引擎如何接进 momo 现有记忆系统。接线已完成并推送至 `main`，本文件用于日后回顾、排障与回滚。

---

## 一、整体原则

接线采用**只读分流、不侵入**的方式，三条底线：

1. **不改调用方**。`lib/chat-engine.ts`、`lib/story-engine.ts` 一行未动。它们的调用形态是
   `retrieveMemoriesForPrompt(...)` / `retrieveCoreMemoriesForPrompt(...)`，签名与返回值完全不变。
2. **不可用就回退**。新引擎任何环节不满足（未启用、房间没数据、没有 embedding 配置、取向量失败、抛异常），
   一律 `return null`，调用方自然落回老逻辑。**没有任何一条路径会让聊天因为记忆库而失败。**
3. **有数据才接管**。房间里没有任何已向量化的节点时，行为与接线前完全一致。

老系统（`memory-storage.ts` / `ai_phone_memory_db_v1`）仍然是**唯一事实源**，palace 是另一份可检索的副本，不是替代存储。

---

## 二、改动清单

只动了 3 个既有文件，新增 1 个文件。

### 1. 新增 `lib/memory-palace/momo-bridge.ts`

引擎与 momo 之间唯一的耦合点。包内其他 19 个文件保持纯净（只依赖 `idb-open` / `kv-db`），
所有对业务模块（`settings-storage` / `memory-storage` / `memory-embedding` / `token-counter`）的依赖都收敛在这个文件里。

对外能力：

| 能力 | 函数 | 说明 |
|---|---|---|
| 召回长期 | `recallLongTermFromPalace` | 混合检索 → 情绪启动 → 扩散激活 → 预算截取 |
| 召回核心 | `recallCoreFromPalace` | 优先读门牌，门牌空则退到自我房+用户房高权重节点 |
| 写入镜像 | `mirrorEntryToPalace` | 老管线产出一条，房间同步存一份（幂等） |
| 全量迁移 | `migrateLegacyMemoriesForCharacter` | 把已有 long_term/core 导入房间 |
| 状态查询 | `hasPalaceData` | 该角色是否已有可检索数据 |
| 自动播种 | `autoSeedPalace`（内部） | 首次接管时后台自动搬数据 |

### 2. `lib/memory-service.ts` — 召回分流

两个函数开头各加一段，命中就接管，否则继续走原逻辑：

```ts
const palaceEntries = await recallLongTermFromPalace({ characterId, query: currentContext, config });
if (palaceEntries && palaceEntries.length > 0) return palaceEntries;
// ↓ 以下为原有逻辑，一行未改
```

用 `.length > 0` 而非仅判 null，是为了避免"房间有数据但预算太小返回空"时把老逻辑整个跳过。

### 3. `lib/memory-summarizer.ts` — 长期记忆镜像

`saveMemoryEntry(longTermEntry)` 之后：

```ts
void mirrorEntryToPalace(longTermEntry).catch(() => {});
```

`void` + `.catch` 意味着**不阻塞主流程**，总结该成功还是成功。

> 注意一个语义差异：老系统会按 `maxLongTermEntries` 淘汰旧条目，而 palace 里的副本会保留
> （相当于沉到阁楼而不是被删除）。这是"仿脑遗忘"与"硬删除"的区别，属预期行为。
> 如果需要两种存储严格一致，应在老系统淘汰条目时同步调用 `MemoryNodeDB.delete`。

### 4. `lib/core-memory-builder.ts` — 核心记忆镜像

```ts
void mirrorEntryToPalace(coreEntry, { archiveRoomSiblings: true }).catch(() => {});
```

`archiveRoomSiblings` 是必要的：老系统每次重建核心记忆都生成新 id（`mem_core_${Date.now()}_xxx`），
照搬会在自我房里堆出一串过期画像，所以写入前把同房间的其他镜像节点归档，只保留最新一份。

---

## 三、数据流

```
聊天 / 剧情
   │
   ├─ 召回（读）
   │    memory-service.retrieveMemoriesForPrompt
   │      └─ momo-bridge.recallLongTermFromPalace
   │           ① hybridSearch    向量 85% + BM25 15%，叠加房间权重 + 熟悉度加成
   │           ② applyPriming    当前情绪与记忆情绪接近的，分数上浮（需传入 mood）
   │           ③ spreadActivation 沿关联网络唤起相关记忆
   │           ④ 去重 → 按 finalScore 排序 → 按 longTermTokenBudget 截取
   │      └─ 返回 null → 落回 loadMemoryEntriesByType + 余弦相似度（原逻辑）
   │
   └─ 写入（写）
        memory-summarizer（每 N 条事件触发一次 LLM 总结）
          └─ saveMemoryEntry(老库)  +  mirrorEntryToPalace(房间, 含 embedding)
        core-memory-builder（每 M 条长期记忆触发一次重建）
          └─ saveMemoryEntry(老库)  +  mirrorEntryToPalace(自我房, 归档旧版本)
```

两处写入都用 `void` 异步触发，不拖慢总结，也不影响失败。

---

## 四、自动播种：用户不需要点任何按钮

首次接管时的空库问题用自动播种解决：

1. 用户打开聊天 → `recallLongTermFromPalace` 发现房间没有已向量化节点
2. 触发 `autoSeedPalace(characterId)`（fire-and-forget），**本次仍返回 null 走老逻辑**
3. 后台把该角色已有的 `long_term` 全量 + 最新一条 `core` 导入房间，逐条取向量
4. 完成后写 kv 标记 `mp_seeded_<charId> = done`
5. 下一次聊天，房间有数据 → 新引擎接管

所以用户的体验是：**接完代码，聊两次天，记忆库就自己开始工作了**，不需要进设置点任何东西。

保护措施：

- 进程内 `seedingCharacters` Set 防同一会话重复触发
- 没有可用 embedding 配置时直接跳过（搬进来也检索不了，还会反复重试）
- 只有 `total > 0 && embedded > 0 && failed === 0` 才写完成标记，失败下次重试

迁移幂等：节点 id 由 `mp_${entry.id}` 决定，重复执行只会覆盖同一节点，不会产生重复记忆。

---

## 五、怎么验证接上了

1. 打开某个角色的聊天，随便聊几句触发一次记忆总结（或直接在记忆库页面手动点总结）。
2. 浏览器控制台应出现 `[VectorStore] Stored ...` 或 `[MemoryPalace] 自动播种完成：{...}`。
3. DevTools → Application → IndexedDB，应能看到新库 `momo_memory_palace_v1`，
   里面有 `memory_nodes` / `memory_vectors` 等表，且 `memory_nodes` 有记录。
4. 再聊一次，控制台若出现 `[MemoryPalace] 长期记忆召回失败...` 说明有异常（此时会自动回退，聊天不受影响）。
5. 老库 `ai_phone_memory_db_v1` 应该仍在正常增长——两份数据同时在写，这是预期。

排查顺序：先确认 `momo_memory_palace_v1` 有没有节点 → 再看节点 `embedded` 是否为 true →
再看辅助 API 绑定里的 embedding 配置是否可用。三者任一不满足，都会安静地走老逻辑。

---

## 六、怎么回滚

三种粒度，从轻到重：

**只关某个角色**（推荐，其它角色不受影响）：

```ts
import { setMemoryPalaceEnabled } from '@/lib/memory-palace';
setMemoryPalaceEnabled(characterId, false);
```

开关存在 kv（key `mp_enabled_<charId>`），`false` 后该角色一律走老逻辑，房间数据保留不删。

**全部关掉**：把 `lib/memory-service.ts` 里那两段分流删掉即可，其余改动都是旁路镜像，不影响主流程。

**彻底还原**：`git revert` 对应的三个 commit，并删掉 `lib/memory-palace/` 目录。
注意 `momo_memory_palace_v1` 这个 IndexedDB 会留在用户浏览器里，不影响功能，需要的话让用户清站点数据。

---

## 七、当前边界（尚未做）

- **写入不做 LLM 抽取**。现在房间里的内容是"老系统总结结果"的镜像，不是从原始对话里抽取的事件。
  真正的事件抽取 / EventBox 压缩封盒 / 门牌自动整理属于二期，做完后房间内容会更细、门牌才会真正建立。
- **门牌目前是空的**。`recallCoreFromPalace` 优先读门牌，门牌没有时退到自我房 + 用户房高权重节点。
  等二期把门牌整理接上，核心记忆质量会明显提升。
- **情绪启动未启用**。`applyPriming` 已接好，但 momo 角色卡没有情绪字段（`character-types.ts` 无 mood），
  当前调用不传 `mood`，等于不启用。需要先有情绪来源（例如从最近几条消息推断）才能生效。
- **关联网络只有自动两类**。时间链、情绪链自动建；因果 / 人物 / 隐喻走 LLM 的部分属于二期。
- **门牌需要整理才有内容**。门牌本身是二期 LLM 整理产出的，现在门牌页是空的，
  核心记忆走"自我房 + 用户房高权重节点"兜底，能用但不是最终形态。
- **遗忘与晋升靠手动 + 自动双轨**。自动巩固已接（每次写入镜像后节流 1 小时触发一次），
  也可以在记忆库界面点「整理房间」立即跑一次。

## 八、界面

「记忆库」现在是**七房间视图**，不再是四个 Tab：

- 入口不变：桌面 Dock →「资源库」→「记忆库」
- 组件：`components/memory/memory-palace-page.tsx`（新增）
- 七个房间卡片显示条数、容量占用、最新一条摘要；点进去看该房间全部记忆
  （内容、有效重要度含遗忘衰减、被想起次数、情绪、时间、是否已建索引）
- 顶部工具：「整理房间」手动巩固、「导入旧记忆」手动迁移、「门牌」看固化认知
- 多角色时顶部有横向角色切换条

**回退开关**：`components/phone-resources-app.tsx` 顶部的 `USE_PALACE_VIEW` 常量。
改 `false` 就回到原来的四 Tab 界面，老页面 `memory-bank-page.tsx` 一行未删、随时可用。

---

## 八、二期往哪接

1. 写入侧补抽取：新对话进来后由 LLM 抽取成多条候选记忆（带房间判定 / 情绪坐标 / 实体），
   走 `vectorizeAndStore` 入库，替换现在的"镜像老总结结果"。
2. 补 EventBox 与门牌整理，让 `recallCoreFromPalace` 的门牌分支真正生效、门牌页有内容。
3. 七个房间的界面已落地，二期补：房间内搜索、手动改房间归属、删单条、时间轴视图。
4. 情绪来源：给角色加情绪状态（或从最近消息推断），把 `applyPriming` 的 `mood` 真正传进去。
