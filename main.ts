import { Plugin, PluginSettingTab, Setting, App, Editor, TFile, Notice, Menu, MenuItem, Platform, FileSystemAdapter } from 'obsidian';

interface Settings {
  defaultDurationMinutes: number;
  alarmLeadMinutes: number;   // 定时事件提前多少分钟提醒（0 = 准时）
  allDayReminderHour: number; // 全天事件当天几点提醒（0-23）
  defangDates: boolean;       // 描述里的日期是否脱敏（避免日历「智能识别」再建事件）
  timezone: string;           // IANA 时区，留空=用手机当前时区（自动随系统）
}

const DEFAULT_SETTINGS: Settings = {
  defaultDurationMinutes: 60,
  alarmLeadMinutes: 0,
  allDayReminderHour: 9,
  defangDates: true,
  timezone: '',
};

interface Task {
  raw: string;
  title: string;
  beginTime?: Date;     // 定时事件（识别到具体时刻）
  allDayDate?: string;  // 全天事件（仅日期，YYYYMMDD，直接取原文不做时区换算）
}

// Obsidian 公开类型里未暴露的原生桥方法（移动端 openWithDefaultApp、桌面端 adapter.open）
interface AppWithOpenBridge {
  openWithDefaultApp?: (path: string) => void;
}
interface AdapterWithOpenBridge {
  open?: (path: string) => Promise<void>;
}

const ICS_FOLDER = '附件/calendar-sync';

// 稳定 UID：基于「笔记路径 + 任务标题」生成，使同一任务重导时 UID 不变，
// 日历 App 按 UID 去重/更新，避免每次「本页所有任务」都新建重复事件。
// 纯 JS FNV-1a（双种子拼成 64-bit），不依赖 Node crypto，移动端 WebView 可用。
function stableUid(seed: string): string {
  const fnv = (s: string, h0: number): number => {
    let h = h0 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(seed, 0x811c9dc5);
  const b = fnv(seed, 0x01000193);
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}@obsidian`;
}

// ---- 时区工具：基于 Intl，自动处理夏令时 ----
function tzOffsetMs(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hh, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// 把"某时区墙钟"转成绝对时刻（Date）
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0); // 先把墙钟当 UTC 解
  let t = naive;
  for (let i = 0; i < 4; i++) {
    const nt = naive - tzOffsetMs(new Date(t), tz); // 用 tz 在该瞬时的偏移校正，收敛即停
    if (nt === t) break;
    t = nt;
  }
  return new Date(t);
}

// 绝对时刻 → 某时区墙钟字符串（YYYYMMDDTHHMMSS）
function fmtWallClock(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}${p.month}${p.day}T${hh}${p.minute}${p.second}`;
}

// 毫秒偏移 → iCal 的 ±HHMM（东为正）
function offToIcal(ms: number): string {
  const total = Math.round(ms / 60000);
  const sign = total >= 0 ? '+' : '-';
  const a = Math.abs(total);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// 由切换瞬间(UTC)与其"切换前偏移"推导本地墙钟串与 recurrence 规则。
// DTSTART 在 VTIMEZONE 里按惯例写成"切换前时区"的本地墙钟，故用 fromOff 还原。
function transitionRule(utcMs: number, fromOff: number) {
  const dt = new Date(utcMs + fromOff); // 当作 UTC 读出的字段即本地墙钟
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const wall = `${y}${pad(m)}${pad(d)}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const nth = Math.floor((d - 1) / 7) + 1;
  const ord = d + 7 > daysInMonth ? -1 : nth; // 当月最后一个该周几 → -1（last）
  const rule = `FREQ=YEARLY;BYMONTH=${m};BYDAY=${ord}${BYDAY[dt.getUTCDay()]}`;
  return { wall, rule };
}

// 生成 VTIMEZONE：
// - 无夏令时区（含 24 个 Etc/GMT±N 固定区、Asia/Shanghai 等）→ 单个 STANDARD。
// - 有夏令时区（Europe/London、America/New_York、Australia/Sydney…）→ 完整
//   STANDARD + DAYLIGHT，并用 Intl 全年采样推导切换瞬间与 RRULE。
//   内嵌后，连不自带时区库的导入器（如桌面 Outlook）也能正确解析；
//   手机/系统日历/Google 本就有时区库，更没问题，且仍走 TZID 不回归。
function buildVtimezone(tz: string): string[] {
  const year = new Date().getUTCFullYear();
  // 采样全年每月中旬偏移，得最小(冬令/标准)与最大(夏令)
  const monthly = Array.from({ length: 12 }, (_, m) =>
    tzOffsetMs(new Date(Date.UTC(year, m, 15, 12, 0, 0)), tz)
  );
  const minOff = Math.min(...monthly);
  const maxOff = Math.max(...monthly);

  // 无夏令时：单个 STANDARD（固定偏移，无切换）
  if (minOff === maxOff) {
    const o = offToIcal(minOff);
    return [
      'BEGIN:VTIMEZONE',
      `TZID:${tz}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${o}`,
      `TZOFFSETTO:${o}`,
      'TZNAME:LOCAL',
      'END:STANDARD',
      'END:VTIMEZONE',
    ];
  }

  // 有夏令时：按小时扫描全年，定位两次切换（春进=标准→夏令，秋退=夏令→标准）
  const standardOff = minOff;
  const daylightOff = maxOff;
  const startUtc = Date.UTC(year, 0, 1);
  const endUtc = Date.UTC(year + 1, 0, 1);
  let sfUtc: number | null = null; // 春进瞬间
  let fbUtc: number | null = null; // 秋退瞬间
  let prev = tzOffsetMs(new Date(startUtc), tz);
  for (let t = startUtc + 3600 * 1000; t <= endUtc; t += 3600 * 1000) {
    const cur = tzOffsetMs(new Date(t), tz);
    if (cur !== prev) {
      if (cur > prev) sfUtc = t; // 偏移变大 → 进入夏令时
      else fbUtc = t; // 偏移变小 → 回到标准时
      prev = cur;
    }
  }

  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (fbUtc != null) {
    const s = transitionRule(fbUtc, daylightOff); // 秋退前是夏令偏移
    lines.push(
      'BEGIN:STANDARD',
      `DTSTART:${s.wall}`,
      `TZOFFSETFROM:${offToIcal(daylightOff)}`,
      `TZOFFSETTO:${offToIcal(standardOff)}`,
      'TZNAME:标准时',
      `RRULE:${s.rule}`,
      'END:STANDARD'
    );
  }
  if (sfUtc != null) {
    const d = transitionRule(sfUtc, standardOff); // 春进前是标准偏移
    lines.push(
      'BEGIN:DAYLIGHT',
      `DTSTART:${d.wall}`,
      `TZOFFSETFROM:${offToIcal(standardOff)}`,
      `TZOFFSETTO:${offToIcal(daylightOff)}`,
      'TZNAME:夏令时',
      `RRULE:${d.rule}`,
      'END:DAYLIGHT'
    );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

export default class ExportIcsSchedulePlugin extends Plugin {
  settings!: Settings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<Settings>);
    this.addSettingTab(new ExportIcsScheduleSettingTab(this.app, this));

    // 手机端用 openWithDefaultApp 把 .ics 交给系统日历（系统日历）接管导入；
    // 桌面端无此桥，改为写出 .ics 后用系统默认程序打开 / 提示路径，供手动导入到
    // Outlook、Google Calendar。两种平台都注册功能区图标 / 命令 / 右键项。

    // A. 编辑器长按/右击菜单：始终显示，点击时智能定位任务
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        menu.addItem((item: MenuItem) =>
          item
            .setTitle('⇢ 导出到 ICS日程')
            .setIcon('calendar-plus')
            .onClick(() => this.launchFromEditor(editor))
        );
      })
    );

    // B. 文件右击菜单：批量跳转本页所有任务
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item: MenuItem) =>
            item
              .setTitle('⇢ 本页所有任务 → ICS日程')
              .setIcon('calendar-plus')
              .onClick(() => this.launchFile(file))
          );
        }
      })
    );

    // C. Ribbon 图标：当前文件所有任务
    this.addRibbonIcon('calendar-plus', '本页任务 → ICS日程', () => {
      const f = this.app.workspace.getActiveFile();
      if (f) void this.launchFile(f);
      else new Notice('请先打开一个含任务的笔记');
    });

    // D. 命令面板
    this.addCommand({
      id: 'send-current-task',
      name: '当前任务 → ICS日程',
      editorCallback: (editor: Editor) => this.launchFromEditor(editor),
    });

    this.addCommand({
      id: 'send-all-tasks-in-file',
      name: '当前文件所有任务 → ICS日程',
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (f) void this.launchFile(f);
        else new Notice('请先打开一个含任务的笔记');
      },
    });
  }

  /** 从编辑器智能定位目标任务（光标行 → 向上3行 → 选中文本）*/
  private launchFromEditor(editor: Editor) {
    let task = this.findTaskAtCursor(editor);

    if (!task) {
      const sel = editor.getSelection();
      if (sel) {
        const m = sel.match(/^\s*-\s*\[\s\]\s*(.+)$/m);
        if (m) task = this.parseTask(m[1].trim());
      }
    }

    if (task) {
      return this.launch([task], this.app.workspace.getActiveFile() ?? undefined);
    }

    new Notice(
      '未在此处找到带时间的 - [ ] 任务\n' +
      '请把光标放在任务行，或用命令面板选「当前文件所有任务 → ICS日程」'
    );
  }

  /** 光标所在任务行（向上找 3 行）*/
  findTaskAtCursor(editor: Editor): Task | null {
    const cursor = editor.getCursor();
    for (let i = cursor.line; i >= Math.max(0, cursor.line - 3); i--) {
      const m = editor.getLine(i).match(/^\s*-\s*\[\s\]\s*(.+)$/);
      if (m) return this.parseTask(m[1].trim());
    }
    return null;
  }

  /**
   * 解析任务（due date 与提醒时间可以共存）：
   * - 只有 due date（`📅 2026-09-05` / `(@2026-09-05)`）→ 全天日程
   * - due date + 具体提醒时刻（`⏰ 15:00` 或 `(@2026-09-05 15:00)`）→ 定时日程，以提醒时刻为准
   */
  parseTask(raw: string): Task {
    let beginTime: Date | undefined;
    let allDayDate: string | undefined;

    // 先把「日期」和「时刻」分开收集，最后统一决策，避免 if-else 链漏掉组合
    let dueDate: string | undefined;    // 📅 due date
    let remindDate: string | undefined; // (@YYYY-MM-DD) 的日期
    let remindTime: string | undefined; // (@... HH:MM) 的时刻
    let emojiTime: string | undefined;  // ⏰ HH:MM
    let dvDate: string | undefined;     // [date:: YYYY-MM-DD]

    const rm = raw.match(/\(@(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\)/);
    if (rm) {
      remindDate = rm[1];
      if (rm[2]) remindTime = rm[2];
    }

    const dm = raw.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    if (dm) dueDate = dm[1];

    const tm = raw.match(/⏰\s*(\d{2}:\d{2})/);
    if (tm) emojiTime = tm[1];

    const dvm = raw.match(/\[date::\s*(\d{4}-\d{2}-\d{2})\]/);
    if (dvm) dvDate = dvm[1];

    // 有具体时刻 → 定时日程，且**始终以提醒时刻为准**：
    // 即使 due date 与提醒日期不同（如 📅 09-05 + (@2026-09-06 15:00)），
    // 日程也建在提醒时间那天那个点；due date 只在没有 @ 提醒时刻时才用来配对 ⏰。
    const time = remindTime || emojiTime; // (@... HH:MM) 优先于 ⏰ HH:MM
    if (time) {
      const date = remindTime
        ? remindDate || dueDate || dvDate
        : dueDate || remindDate || dvDate;
      if (date) beginTime = wallToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5), this.resolveTz());
    }

    // 没有任何具体时刻 → 全天日程（due date 优先）
    if (!beginTime) {
      const allDay = dueDate || remindDate || dvDate;
      if (allDay) allDayDate = allDay.replace(/-/g, '');
    }

    const title = raw
      .replace(/\(@[^)]+\)/g, '')
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/gu, '')
      .replace(/⏰\s*\d{2}:\d{2}/gu, '')
      .replace(/🛁\s*\d{4}-\d{2}-\d{2}/gu, '')
      .replace(/🔁\s*[^\s]+/gu, '')
      .replace(/\[date::[^\]]+\]/g, '')
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    return { raw, title, beginTime, allDayDate };
  }

  /** 构造 ICS（定时事件按生效时区用 TZID，全天事件用 VALUE=DATE，每个事件带 VALARM 提醒）*/
  private buildIcs(tasks: Task[], file?: TFile): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    // 绝不能用 getHours() 拼本地时间（浮动时间无 Z 无 TZID），否则系统日历会
    // 同时按本地时区和 UTC 解释，一个日程里出现 15:00 与 23:00 两段时间。
    const fmtUTC = (d: Date) =>
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

    // 时区：默认用手机当前时区（resolveTz），也可在设置里指定 IANA 时区。
    // 用 TZID 而非 UTC「Z」——系统日历对 Z 格式会在事件详情里**额外显示 GMT
    // 等价段**（如 08:00–09:00 GMT），被误认为「重复时间」。TZID 只显示本地
    // 时间，且仍避免早期「浮动本地时间」被按本地+UTC 双重解释的问题。
    const tz = this.resolveTz();
    const TZID = tz;
    const fmtLocal = (d: Date) => fmtWallClock(d, tz);
    const esc = (s: string) =>
      s
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');

    // 全天事件结束日 = 次日（iCalendar 的 DTEND 是排他的）
    const nextDay = (c: string) => {
      const y = +c.slice(0, 4), m = +c.slice(4, 6), d = +c.slice(6, 8);
      const dt = new Date(Date.UTC(y, m - 1, d + 1));
      return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
    };

    // 全天事件提醒时刻：当天 allDayReminderHour 点（按生效时区）转成 UTC 绝对时刻
    const allDayTrigger = (c: string) => {
      const h = Math.min(23, Math.max(0, this.settings.allDayReminderHour));
      const dt = wallToUtc(+c.slice(0, 4), +c.slice(4, 6), +c.slice(6, 8), h, 0, tz);
      return fmtUTC(dt);
    };

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//obsidian//export-ics-schedule//CN',
      'CALSCALE:GREGORIAN',
    ];
    // 无夏令时的时区内嵌 VTIMEZONE（简单静态块）；有夏令时的时区不内嵌，
    // 交由日历 App 自己的时区库按 TZID 解析（避免手写 DST 规则出错）
    lines.push(...buildVtimezone(tz));

    const stamp = fmtUTC(new Date());
    const lead = Math.max(0, this.settings.alarmLeadMinutes);

    for (const t of tasks) {
      // UID 稳定化：同一「笔记路径 + 任务标题」每次导出都得到相同 UID，
      // 系统日历按 UID 识别为同一事件 → 重导时更新而非新建，消除重复。
      const uid = stableUid(`${file?.path || 'obsidian'}::${t.title || 'task'}`);
      const summary = esc(t.title || 'Obsidian 任务');

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${stamp}`);

      if (t.allDayDate) {
        // 全天日程：只写日期不写时刻 → 日历里不会出现时间段
        lines.push(`DTSTART;VALUE=DATE:${t.allDayDate}`);
        lines.push(`DTEND;VALUE=DATE:${nextDay(t.allDayDate)}`);
      } else {
        const begin = t.beginTime!;
        const end = new Date(begin.getTime() + this.settings.defaultDurationMinutes * 60 * 1000);
        lines.push(`DTSTART;TZID=${TZID}:${fmtLocal(begin)}`);
        lines.push(`DTEND;TZID=${TZID}:${fmtLocal(end)}`);
      }

      lines.push(`SUMMARY:${summary}`);
      // 描述统一为「Obsidian/路径/笔记名」，方便从日历回查来源。
      // 不放任务原文：原文含 📅 / (@...) 等日期标记，
      // 系统日历的「智能识别日程」会据此再建一个重复事件。
      lines.push(`DESCRIPTION:来源：${esc(this.sourceLabel(file))}`);

      // VALARM：定时事件提前 lead 分钟（0 = 准时）；全天事件在当天指定时刻提醒
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      if (t.allDayDate) {
        lines.push(`TRIGGER;VALUE=DATE-TIME:${allDayTrigger(t.allDayDate)}`);
      } else {
        lines.push(`TRIGGER;RELATED=START:-PT${lead}M`);
      }
      lines.push(`DESCRIPTION:${summary}`);
      lines.push('END:VALARM');

      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /** 描述文本：Obsidian/路径/笔记名（去掉 .md 后缀），如 Obsidian/20待办/xxx项目/xxx行动 */
  private sourceLabel(file?: TFile): string {
    if (!file) return 'Obsidian';
    const label = `Obsidian/${file.path.replace(/\.md$/i, '')}`;
    return this.settings.defangDates ? this.defangDates(label) : label;
  }

  /**
   * 日期脱敏：在日期的数字之间插入零宽空格（U+200B）。
   * 显示效果完全不变，但字符串不再匹配 YYYY-MM-DD / YYYYMMDD，
   * 日历的「智能识别日程」就抓不到日期、不会再据此多建一个事件。
   */
  private defangDates(s: string): string {
    return s
      // 2026-09-04 / 2026/09/04 / 2026.09.04（前后分隔符须一致）
      .replace(/(\d{4})([-/.])(\d{2})\2(\d{2})/g, '$1$2\u200B$3$2\u200B$4')
      // 20260904（8 位连续数字）
      .replace(/\b(\d{4})(\d{2})(\d{2})\b/g, '$1\u200B$2\u200B$3');
  }

  /** 解析生效时区：设置项优先；留空则用手机当前时区；兜底 Asia/Shanghai */
  private resolveTz(): string {
    const raw = (this.settings.timezone || '').trim();
    if (raw) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: raw });
        return raw;
      } catch {
        /* 非法 IANA 名，落到下面自动检测 */
      }
    }
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (z) return z;
    } catch {
      /* 忽略，用兜底 */
    }
    return 'Asia/Shanghai';
  }

  /** 把标题转成合法文件名 */
  private safeName(title: string): string {
    const cleaned = (title || 'task')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 40)
      .replace(/_+$/, '');
    return cleaned || `task-${Date.now()}`;
  }

  /**
   * 写入 ICS 并打开：
   * - 手机端：用 openWithDefaultApp 原生桥把 .ics 交给系统日历（系统日历）接管导入。
   * - 桌面端：无此桥，写出文件后用系统默认程序打开（.ics 若已关联 Outlook 等则直接导入），
   *   并提示文件路径，供手动导入到 Outlook / Google Calendar。
   */
  private async writeAndOpenIcs(tasks: Task[], file?: TFile) {
    const ics = this.buildIcs(tasks, file);
    const folder = ICS_FOLDER;
    const adapter = this.app.vault.adapter;

    if (!(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }

    const relPath =
      tasks.length === 1
        ? `${folder}/${this.safeName(tasks[0].title)}.ics`
        : `${folder}/${new Date().toISOString().slice(0, 10)}_批量任务.ics`;

    await adapter.write(relPath, ics);

    if (Platform.isMobile) {
      const app = this.app as unknown as AppWithOpenBridge;
      if (app.openWithDefaultApp) {
        app.openWithDefaultApp(relPath);
        new Notice(
        tasks.length === 1
          ? '📅 已生成日历文件并用系统打开，请在系统日历点"保存"'
          : `📅 已生成 ${tasks.length} 条事件的日历文件，系统日历导入后逐条保存`
        );
      } else {
        new Notice('当前 Obsidian 版本无 openWithDefaultApp，请手动打开: ' + relPath);
      }
      return;
    }

    // 桌面端：写出后用系统默认程序打开 .ics（关联 Outlook 等会直接导入），并提示路径。
    const fs = adapter as FileSystemAdapter & AdapterWithOpenBridge;
    const full = fs.getFullPath(relPath);
    let opened = false;
    try {
      if (fs.open) {
        await fs.open(full);
        opened = true;
      }
    } catch {
      /* 打开失败则走下面的路径提示 */
    }

    if (opened) {
      new Notice(
        tasks.length === 1
          ? '📅 已生成日历文件并尝试用默认程序打开（若 .ics 已关联 Outlook 等会直接导入）'
          : `📅 已生成 ${tasks.length} 条事件的日历文件并尝试打开`,
        8000
      );
    } else {
      new Notice('已生成日历文件：\n' + full + '\n请在 Outlook / Google Calendar 中导入', 8000);
    }
  }

  /** 跳转：单条或批量 */
  launch(tasks: Task[], file?: TFile) {
    const valid = tasks.filter((t) => t.beginTime || t.allDayDate);
    if (!valid.length) {
      return new Notice(
        '❓ 任务未指定时间，无法创建日历事件\n' +
        '定时：(@2026-09-05 09:00) 或 📅 2026-09-05 ⏰ 09:00\n' +
        '全天：(@2026-09-05) 或 📅 2026-09-05'
      );
    }
    void this.writeAndOpenIcs(valid, file);
  }

  /** 批量跳转文件所有任务 */
  async launchFile(f: TFile) {
    const content = await this.app.vault.read(f);
    const tasks: Task[] = content
      .split('\n')
      .map((l) => l.match(/^\s*-\s*\[\s\]\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => this.parseTask(m[1].trim()));

    const valid = tasks.filter((t) => t.beginTime || t.allDayDate);
    if (!valid.length) {
      return new Notice(
        '本页没有带时间的 - [ ] 任务\n' +
        '定时：(@2026-09-05 09:00) 或 📅 2026-09-05 ⏰ 09:00\n' +
        '全天：(@2026-09-05) 或 📅 2026-09-05'
      );
    }
    void this.writeAndOpenIcs(valid, f);
  }
}

class ExportIcsScheduleSettingTab extends PluginSettingTab {
  plugin: ExportIcsSchedulePlugin;

  // 24 fixed timezones (UTC-11 ~ UTC+12) with a sample of common cities.
  // Empty value `''` means "auto" (use the system timezone).
  // Values are `Etc/GMT±N` (fixed offset, no DST) so Intl handles them everywhere.
  private static readonly TZ_CITIES: Record<number, string> = {
    [-11]: 'Pago Pago (American Samoa), Midway',
    [-10]: 'Honolulu (Hawaii)',
    [-9]: 'Anchorage (Alaska)',
    [-8]: 'Los Angeles, Vancouver',
    [-7]: 'Denver, Phoenix, Edmonton',
    [-6]: 'Chicago, Mexico City, Guatemala City',
    [-5]: 'New York, Bogota',
    [-4]: 'Halifax, La Paz, Manaus',
    [-3]: 'São Paulo, Buenos Aires, Montevideo',
    [-2]: 'South Georgia, Fernando de Noronha',
    [-1]: 'Azores (Portugal), Cape Verde',
    [0]: 'London, Lisbon, Accra',
    [1]: 'Paris, Berlin, Rome, Madrid',
    [2]: 'Cairo, Helsinki, Istanbul',
    [3]: 'Moscow, Nairobi, Baghdad',
    [4]: 'Dubai, Baku',
    [5]: 'Karachi, Islamabad',
    [6]: 'Dhaka, Astana',
    [7]: 'Bangkok, Jakarta, Hanoi',
    [8]: 'Beijing, Shanghai, Hong Kong, Singapore, Perth',
    [9]: 'Tokyo, Seoul',
    [10]: 'Sydney, Melbourne',
    [11]: 'Honiara',
    [12]: 'Wellington, Suva',
  };
  private static readonly TZ_OPTIONS: Record<string, string> = (() => {
    const opts: Record<string, string> = { '': 'Auto (system timezone)' };
    for (let off = -11; off <= 12; off++) {
      const etc = off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
      const sign = off > 0 ? '+' : off < 0 ? '-' : '';
      const cities = ExportIcsScheduleSettingTab.TZ_CITIES[off] || '';
      opts[etc] = `UTC${sign}${Math.abs(off)}: ${cities}`;
    }
    return opts;
  })();

  constructor(app: App, plugin: ExportIcsSchedulePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Declarative settings API (Obsidian 1.13+). Settings show up in the global
  // settings search. Persistence (getControlValue / setControlValue / saveData)
  // is handled by the framework automatically.
  getSettingDefinitions() {
    return [
      {
        name: 'Timezone',
        desc: 'Select "Auto" to use the system timezone. For a fixed zone, pick one of 24 fixed zones (UTC-11 to UTC+12).',
        control: {
          type: 'dropdown',
          key: 'timezone',
          defaultValue: '',
          options: ExportIcsScheduleSettingTab.TZ_OPTIONS,
        },
      },
      {
        name: 'Default event duration (minutes)',
        desc: 'Duration used for timed tasks without an end time. Default: 60.',
        control: {
          type: 'number',
          key: 'defaultDurationMinutes',
          defaultValue: 60,
          min: 1,
          max: 1440,
        },
      },
      {
        name: 'Reminder lead time (minutes)',
        desc: '0 = at the start of the event. If your calendar ignores 0, try 5 or 10.',
        control: {
          type: 'number',
          key: 'alarmLeadMinutes',
          defaultValue: 0,
          min: 0,
          max: 1440,
        },
      },
      {
        name: 'All-day event reminder time (hour)',
        desc: 'Hour of day to remind for all-day events (0-23). Default: 9.',
        control: {
          type: 'number',
          key: 'allDayReminderHour',
          defaultValue: 9,
          min: 0,
          max: 23,
        },
      },
      {
        name: 'Defang dates in description',
        desc: 'Insert zero-width characters into dates in the note name (e.g. diary 2026-09-04) to prevent the calendar\'s "smart schedule" from auto-creating duplicate events. Display unchanged.',
        control: {
          type: 'toggle',
          key: 'defangDates',
          defaultValue: true,
        },
      },
    ];
  }

  // Legacy fallback for Obsidian < 1.13.
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Settings').setHeading();
    containerEl.createEl('p', {
      text: 'Open a note containing tasks, then click the "Tasks → ICS schedule" ribbon icon. ' +
        'It exports every `- [ ]` task that has a time or a date to a .ics file and opens it with the system calendar. ' +
        'Times become scheduled events; dates only become all-day events. Both include a reminder. ' +
        'You can also trigger this from the command palette by searching for "ICS schedule".',
    });
    containerEl.createEl('p', {
      text: 'Deduplication: a task\'s UID is derived from its note path + title. As long as both are unchanged, ' +
        're-running the export updates the existing event instead of creating a duplicate. ' +
        'If you rename the task or move/rename the note, a new UID is generated and the system calendar treats it as a new event; ' +
        'the old event (old title or old path) is NOT removed automatically and must be deleted manually.',
    });

    new Setting(containerEl)
      .setName('Timezone')
      .setDesc('Select "Auto" to use the system timezone. For a fixed zone, pick one of 24 fixed zones (UTC-11 to UTC+12).')
      .addDropdown((dd) => {
        for (const [val, label] of Object.entries(ExportIcsScheduleSettingTab.TZ_OPTIONS)) {
          dd.addOption(val, label);
        }
        dd.setValue(this.plugin.settings.timezone || '').onChange(async (value) => {
          this.plugin.settings.timezone = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName('Default event duration (minutes)')
      .setDesc('Duration used for timed tasks without an end time. Default: 60.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.defaultDurationMinutes))
          .onChange(async (value) => {
            this.plugin.settings.defaultDurationMinutes = parseInt(value, 10) || 60;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('Reminder lead time (minutes)')
      .setDesc('0 = at the start of the event. If your calendar ignores 0, try 5 or 10.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.alarmLeadMinutes))
          .onChange(async (value) => {
            this.plugin.settings.alarmLeadMinutes = parseInt(value, 10) || 0;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('All-day event reminder time (hour)')
      .setDesc('Hour of day to remind for all-day events (0-23). Default: 9.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.allDayReminderHour))
          .onChange(async (value) => {
            const h = parseInt(value, 10);
            this.plugin.settings.allDayReminderHour = Number.isNaN(h) ? 9 : Math.min(23, Math.max(0, h));
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('Defang dates in description')
      .setDesc(
        'Insert zero-width characters into dates in the note name (e.g. diary 2026-09-04) to prevent the calendar\'s "smart schedule" from auto-creating duplicate events. Display unchanged.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defangDates)
          .onChange(async (value) => {
            this.plugin.settings.defangDates = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}
