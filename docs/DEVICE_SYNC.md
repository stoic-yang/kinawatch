# 本机设备与健康同步

## iPhone 健康一键同步

使用免费的 Apple“快捷指令”和 iCloud Drive。先在 iPhone 解锁时手动运行，
尚未配置个人自动化触发器。只读取睡眠、步数，不查询其他健康指标。

### 小米运动健康先同步

使用 Mi Fitness（小米运动健康）的手环时，数据经过“手环 → 小米运动健康 →
Apple 健康 → 快捷指令导出”到达 KinaWatch。快捷指令只能读取 Apple 健康已收到
的记录。小米的[连接说明](https://www.mi.com/uk/support/faq/details/KA-515546/)指出，
重新打开 App 可让设备自动重新连接和同步；[健康同步说明](https://www.mi.com/uk/support/faq/details/KA-230360/)
也说明同步后可能需要稍等才能在 Apple 健康中看到记录。具体设备仍需真机验证。

生成时添加 `--mi-fitness` 可启用 v3：

```sh
python3 scripts/build_health_shortcut.py /tmp/health-unsigned.shortcut --mi-fitness
shortcuts sign --mode anyone --input /tmp/health-unsigned.shortcut --output /tmp/KinaWatch-health-v3.shortcut
```

这个版本先打开小米运动健康，留出 20 秒同步缓冲，再导出最近数据；请保持 iPhone
解锁、手环在附近。没有调用已证实的“立即同步”接口，等待也不代表同步完成。
保存后检查导出的睡眠结束日期：如果没有今天的记录，通知会明确指出缺失并建议在
小米 App 确认同步后重试。步数和历史睡眠仍正常导出，缺失不表示没有睡眠。
检查只表示是否含有今天结束的样本，不证明当日记录完整或每一条来自小米。
这是现有一键流程的补充，尚未添加定时或 App 触发的个人自动化。

`--fixture --mi-fitness` 跳过打开 App 和等待，只用合成数据验证相同的日期检查及
通知文案分支。2026-09-08 在 macOS 原生 Shortcuts 分别验证有今日记录和仅有旧记录
的两条分支；iPhone 打开小米 App、设备同步耗时及后台继续执行仍待真机验证。

### 安装与导入

在 Mac 生成并签名，然后在 iPhone 添加：

```sh
python3 scripts/build_health_shortcut.py /tmp/health-unsigned.shortcut
shortcuts sign --mode anyone --input /tmp/health-unsigned.shortcut --output /tmp/KinaWatch-health.shortcut
```

将签名文件放到自己的 iCloud Drive 或 AirDrop 到 iPhone，打开添加并运行。
首次需要允许快捷指令读取睡眠、步数。输出位于“文件”中的
`iCloud Drive / Shortcuts（快捷指令）/ KinaWatch / health.json`。
Mac 对应目录属于 Shortcuts 的 iCloud 容器，**不是** CloudDocs 下自行新建的同名目录。

如果系统提示 `This action is trying to share ... Health items, which is not allowed`，
这是导出数量限制。前往 iPhone 系统“设置 → App → 快捷指令 → 高级”，打开
“允许共享大量数据 / Allow Sharing Large Amounts of Data”，再运行。该开关与
健康读取授权分开；保存目标仍是用户自己的 iCloud 文件。
[Apple 官方说明](https://support.apple.com/zh-cn/guide/shortcuts/apd961a4fc65/ios)。

在 Git 忽略的本机配置中启用：

```json
"health_sync": {
  "enabled": true,
  "file": "~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/KinaWatch/health.json"
}
```

快捷指令按时间排序，读取滚动 8 天记录，不限制结果数量；各列通过换行拼接，
原生字典负责 JSON 转义。版本为 `kinawatch.health.v1`，包含带时区的
`exported_at` 和 `sleep`、`steps` 的 `start/end/value/source` 列。
KinaWatch 同时接受等长 JSON 数组。最大 16 MiB，每类最多十万条。
部分睡眠样本通过 Shortcuts 不提供来源名称，此时按“来源未提供”合并区间；
步数必须保留来源列，以免把手机和手环计数相加。

Mac 在健康接口被请求时检查这个固定文件；健康页“检查同步”、页面加载及回到
浏览器窗口会读取，不扫描其他 iCloud 文件，也没有常驻文件监听器。
省略滚动窗口的首个不完整日期，更新最近 7 个日历日及当天，保留更早历史。
同一内容重复同步不重复累加。HealthKit 对未授权读取可能返回空结果，因此缺失
指标不用于删除旧记录；损坏、全空、时间无效或过期的文件保留已有快照并显示状态。
同一天同一指标的新数据替换旧摘要，继续使用原有睡眠/步数计算规则。

全历史仍通过“导入完整历史”选择 Apple 健康 ZIP。完整导入是替换操作；增量
同步只持久化摘要。iCloud 中用户自己的最近记录文件由快捷指令覆盖，KinaWatch
不会修改或删除它，不会把健康写入日记。详细计算规则见 [PERSONAL_HEALTH.md](PERSONAL_HEALTH.md)。

生成器的 `--fixture` 变体仅使用合成数据，输出 `fixture.json`，可在 macOS 上
核验日期、字典序列化和保存位置。2026-09-08 已在原生 Shortcuts 运行并被解析器
接受；同日已完成 iPhone 真机导出、iCloud 到达、服务增量导入、历史摘要一致及
重复读取不累加验证。其他系统语言和未来 iOS 版本仍需重新验证样本值。
日期自定义格式字段按本机运行结果使用 `WFDateFormat` 保存格式字符串。
日期筛选中的“天”使用 `Values.Unit = 16`；曾有参考表误写为 16384，真机显示
空单位并无法正确执行，因此生成器已按真机反馈修正。

## 三设备屏幕时间

Mac 继续由 ActivityWatch REST API 提供窗口与 AFK 事实；iPhone、iPad 来自 Apple
同步到 Mac 的 Biome `App.InFocus/remote`。不向 ActivityWatch 导入或写入事件。
用户需要启用“屏幕使用时间 → 在设备之间共享”，并授予实际运行 KinaWatch 的
宿主/解释器完全磁盘访问权限。Codex 的权限不自动适用于 launchd 后台进程。

解码器单独安装，不打包进本仓库：

```sh
git clone https://github.com/ActivityWatch/aw-import-screentime.git "$HOME/Library/Application Support/KinaWatch/tools/aw-import-screentime"
cd "$HOME/Library/Application Support/KinaWatch/tools/aw-import-screentime"
git checkout 1297039793819b25f926289fb033d77c66786c50
uv sync --locked --no-dev
```

在本机配置启用示例中的 `screen_time.enabled`，将 `reader_python` 指向该虚拟环境
的 Python。`device_names` 为 Biome 设备标识到用户确认名称的映射，留在本机配置。
可用 `app_names` 添加应用标识到显示名的映射。禁止将真实标识或活动快照提交到 Git。

本仓库的桥接脚本只调用上游解码与区间拼接函数；不调用上游导入、应用商店查询
或状态写入路径。Apple SQLite 以只读连接打开，活动流只读。快照保存在平台
用户数据目录的 `screen-time/snapshot.json`，按记录合并以保留 Apple 清理后的历史。
每次请求最多每分钟检查一次这些固定来源；文件未变化时不启动解码子进程。
子进程超时 45 秒；读取失败保留历史并显示错误。

### 时间与内容的含义

- 时间线分为 Mac、iPhone、iPad，各自显示真实观察区间。锁屏、SpringBoard 等
  系统表面不计为应用活动；未闭合的最后一段不补齐，异常超长区间留作未知。
- 总屏幕时间为各设备区间的并集，重叠不重复计算。多个设备并行时，分类时长
  在这些设备间等分；这是明确的记账方法，不代表注意力或生产力的测量。
- “设备来源”显示各设备原始时长，因此相加可能大于去重总量。没有某天记录
  表示当天暂无同步数据，不能证明设备没有使用。
- Apple 同步有延迟，保留最新事件时间。Biome 是 Apple 私有格式，不能承诺与
  系统 Screen Time 报告逐分一致；系统升级后应重新验证解码器。
- 移动数据只提供应用身份和时间，无法确认浏览内容。沿用匹配得上的现有分类
  规则，其余保持未分类；不能把 Bilibili 使用一概判定为娱乐或学习。
- 手机和平板详情只读；Mac 原始事件仍通过原有指纹检查的编辑接口处理。
  新记录会影响工作流分段与证据快照，不自动改写或迁移既有工作流描述。

接口无需新端口或远程访问：`/api/health.screen_time` 给出源状态，日级
`quality.sources` 给出来源，时间线块新增 `source_type/bundle_id`；日缓存版本 13。
默认安装中两个同步源均关闭，仍使用原有低能耗生命周期。

上游来源：[aw-import-screentime](https://github.com/ActivityWatch/aw-import-screentime)、
[Health 动作格式参考](https://github.com/viticci/shortcuts-playground-plugin/blob/main/codex/skills/shortcuts-playground/HEALTHKIT.md)、
[Shortcuts 字典格式](https://cherrilang.org/compiler/file-format.html)。
