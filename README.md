# Kina Activity Dashboard

一个低能耗、本地优先的个人活动复盘面板：把 ActivityWatch 的客观活动记录与
Obsidian 日记中的总结、产出、计划和离线活动放在同一天里查看。

> Early open-source release. The interface and documentation are currently
> Chinese-first.

## Highlights

- 一天一页：统一浏览屏幕活动、离线活动、工作流说明和日复盘。
- 保留 ActivityWatch 的 AFK 过滤、来源归因、分类覆盖率和数据质量信息。
- Python 标准库后端同源托管静态 React 前端，不需要常驻 Node 服务。
- 按日期缓存；当天短 TTL，历史日期在输入指纹未变化时长期复用。
- 只监听 `127.0.0.1` / `localhost`，无宽泛 CORS、WebSocket 或后台扫描。
- 默认只读。显式启用后，仅允许受保护地更新一个工作流描述或一个复盘字段。

## Current integration boundary

Dashboard 目前不是一个独立的 ActivityWatch 统计实现。它复用本地
Kina-compatible workspace 中的 ActivityWatch 查询、AFK 过滤、分类和来源归因
函数，以避免形成第二套统计口径。

因此，首次运行需要准备：

- 正在本机运行的 ActivityWatch；
- 一个 Obsidian vault；
- 一个提供 `activitywatch_report.py` 与对应 JSON 配置的兼容上游目录。

具体接口见 [Integration contract](docs/INTEGRATION.md)。未来可以在不改变 API
语义的前提下增加独立适配器。

## Requirements

- Python 3.11+
- Node.js 20+（仅前端开发或重新构建时需要）
- ActivityWatch 本地服务
- Obsidian vault
- 上述 Kina-compatible integration

后端运行时仅使用 Python 标准库。

## Quick start

```sh
git clone https://github.com/stoic-yang/kina-activity-dashboard.git
cd kina-activity-dashboard
cp config/dashboard.example.json config/dashboard.local.json
```

编辑 `config/dashboard.local.json`，把 `upstream` 中的路径改为当前机器的真实
路径。公开模板把 `journal_write_enabled` 设为 `false`；建议先保持只读，完成
健康检查和 fixture 测试后再决定是否开启写入。

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
2. `KINA_DASHBOARD_CONFIG=/absolute/path/config.json`
3. Git 忽略的 `config/dashboard.local.json`
4. 只读、安全的 `config/dashboard.example.json`

不要提交包含个人 vault 路径、数据库路径或已开启写入的本机配置。

## Development

前端开发服务器会把 `/api` 代理到 `127.0.0.1:8765`：

```sh
python3 -m backend.server
npm run dev --prefix frontend
```

开发地址为 <http://localhost:5183/>。生产构建写入 `dist/`，由 Python 后端
直接托管。

## Verify

无需真实 ActivityWatch 或 Obsidian 数据的单元测试：

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build --prefix frontend
```

连接真实本地环境后，可运行只读集成门禁：

```sh
python3 -m scripts.gate1
```

Gate 1 会读取配置中的历史日记与 ActivityWatch 数据，不应拿真实日记执行写入
测试。历史验证说明见 [Gate 1](docs/GATE1.md)。

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

- 服务强制只绑定 loopback 地址。
- 不修改 ActivityWatch.app，不复制或迁移其 SQLite 数据库。
- 不复制上游统计函数形成分叉。
- 不持续扫描 vault，不自动保存，不批量迁移日记。
- 写入白名单仅包含所选日期的一条工作流描述，或 `我的总结`、`今日产出`、
  `明天的计划` 中的一项。
- 完成任务、自由正文、Kina 生成内容、离线活动、properties 和其他日期均只读。
- 所有写入测试只使用临时 fixture。

更详细的安全说明见 [SECURITY.md](SECURITY.md)。

## Project layout

```text
backend/      Python API、缓存、解析与受限写入
frontend/     React + TypeScript + Vite 前端
dist/         已构建的静态前端
config/       安全公开模板；本机配置由 Git 忽略
tests/        单元测试与合成日记 fixture
scripts/      真实环境的只读 Gate 1
docs/         API、数据契约、设计与能耗说明
```

## Contributing

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。涉及统计口径、日记写入范围或网络
绑定的改动必须带回归测试，并明确说明安全边界是否变化。

## License

[MIT](LICENSE)
