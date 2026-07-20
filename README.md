# KinaWatch

KinaWatch 是一个低能耗、本地优先的个人活动复盘面板：把 ActivityWatch 的
客观活动记录与 Obsidian 日记中的总结、产出、计划和离线活动放在同一天里查看。

> Early open-source release. The interface and documentation are currently
> Chinese-first.

KinaWatch 是独立项目，不是 ActivityWatch 的 fork，也不打包或修改
ActivityWatch。它通过本机只读 REST API 获取事件，并保持自己的 MIT 许可证。

## Highlights

- 一天一页：统一浏览屏幕活动、离线活动、工作流说明和日复盘。
- 通过 ActivityWatch REST API 自动发现本机窗口与 AFK buckets。
- 保留 AFK 过滤、分类覆盖率、缺失来源和时间核算等质量信息。
- 分类规则是普通 JSON，可按应用、标题、URL、项目和文件等字段定制。
- Python 标准库后端同源托管静态 React 前端，不需要常驻 Node 服务。
- 按日期缓存；当天短 TTL，历史日期在输入指纹未变化时长期复用。
- 只监听 `127.0.0.1` / `localhost`，无宽泛 CORS、WebSocket 或后台扫描。
- 默认只读。显式启用后，仅允许受保护地更新一个工作流描述或一个复盘字段。

## Architecture

```text
ActivityWatch local REST API ─┐
                              ├─ KinaWatch Python service ─ React UI
Obsidian Markdown vault ──────┘          │
                                   local day cache
```

ActivityWatch 继续负责采集窗口和 AFK 状态；Obsidian 继续作为文字与反思的唯一
事实源。KinaWatch 只做按需读取、AFK 时段相交、分类、聚合、缓存和展示。详细契约
见 [Integration contract](docs/INTEGRATION.md)。

## Requirements

- Python 3.11+
- Node.js 20+（仅前端开发或重新构建时需要）
- 已安装并正在运行的 [ActivityWatch](https://activitywatch.net/)
- 一个 Obsidian vault

后端运行时仅使用 Python 标准库。当前真实环境验证使用 ActivityWatch `v0.13.2`；
ActivityWatch REST API 尚未冻结，因此升级后请先运行测试与 Gate 1。

## Quick start

```sh
git clone https://github.com/stoic-yang/kinawatch.git
cd kinawatch
cp config/kinawatch.example.json config/kinawatch.local.json
```

编辑 `config/kinawatch.local.json`：

1. 将 `journal.vault` 改为你的 Obsidian vault。
2. 按需调整 `journal.daily_notes_dir` 和 `journal.vault_name`。
3. 确认 `activitywatch.timezone`；`local` 会尝试读取系统时区。
4. 一般无需填写 bucket ID；存在多个设备 bucket 时再显式设置。
5. 先保持 `journal_write_enabled: false`。

构建前端并启动服务：

```sh
npm ci --prefix frontend
npm run build --prefix frontend
python3 -m backend.server --check
python3 -m backend.server
```

打开 <http://127.0.0.1:8765/>。服务默认在 15 分钟没有 HTTP 请求后退出。

### Configuration precedence

配置按以下顺序解析：

1. `python3 -m backend.server --config /absolute/path/config.json`
2. `KINAWATCH_CONFIG=/absolute/path/config.json`
3. Git 忽略的 `config/kinawatch.local.json`
4. 兼容旧版的 `KINA_DASHBOARD_CONFIG` 或 `config/dashboard.local.json`
5. 只读、安全的 `config/kinawatch.example.json`

旧版 Kina Activity Dashboard 的 `upstream` 配置仍可作为迁移输入：KinaWatch 会
读取其中的 ActivityWatch、分类和 Obsidian JSON，但不会再导入 Kina Python
脚本，也不会直接读取 ActivityWatch SQLite。迁移方式见
[Integration contract](docs/INTEGRATION.md#migrating-from-v1-kina-integration)。

### Categories

公开默认规则位于 `config/categories.example.json`。推荐复制为一个 Git 忽略或
仓库外的个人文件，再修改 `activitywatch.categories_file`。规则按顺序匹配，支持：

- `<field>_equals`
- `<field>_contains`
- `<field>_regex`

其中 `<field>` 可以是 `app`、`title`、`url`、`project`、`file`、`language`
或 `status`。

## Development

前端开发服务器会把 `/api` 代理到 `127.0.0.1:8765`：

```sh
python3 -m backend.server
npm run dev --prefix frontend
```

开发地址为 <http://localhost:5183/>。生产构建写入 `dist/`，由 Python 后端
直接托管。

## Verify

无需真实 ActivityWatch 或 Obsidian 数据的隔离测试：

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build --prefix frontend
```

连接真实本地环境后，可运行只读集成门禁：

```sh
python3 -m scripts.gate1
```

Gate 1 只读取历史日记与 ActivityWatch 数据，不应拿真实日记执行写入测试。
历史验证说明见 [Gate 1](docs/GATE1.md)。

## API

- `GET /api/health`
- `GET /api/day?date=YYYY-MM-DD&mode=routine`
- `GET /api/range?start=YYYY-MM-DD&end=YYYY-MM-DD`
- `PUT /api/journal/workflow`
- `PUT /api/journal/review`
- `PUT /api/journal/weekly`

三个 `PUT` 端点只有在 `journal_write_enabled: true` 时可用。日记写入使用文件
指纹、单笔记锁、同目录临时文件和原子替换；发生版本冲突时拒绝覆盖。完整响应
契约见 [Backend response](docs/BACKEND_RESPONSE_V1.md)。

## Safety boundaries

- 服务和 ActivityWatch 连接都限制在 loopback 地址。
- 不修改 ActivityWatch，不复制或迁移其 SQLite 数据库。
- 不持续扫描 vault，不自动保存，不批量迁移日记。
- 写入白名单仅包含所选日期的一条工作流描述，或 `我的总结`、`今日产出`、
  `明天的计划` 中的一项。
- 完成任务、自由正文、Kina 生成内容、离线活动、properties 和其他日期均只读。
- 所有写入测试只使用临时 fixture。

更详细的安全说明见 [SECURITY.md](SECURITY.md)。

## Project layout

```text
backend/      Python API、ActivityWatch REST 适配、缓存、解析与受限写入
frontend/     React + TypeScript + Vite 前端
dist/         已构建的静态前端
config/       安全公开模板；本机配置由 Git 忽略
tests/        单元测试与合成日记 fixture
scripts/      真实环境的只读 Gate 1
docs/         API、数据契约、设计与能耗说明
```

## Contributing and license

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。KinaWatch 使用
[MIT License](LICENSE)。ActivityWatch 不随本项目分发；项目关系和第三方声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
