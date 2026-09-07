# 导出ICS日程 · Export ICS Schedule

Export Obsidian `- [ ]` tasks to `.ics` calendar files and open them with your system calendar app (Google Calendar, Outlook, and other calendars that can import `.ics`) — on **both desktop and mobile**.

把 Obsidian 的 `- [ ]` 任务生成 `.ics` 日历文件，并用系统日历 App 打开导入（桌面端 / 移动端都支持）。

## Features · 功能

- Turn tasks with a date/time into **timed** or **all-day** calendar events.
- Supports `📅` due date, `⏰` time, `(@YYYY-MM-DD HH:MM)` reminder syntax, and Dataview `[date::]`.
- **Configurable timezone** — auto-detect the system timezone, or pick one of 24 fixed timezones (each labelled with common cities).
- **DST-aware** `VTIMEZONE` generation (full `STANDARD` + `DAYLIGHT` rules), so even importers without a timezone database (e.g. desktop Outlook) parse times correctly.
- **Stable UID deduplication** — re-exporting the same task updates the event instead of creating a duplicate.
- **Reminders** (`VALARM`) for every event.
- Date defanging to avoid calendar "smart schedule" auto-creating duplicate events.

## Comparison with similar plugins · 与同类插件的差异

This plugin is built for one job: turn **the current note's tasks** into calendar events with a single tap and let the **system calendar app** do the rest. No token, no Gist, no whole-vault scan.

本插件只做一件事 —— 把**当前这一页**的任务一键扔进**系统日历**，其余交给日历 App 自己处理：无需 Token、无需 Gist、无需全库扫描。

Other plugins in this space fall into three rough approaches, each with different trade-offs:

社区同类插件大致走三条路线，各有取舍：

| 维度 Dimension | 本插件 This plugin | 单字段导出版 Single-field exporters | 全库订阅型 Whole-vault sync |
|---|---|---|---|
| 触发方式 Trigger | 当前页 / 单任务，按需 | 单条笔记的某个 `frontmatter` 字段 | 全库周期扫描 |
| 输出形式 Output | **直接拉起系统日历 App** | 写入 vault 子文件夹 `.ics/`（需手动导入） | 上传 GitHub Gist，生成订阅 URL |
| **移动端 Mobile UX** | ✓ **点一下直接弹出系统日历，事件已预填** | △ 走系统分享面板，需再选一次日历 App | ✕ 需先建 Gist、拷 Token、在日历 App 里手动订阅 URL |
| 时区 Timezone | ✓ 24 整点时区 + 自动检测 | 仅本地时区 | 仅本地时区 |
| 夏令时 DST | ✓ 内嵌完整 STANDARD + DAYLIGHT | ✗ | ✗ |
| 多日期字段 Date fields | `📅` / `⏰` / `(@…)` / `[date::]` / 自定义前缀 | 仅一个固定字段 | `📅` 任务 + Tasks emoji |
| 提醒 Reminder | ✓ VALARM 可配触发时间 | ✗ | 基础 |
| 稳定 UID 去重 Dedup | ✓ 路径 + 标题哈希 | △ 视实现而定 | ✗ |
| 日期脱敏 Defang | ✓ 防「智能识别」重复建事件 | ✗ | ✗ |
| 云服务 / 付费 Cloud / paid | 无，纯离线、免费 | 无 | GitHub Token（免费），部分有付费托管 |

**怎么选 · When to choose**
- **移动端随手记几条任务就想立刻进系统日历** → 本插件（一键直达，离线可用）。
- 笔记里每个事件都有专门的 `deadline` 字段、要批量归档单条 → 单字段导出版。
- 需要**全库持续同步、用订阅 URL 在多个设备间共享同一份日历** → 全库订阅型。

## Usage · 用法

1. Open a note that contains tasks with a date or time.
2. Click the ribbon icon **「本页任务 → ICS日程」**, or use the command palette (search "ICS日程"), or right-click a task / file.
3. The plugin generates a `.ics` file (under `附件/calendar-sync/`) and opens it with your system calendar app.
4. Review the pre-filled event and tap **Save**.

## Task format · 任务格式

| Syntax | Result |
|---|---|
| `- [ ] Report 📅 2026-09-05` | all-day event on 2026-09-05 |
| `- [ ] Report (@2026-09-05)` | all-day event on 2026-09-05 |
| `- [ ] Visit [date:: 2026-09-05]` | all-day event on 2026-09-05 |
| `- [ ] Workout 📅 2026-09-05 ⏰ 15:00` | timed event 15:00–16:00 |
| `- [ ] Call (@2026-09-05 15:00)` | timed event 15:00–16:00 |

## Settings · 设置

| Setting | Default |
|---|---|
| Timezone (auto / 24 fixed zones) | auto |
| Default event duration (minutes) | 60 |
| Timed reminder lead (minutes) | 0 (at start) |
| All-day reminder time (hour) | 9 |
| Defang dates in description | on |

## Installation · 安装

### Obsidian Community Plugins
Search for "Export ICS Schedule" in Settings → Community plugins (once published).

### Manual / BRAT
Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/export-ics-schedule/`, then enable it in Settings → Community plugins.

## License

MIT
