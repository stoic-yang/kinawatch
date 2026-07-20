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
- calendar 从 00:00 对齐，routine 从配置的 06:00 对齐；
- `first_active` / `last_active` 使用 ActivityWatch 配置时区；
- 摘要随日响应进入原有日缓存，range 不新增缓存层；
- `day_schema_version` 已提升到 2，旧日缓存会自然失效并重建。

日响应也携带同一可选 `rhythm` 字段，方便以后单日界面直接使用；当前
前端无需改用它。

## 已完成：P2 范围级未分类应用

请求：

```http
GET /api/range?start=2026-07-09&end=2026-07-15&include=uncategorized_apps
```

响应顶层增加整段 Top 5：

```ts
uncategorized_apps?: Array<{
  app: string;
  duration_seconds: number;
}>
```

这里选择整段汇总，不在每天重复字段。未传 `include` 时不计算、不返回。
未知的 `include` 值返回 400，避免调用方误以为能力已经生效。

## 明确未实现

- 浏览器域名数据没有实现；它仍需要 ActivityWatch 数据源层面的
  `aw-watcher-web` 产品决策。
- 后端没有规定 Fable 必须把 rhythm 做成周节律图，也没有新增分类规则
  编辑、月视图或搜索功能。

## 后续追加：受限日记写入

项目在用户确认后由完全只读调整为以读取为主。工作流描述接口是：

```http
PUT /api/journal/workflow
Content-Type: application/json
```

请求必须包含所选日期、会话起止时间、非空描述，以及最近一次
`GET /api/day` 返回的 `cache.journal_fingerprint`。后端从实时配置推导目标日记，
只允许创建或替换对应开始时间的条目，并将所选日记中所有已识别工作流描述合并为
一个折叠式「工作流」Callout；它不会接受客户端提供的文件路径，
也不会修改复盘、自由正文或其他工作流块。

其中 `journal_fingerprint.mtime_ns` 是需要原样回传的十进制字符串，不是
JavaScript `number`；纳秒时间戳超过安全整数范围，转换为数字会损失精度并被
正确地视为版本冲突。该契约从 `day_schema_version = 4` 起生效，旧缓存会失效重建。

写入使用文件指纹冲突检查、单笔记锁、同目录临时文件与原子替换。目标歧义、
空内容、旧指纹、符号链接或越过当前 journal provider 存储根目录的路径均会
被拒绝。保存成功后只失效所选日期缓存，前端随即重读当日数据。完整请求类型与
响应类型见 `docs/fable-api-types.ts`。

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

周复盘入口使用：

```http
PUT /api/journal/weekly
Content-Type: application/json
```

请求只包含 `week_id`。一个有效 ISO 周始终映射到固定的
`Review/Weekly/YYYY-Www.md`：缺失时原子创建模板，存在时不改写任何字节，
两种情况都返回 provider 与稳定路径。Obsidian provider 还会返回同一个
`obsidian://open` URI；local provider 的 `open_url` / `obsidian_url` 为空。
前端不得使用 `obsidian://new` 重复创建同名文件。

## 验证入口

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m scripts.gate1
npm run build --prefix frontend
```

新增测试覆盖 routine 跨午夜对齐、屏幕/离线去重、空日、静态首页与资源、
SPA fallback、缺失 dist 时 API 可用，以及范围级未分类应用聚合。
