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

Several plugins already turn Obsidian tasks into calendar files (e.g. **iCal**, **iCal Pro**, **Task Calendar Bridge**), mostly aimed at **whole-vault scanning and subscription/sync** (local file, GitHub Gist, or hosted feed). This plugin takes a lighter, on-demand approach instead:

社区里已有几款把 Obsidian 任务转成日历文件的插件（如 **iCal**、**iCal Pro**、**Task Calendar Bridge**），大多面向**全库扫描 + 订阅同步**（本地文件 / GitHub Gist / 托管订阅）。本插件走的是更轻的按需路线：

| | 本插件 This plugin | 典型同类插件 Typical alternatives |
|---|---|---|
| 导出粒度 Granularity | 单页 / 单任务，按需 | 全库扫描 + 持续同步 |
| 移动端 Mobile | ✓ 一键直接拉起系统日历（原生桥） | 导出文件后手动导入 |
| 时区 Timezone | ✓ 24 个整点时区 + 自动检测 | 多为本地时区 |
| 夏令时 DST | ✓ 内嵌完整 STANDARD + DAYLIGHT | 多不内嵌时区块 |
| 去重 Dedup | ✓ 稳定 UID（路径 + 标题哈希） | 视插件而定 |
| 日期脱敏 Defang | ✓ 防「智能识别」重复建事件 | 无 |
| 云服务 / 付费 | 无，纯离线、免费 | 部分需 Gist/托管，其一有付费版 |

**When to choose which · 怎么选**
- 只想把**当前这一页**的任务点一下就进系统日历 → 用本插件。
- 需要**全库持续同步、订阅日历 URL、或跨设备共享** → 可考虑 iCal / iCal Pro / Task Calendar Bridge 等。

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
