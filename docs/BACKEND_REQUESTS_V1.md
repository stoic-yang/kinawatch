# Backend Requests From the Frontend Owner (v1)

交接对象：Codex（后端 owner）。
提出方：Fable（前端 owner）。
日期：2026-07-16。

前端第一迭代（`frontend/`，产品名「一天一页」）已经基于现有
`/api/day` 与 `/api/range` 完成。本文档列出前端**无法**在客户端完成、
需要后端补充的能力，按优先级排序。每项都先给出要回答的用户问题，
再给出数据/行为需求，遵循 `docs/FABLE_DATA_HANDOFF.md` 的
Backend Extension Rule。

## 前端已在客户端自行计算的内容（后端不需要做）

避免重复建设，以下均由前端从现有 `/api/day` 响应派生：

- 「一天的章节」：把 `timeline` 中间隔超过 15 分钟的屏幕块切成
  会话，并与离线活动按时间交织；
- 单日 Top 应用：从 `timeline` 的 `app` 字段聚合；
- 节律带（24h 时间轴）：直接渲染 `timeline` 块；
- 未分类时间在单日内的应用去向：从 `timeline` 中
  `category == "uncategorized"` 的块聚合。

现有 timeline 粒度（相邻同 app/title/category 合并）对以上用途足够，
暂不需要原始事件流。

## P0 — 静态托管 dist/（日常使用不依赖 Node）

**用户问题**：我想每天打开 `http://127.0.0.1:8765` 就能看到面板，
不想先启动一个 Node dev server。

**需求**：

1. `backend.server` 在现有 `/api/*` 之外，把仓库根的 `dist/`
   作为静态文件根提供：
   - `GET /` → `dist/index.html`；
   - `GET /assets/...` → `dist/assets/...`；
   - 未知的非 `/api` 路径返回 `dist/index.html`（前端是单页应用，
     目前无路由，兜底即可）或 404，二选一，请在实现里注明。
2. `dist/` 缺失时 `/` 返回一段说明文字（提示先运行
   `npm run build --prefix frontend`），API 不受影响。
3. 继续只绑定 `127.0.0.1`；同源之后不需要任何 CORS 头。
4. 静态响应加 `Cache-Control: no-cache` 或基于 mtime 的
   `Last-Modified` 均可，避免改版后浏览器拿旧资源即可。
5. 不引入新依赖、不加文件 watcher，保持空闲退出行为不变。

**验收**：

- 后端单独运行时，浏览器访问 `http://127.0.0.1:8765/` 能完整使用面板；
- `python3 -m unittest discover -s tests` 全绿；
- 空闲 CPU 行为与 Gate 1 一致。

## P1 — /api/range 增加每日节律摘要（周视角复盘）

**用户问题**：这一周我的作息节律怎么漂移的？每天几点开始活动、
几点收工？哪天熬夜了？

现在 `RangeDay` 只有总量，前端周条只能画"每天总时长"。要画
"七天节律小图"（每天一条 24h 迷你带或起止区间），需要每日的
时间分布，而 range 端点故意不返回 timeline——这是合理的，
所以请求一个压缩摘要。

**需求**：`RangeDay` 增加可选字段：

```ts
rhythm?: {
  first_active: string | null;   // 当日第一个屏幕/离线块的开始时刻（ISO）
  last_active: string | null;    // 当日最后一个块的结束时刻（ISO）
  hourly_active_seconds: number[]; // 长度 24，按 mode 的当日边界对齐，
                                   // 每小时内的活跃秒数（screen+offline 去重叠）
}
```

- 语义沿用现有 `combined_nonoverlap_seconds` 的口径；
- 可以从已有的日缓存派生，不需要新缓存层；
- 字段可选：老缓存条目没有该字段时返回 `null`/缺省即可，
  前端会降级为现在的总量周条。

**验收**：`/api/range` 响应体积仍然紧凑（每天多 ~100 字节），
单元测试覆盖跨午夜（routine mode）对齐。

## P2 — 范围级"未分类去向" （分类规则维护入口）

**用户问题**：最近一周未分类时间主要是哪些应用？我该往 Kina
分类规则里补什么？

单日的未分类去向前端已能算；跨天需要后端聚合（range 不含 timeline）。

**需求**：`/api/range` 增加可选查询参数 `include=uncategorized_apps`，
返回每天或整段 Top N（N=5 足够）未分类应用及秒数。实现方式
（逐日字段或整段汇总）由后端定。

优先级低：v1 前端未使用；做 P1 时顺手评估即可。

## P2 — 浏览器域名维度（产品决策，暂不实现）

**用户问题**：泛读/浏览的几小时到底去了哪些网站？

窗口标题不可靠，真正做需要 aw-watcher-web 浏览器插件的数据源接入，
这是 Kina 侧的数据源决策，不是本仓库单方面能加的。此处仅登记，
等用户明确要这个回答再评估。

## 非请求：已确认够用的现状

- `mode=routine` 的 06:00 边界：前端已支持切换，够用；
- `refresh=1`：前端"刷新此日"按钮已使用；
- 空 `projects`、缺日记、AW 不可用等状态：前端均已处理，
  不需要后端造默认值。
