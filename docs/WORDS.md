# 单词模块

左侧“单词”（`#words`）按需从电脑端 AnkiConnect 读取词条和学习记录。
展示日期学习统计、词库进度和自然年学习热力图；支持切换年份、点击日期与键盘方向键浏览。
热力图按每日作答次数着色（1–9、10–49、50–99、100 次及以上），未来日期不可选。
单词库、释义例句和卡片浏览留在 Anki；页面不展示账户来源行、学习日数或最近学习快捷入口。
Anki 自己负责背词、评分、调度和 AnkiWeb 同步；KinaWatch 不会创建或修改卡片。

## 连接

在电脑端 Anki 安装 [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
（编号 `2055492159`）并重启，读取时保持 Anki 打开。
手机/平板先同步到 AnkiWeb，再让电脑端 Anki 同步；“更新单词数据”只读取电脑当前集合，
不触发远程同步。KinaWatch 默认端口和 AnkiConnect 都是 8765；两者一起使用时，
将 KinaWatch 启动在另一个本机端口，例如 `--port 8842`。

本机配置支持可选的 `anki` 对象，修改后重启 KinaWatch：

```json
{
  "anki": {
    "server_url": "http://127.0.0.1:8765",
    "query": "deck:English",
    "fields": {
      "term": "Word",
      "phonetic": "Phonetic",
      "definition": "Meaning",
      "example": "Sentence",
      "translation": "Translation"
    }
  }
}
```

默认 `query` 为空，读取当前集合。字段默认识别常见中英文命名，包括“英语单词”“中文释义”
“英语例句”“中文例句”和 Word/Meaning/Front/Back。`fields` 仅需填写需要覆盖的字段；
没有单词字段的笔记会跳过并报告数量。非词汇牌组应通过 `query` 排除。
如果 AnkiConnect 配置了密钥，可在本机 `anki.api_key` 填入相同值；不会发送给浏览器或写入缓存。

## 数据和统计口径

- 一个词条是一条 Anki 笔记。正反卡仍是同一个词条；不同笔记的同形词保留各自身份。
- 学习词条按当日出现过的笔记去重，作答次数按复习记录计数；新学是已保存记录中该笔记首次作答的日期。
- 热力图和日期按配置的 `activitywatch.timezone` 自然日统计，不使用 ActivityWatch 作息日或 Anki 可配置的换日时间。
  因此凌晨作答的日归属可能和 Anki 自带“今日”统计不同。
- 耗时累计 Anki 内部计时，包括其计时上限；不是完整的应用使用时长。
- 仅计评分 1–4、类型 0–3 的作答；手动调度/重置记录不算作答。牌组归属使用卡片当前所在牌组，不能还原历史移牌路径。
- “已学”表示已有保存的作答记录。历史缺失或导入他人的学习记录会影响统计；没有记录的日期表示本机记录为零，
  不证明其他设备未学习。快照日期以后的日期保持未知。

## API 和缓存

`GET /api/words` 返回 `{available, status, error, snapshot}`；`status` 为 `ready`、`cached` 或 `unavailable`。
`GET /api/words?refresh=1` 显式重读，连续点击至少间隔一秒。普通请求共享 60 秒 TTL 和实例锁。
仅首次进入页面、重新进入或点击更新时发起请求；没有轮询、文件监听或新的常驻进程。

只读白名单：`version`、`getActiveProfile`、`deckNamesAndIds`、`findCards`、`cardsInfo`、`getReviewsOfCards`。
连接固定来自本机配置，仅允许 loopback HTTP；禁用代理和重定向。没有可传入任意 Anki action 的代理端点。
每批 200 张卡，最多 20,000 张卡、500,000 条复习记录；超限或读取期间切换账户则保留上次完整结果。

归一化的纯文本词条与作答记录以权限 `0600` 原子保存到平台用户数据目录的 `anki/snapshot-*.json`。
按服务器、query、字段映射及时区隔离。完整更新替换快照，使 Anki 中的删除和撤销能反映出来；
离线、异常响应或中断不会清空已有结果。账户和读取时间保留在 API 元数据中；离线时更新按钮的提示说明正在使用上次数据，不能证明手机已同步。
不保留 HTML、CSS、图片或音频文件，不自动执行词卡模板中的脚本。日志和仓库不保存个人词库。

## 验证

`python3 -m unittest tests.test_anki tests.test_server -v` 验证数据去重、午夜边界、只读白名单、
缓存降级、账户切换、查询隔离及 HTTP 入口；`npm run test:journal --prefix frontend`
包含词条去重汇总、缺失日期和全年热力图（闰年、周对齐、跨年边界）的合成测试。写入测试仅操作临时缓存。
