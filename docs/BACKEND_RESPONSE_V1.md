# Backend Response to Fable Requests (v1)

交接对象：Fable（前端 owner）。  
实现方：Codex（后端 owner）。  
日期：2026-07-17。

本文回应 `docs/BACKEND_REQUESTS_V1.md`。前端的信息架构、视觉和功能取舍
仍由 Fable 决定；这里仅说明已经可以依赖的运行行为与数据能力。

## 已完成：P0 静态托管

- `python3 -m backend.server` 同时提供 `dist/` 与 `/api/*`。
- `GET /` 返回 `dist/index.html`。
- `GET /assets/...` 返回构建资源；缺失资源返回 404。
- 未知的非 API 路径采用 SPA fallback，返回 `dist/index.html`。
- `dist/index.html` 缺失时，页面返回 503 与
  `npm run build --prefix frontend` 提示；API 不受影响。
- 静态响应使用 `Cache-Control: no-cache`，不发送 CORS 头。
- 服务仍只允许绑定 `127.0.0.1` / `localhost`，没有 watcher 或常驻 Node。

## 已完成：P1 每日节律摘要

`GET /api/range` 的每个 day 现在可返回：

```ts
rhythm?: {
  first_active: string | null;
  last_active: string | null;
  hourly_active_seconds: number[]; // 固定 24 项
}
```

语义：

- 使用屏幕活动与日记离线活动的时间并集，不重复计算重叠；
- calendar 从 00:00 对齐，routine 从 `routine_day_start` 对齐；
- `first_active` / `last_active` 使用 ActivityWatch 配置时区；
- 摘要随日响应进入原有日缓存，range 不新增缓存层；
- 该能力最初把 `day_schema_version` 提升到 2；当前契约版本为 9，旧日缓存
  会自然失效并重建。

## 前台媒体补时

当 `activitywatch.media_activity.enabled` 开启时，后端可用显式规则识别
ActivityWatch 已捕获的前台播放窗口。匹配事件即使落在 AFK 区间，也会保留在
timeline 和 `overview.active_seconds` 中；普通静置、暂停播放、后台窗口与锁屏仍按
原 AFK 规则过滤。`quality.time_accounting` 新增：

- `interactive_wall_seconds`：键鼠活跃的屏幕时间并集；
- `foreground_media_wall_seconds`：匹配的前台媒体时间并集；
- `passive_media_seconds`：仅由媒体规则补回的非交互时间；
- `afk_removed_before_media_seconds`：补时前原本会移除的时长；
- `afk_removed_seconds`：补时后仍被移除的时长。

总屏幕时间按事件并集计算，交互与媒体重叠不会重复累计。该能力不读取或修改
ActivityWatch 数据库，也不改变 AFK bucket；契约升级到 `day_schema_version = 9`，
历史缓存会按需重建。

日响应也携带同一可选 `rhythm` 字段，方便以后单日界面直接使用；当前
前端无需改用它。

## 已完成：范围级主要应用与未分类应用

请求：

```http
GET /api/range?start=2026-07-09&end=2026-07-15&include=top_apps
GET /api/range?start=2026-07-09&end=2026-07-15&include=uncategorized_apps
```

响应顶层可按需增加整段 Top 6 主要应用和 Top 5 未分类应用：

```ts
top_apps?: Array<{
  app: string;
  duration_seconds: number;
  category: string;
}>

uncategorized_apps?: Array<{
  app: string;
  duration_seconds: number;
}>
```

这里选择整段汇总，不在每天重复字段。`top_apps.category` 是该应用在周期内
累计时长最长的分类，供侧栏复用日视图色点。聚合直接复用本次 range 已加载的
日级 timeline，不额外读取 ActivityWatch。未传 `include` 时不计算、不返回；
两个值可用逗号同时请求。未知的 `include` 值返回 400，避免调用方误以为能力
已经生效。

## 明确未实现

- 浏览器域名数据没有实现；它仍需要 ActivityWatch 数据源层面的
  `aw-watcher-web` 产品决策。
- 后端没有规定 Fable 必须把 rhythm 做成周节律图，也没有新增分类规则
  编辑、月视图或搜索功能。

## 后续追加：时间线手动校正

日响应中每个 screen block 现在包含 `event_refs`、`manual_edit` 和
`manual_edit_conflict`。相邻事件仍可合并展示，但前端不再把显示块本身当成
写入目标，而是按需检查其关联的原始 ActivityWatch 事件：

```http
GET /api/activity/inspect?date=YYYY-MM-DD&mode=routine&bucket_id=...&event_id=...
PUT /api/activity/edit
PUT /api/activity/undo
```

检查响应返回原始值、当前有效值、自动分类、手动分类、是否已经结束、是否可编辑、
源事件指纹与活动校正层 revision。一个显示块含多条原始事件时，前端必须让用户
选择具体事件。保存请求可修改开始/结束时间、应用、标题和分类；分类覆盖可选择
已有分类，也可提交 `custom_label` 创建 KinaWatch-only 分类。传
`category_override: null` 表示继续跟随自动规则。

两个 `PUT` 端点仅在 `activity_edit_enabled: true` 时可用，并同时校验
`expected_source_fingerprint` 与 `expected_revision`。源事件、校正层或目标日
发生变化时返回 409，不静默覆盖。只允许编辑已结束且仍位于所选日范围内的事件；
不能创建新的 ActivityWatch 事件。

修改写入平台用户数据目录中的 KinaWatch 原子 JSON overlay，并在聚合与分类之前
应用。ActivityWatch REST API、bucket 和数据库仍完全只读。成功保存只失效目标
日期缓存，响应带 `change_id`，可在没有后续冲突时由 `/api/activity/undo`
撤销。该契约将 `day_schema_version` 提升到 8。

## 后续追加：受限日记写入

项目在用户确认后由完全只读调整为以读取为主。工作流描述接口是：

```http
PUT /api/journal/workflow
Content-Type: application/json
```

请求必须包含所选日期、会话起止时间、字符串 `note`，以及最近一次
`GET /api/day` 返回的 `cache.journal_fingerprint`。后端从实时配置推导目标日记，
只允许创建或替换对应开始时间的条目，并将所选日记中所有已识别工作流描述合并为
一个折叠式「工作流」Callout；它不会接受客户端提供的文件路径，
也不会修改复盘、自由正文或其他工作流块。

其中 `journal_fingerprint.mtime_ns` 是需要原样回传的十进制字符串，不是
JavaScript `number`；纳秒时间戳超过安全整数范围，转换为数字会损失精度并被
正确地视为版本冲突。该契约从 `day_schema_version = 4` 起生效，旧缓存会失效重建。

写入使用文件指纹冲突检查、单笔记锁、同目录临时文件与原子替换。目标歧义、
缺失或非字符串的 `note`、旧指纹、符号链接或越过当前 journal provider 存储根目录的路径均会
被拒绝。保存成功后只失效所选日期缓存，前端随即重读当日数据。完整请求类型与
响应类型见 `docs/fable-api-types.ts`。

显式保存 `note: ""`（包括仅含空白的文字）会清空所选描述。保留该条目的时间与
内部标记，接口返回 `workflow_note.note: ""`，刷新后仍作为用户已清空的记录，
不会重新显示对应的 Kina 总结。生成总结原文与其他条目内容保持不变。
此解析语义从 `journal_schema_version = 3`、`day_schema_version = 10` 起生效。

日复盘的四个用户字段使用：

```http
PUT /api/journal/review
Content-Type: application/json
```

请求字段为 `date`、`field`、`markdown` 与页面读取时的
`expected_fingerprint`。`field` 只允许 `personal_summary`、`outputs`、
`next_action`、`freeform`。后端把非空字段统一序列化为一个默认收起的「复盘」Callout，
新写入将 `next_action` 显示为「明天的计划」，并只在用户显式保存时归并所选
日记中已识别的旧总结、产出、「明日第一步」和「自由记录」小节。旧日记中
未归入这些字段的正文、Kina 生成内容、离线活动、属性、工作流与其他日期均
保持只读。旧 `完成复盘` 勾选只为历史兼容而静默忽略，不再作为 API 状态或
新日记模板。冲突检查、原子替换和缓存失效规则与工作流接口相同。

常驻笔记使用一个与日期无关的固定文件：

```http
GET /api/journal/permanent
PUT /api/journal/permanent
Content-Type: application/json
```

路径只从 `journal.permanent_note_path` 读取，默认是当前 provider 存储根下的
`incoming.md`；客户端不能提交路径。GET 返回完整 Markdown、provider、稳定路径、
Obsidian 打开链接、写入开关与文件指纹，并且不会创建文件。PUT 只接受非空
`markdown` 与 `expected_fingerprint`，在显式保存时整体替换这一个
KinaWatch 管理的文件。内容最多 50000 字符，可以自由使用 H1/H2、列表和 Markdown
待办；路径逃逸、符号链接、旧指纹和并发变化都会被拒绝。

周/月复盘读取分别使用：

```http
GET /api/journal/weekly?week_id=YYYY-Www
GET /api/journal/monthly?month_id=YYYY-MM
```

读取不会创建文件，返回单个 `自由记录` 栏目的 Markdown、当前文件指纹、provider、
稳定路径与写入开关。保存分别使用：

```http
PUT /api/journal/weekly
PUT /api/journal/monthly
Content-Type: application/json
```

请求包含对应的 `week_id` 或 `month_id`、`field`、非空 `markdown` 与读取时的
`expected_fingerprint`。`field` 只允许 `freeform`，映射到 `自由记录`。
有效周期始终映射到固定的 `Review/Weekly/YYYY-Www.md` 或
`Review/Monthly/YYYY-MM.md`；缺失时首次显式保存才原子创建模板，存在时只
替换目标 H2 的正文。frontmatter、既有旧栏目、未知小节和其他内容保持原样。旧的
`PUT {week_id}` create-if-absent 请求仍兼容，但网页编辑器不依赖它。
Obsidian provider 始终返回同一个 `obsidian://open` URI；local provider 的
`open_url` / `obsidian_url` 为空。两种读取响应都包含统一的 `period_id`，
并保留各自的 `week_id` / `month_id`。前端不得使用 `obsidian://new`。

## 后续追加：人生信念

`GET /api/journal/beliefs` 与 `PUT /api/journal/beliefs` 访问与日期无关的同一文件。
路径仅来自配置 `journal.beliefs_note_path`，默认是所选 provider 根目录中的
`Review/我的人生信念.md`，必须为相对 Markdown 路径。GET 不创建文件；返回
`markdown`、`has_frontmatter`、`exists`、`provider`、`path`、`open_url`、
`obsidian_url`、`write_enabled` 和 `journal_fingerprint`。

PUT 只接受 `markdown` 与 `expected_fingerprint`，拒绝客户端路径和日期。
允许空正文，JSON 请求上限 16 MiB。只有 `journal_write_enabled: true` 时才可
保存；使用每文件锁、精确版本检查、路径约束及原子替换，保留原有 YAML 与 BOM。
冲突返回 409，客户端保留草稿并供用户核对版本；不影响日期缓存或其他笔记。
信念编辑器在用户输入暂停约 700ms 后自动保存，串行提交并保留保存期间的新输入；
失败或冲突时保留本机草稿并暂停自动写入，重新读取文件后再重试或由用户选择版本。
读取不会创建笔记，也不自动整理来源笔记。

## 验证入口

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m scripts.gate1
npm run build --prefix frontend
```

测试覆盖 routine 跨午夜对齐、屏幕/离线去重、空日、静态首页与资源、
SPA fallback、缺失 dist 时 API 可用、范围级主要应用和未分类应用聚合、
常驻笔记的首次创建/原子替换/冲突拒绝，以及活动校正的原子保存/撤销、
源事件冲突、按日缓存失效和路由权限。
