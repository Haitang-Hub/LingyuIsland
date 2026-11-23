'use strict';
/**
 * 全屏 / 截图覆盖层探测（Windows 专用；其他平台 start() 直接忽略）
 *
 * 背景：置顶窗永远压在无边框全屏应用之上（后者位于普通窗口层），纯 z 序
 * 无法既「高于所有普通应用」又「低于全屏」；截图遮罩（微信/QQ/Snipaste 等）
 * 虽同为置顶层，但会被 screen-saver 级窗口盖住。唯一的通用机制是探测。
 *
 * 探测区分两类目标（行为不同）：
 *   1. 普通全屏应用（视频/游戏/演示/F11）：前台窗口铺满整块显示器（含任务栏
 *      区域），且不是置顶窗口 → 是否让位跟随 fullscreenAutoHide 开关；
 *   2. 截图遮罩：其他进程的、可见的、置顶（WS_EX_TOPMOST）的、铺满主屏的
 *      覆盖层——遮罩必须置顶才能压暗屏幕，全屏应用一般不置顶，此判据可把
 *      两者分开。遮罩弹出常不抢焦点（前台仍是原窗口），所以不能只看前台，
 *      必须全量枚举顶层窗口 → 恒让位，不受开关影响。
 *
 * 实现：常驻 PowerShell 助手 P/Invoke user32，每 300ms 上报一行：
 *   FULL <前台矩形> T <置顶全屏覆盖层数量>
 * 主进程对照主显示器边界判定；stdout 断开（父进程退出）时助手自行退出。
 *
 * 判定细节：
 *   - 桌面（Progman/WorkerW）与任务栏排除：点一下桌面不该被当成全屏；
 *   - 最大化窗口排除（IsZoomed）：其 GetWindowRect 带约 ±7px 阴影外扩，
 *     容差判定会把它们误判成铺满主屏；无边框全屏与截图遮罩都不是最大化态；
 *   - 连续两拍（约 300ms）一致才判定生效，Alt-Tab 瞬态不触发；退出立即恢复。
 */

const { spawn } = require('child_process');
const readline = require('readline');

const POLL_MS = 150;       // 轮询间隔：进入全屏的判定延迟主要由它决定（两拍 ≈ 300ms）
const CONFIRM_TICKS = 2;   // 连续多少拍一致才判定进入（退出立即恢复）
const RETRY_MS = 2000;     // 助手崩溃后的重启间隔
const MAX_FAILS = 5;       // 连续快速崩溃次数上限（防无限重启）
const BOUNDS_SLACK = 2;    // 覆盖判定的像素容差

/** PowerShell 探测脚本：循环上报前台矩形 + 置顶全屏覆盖层计数，stdout 断开即退出。
 *  占位符 __POLL__ / __SELF_PID__ 由 Node 侧替换，避免与 PowerShell 的 $ 变量混淆。 */
const PS_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class IslandProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);

  // 统计「其他进程、可见未最小化、未最大化、置顶、铺满给定矩形」的顶层窗口数（截图遮罩特征）。
  // 在 C# 内部完成枚举循环，避免 PowerShell 委托回调的开销。
  public static int CountTopmostFullscreen(int ml, int mt, int mr, int mb, int selfPid, int slack) {
    int count = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)selfPid) return true;
      if (!IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return true;
      if ((GetWindowLong(h, -20) & 8) == 0) return true;   // WS_EX_TOPMOST
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      if (r.L <= ml + slack && r.T <= mt + slack && r.R >= mr - slack && r.B >= mb - slack) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        string c = sb.ToString();
        if (c != "Progman" && c != "WorkerW" && c != "Shell_TrayWnd"
            && c.IndexOf("Shell_Secondary", StringComparison.Ordinal) < 0) count++;
      }
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
"@
$out = [Console]::Out
while ($true) {
  try {
    $top = 0
    try { $top = [IslandProbe]::CountTopmostFullscreen(__TOPARGS__) } catch { $top = 0 }
    $fg = [IslandProbe]::GetForegroundWindow()
    $l = 0; $t = 0; $r = 0; $b = 0
    if ($fg -ne [IntPtr]::Zero) {
      $name = New-Object System.Text.StringBuilder 256
      [void][IslandProbe]::GetClassName($fg, $name, 256)
      $cls = $name.ToString()
      # 最大化窗口的 GetWindowRect 带约 ±7px 阴影外扩，容差判定会把它们误判成
      # 铺满主屏——IsZoomed 排除（无边框全屏与截图遮罩都不是最大化态）
      if ($cls -ne 'Progman' -and $cls -ne 'WorkerW' -and -not [IslandProbe]::IsZoomed($fg)) {
        $rect = New-Object 'IslandProbe+RECT'
        if ([IslandProbe]::GetWindowRect($fg, [ref]$rect)) {
          $l = $rect.L; $t = $rect.T; $r = $rect.R; $b = $rect.B
        }
      }
    }
    $out.WriteLine("FULL $l $t $r $b T $top")
    $out.Flush()
  } catch {
    break   # 父进程退出 → stdout 断开 → 助手随之退出
  }
  Start-Sleep -Milliseconds __POLL__
}
`.replace('__POLL__', String(POLL_MS));

class FullscreenWatch {
  /**
   * @param {object} opts
   * @param {() => ({x:number,y:number,width:number,height:number}|null)} opts.getPrimaryBounds 主显示器边界
   * @param {(active:boolean, overlay:boolean) => void} [opts.onChange] 全屏态变化回调（overlay=截图遮罩类覆盖层）
   * @param {string} [opts.platform] 进程平台（测试可注入）
   * @param {number} [opts.selfPid] 排除自身窗口用（默认主进程 PID，测试可注入）
   */
  constructor({ getPrimaryBounds, onChange, platform = process.platform, selfPid = process.pid } = {}) {
    this._getPrimaryBounds = typeof getPrimaryBounds === 'function' ? getPrimaryBounds : () => null;
    this._onChange = typeof onChange === 'function' ? onChange : () => {};
    this._selfPid = selfPid;
    this._script = PS_SCRIPT.replace('__SELF_PID__', String(selfPid));
    this._win = platform === 'win32';
    this._proc = null;
    this._stopped = true;
    this._key = 'N';         // 已上报给 onChange 的状态
    this._pending = null;    // 待确认状态（连续 CONFIRM_TICKS 拍一致才上报）
    this._count = 0;
    this.active = false;     // 当前是否处于全屏态（应用或遮罩）
    this.overlay = false;    // 当前全屏态是否为截图遮罩类覆盖层
    this._restartTimer = null;
    this._spawnedAt = 0;
    this._fails = 0;
  }

  start() {
    if (!this._win || !this._stopped) return;
    this._stopped = false;
    this._fails = 0;
    this._spawn();
  }

  stop() {
    this._stopped = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._proc) {
      try { this._proc.kill(); } catch { /* ignore */ }
      this._proc = null;
    }
    if (this.active) { this._reset(); this._onChange(false, false); }
  }

  _reset() {
    this._key = 'N';
    this._pending = null;
    this._count = 0;
    this.active = false;
    this.overlay = false;
  }

  _spawn() {
    if (this._stopped || this._proc) return;
    try {
      // 主屏边界在启动时注入一次（显示器热插拔后需重启应用，属可接受边界）
      const b = this._getPrimaryBounds() || { x: 0, y: 0, width: 0, height: 0 };
      const topArgs = [b.x, b.y, b.x + b.width, b.y + b.height, this._selfPid, BOUNDS_SLACK]
        .map(Math.round).join(',');
      const script = this._script.replace('__TOPARGS__', topArgs);
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      this._proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      this._retry();
      return;
    }
    this._spawnedAt = Date.now();
    const rl = readline.createInterface({ input: this._proc.stdout });
    rl.on('line', (line) => this._handle(line));
    this._proc.on('error', () => { /* spawn 失败时 exit 事件随后到达，统一在 exit 里处理 */ });
    this._proc.on('exit', () => {
      this._proc = null;
      if (this._stopped) return;
      // 启动后不足 2 秒就退出视为快速失败（脚本被策略拦截等），计入失败次数
      if (Date.now() - this._spawnedAt < 2000 && ++this._fails >= MAX_FAILS) {
        this._stopped = true;
        if (this.active) { this._reset(); this._onChange(false, false); }
        return;
      }
      this._retry();
    });
  }

  _retry() {
    if (this._stopped || this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._spawn();
    }, RETRY_MS);
  }

  /** 解析一行探测输出并推进状态机（单元测试可直调）。
   *  行格式：FULL <l> <t> <r> <b> T <置顶全屏覆盖层数>
   *  状态：'N'=无覆盖；'A'=普通全屏应用；'O'=截图遮罩类覆盖层；'AO'=全屏应用上有遮罩。 */
  _handle(line) {
    const m = /^FULL (-?\d+) (-?\d+) (-?\d+) (-?\d+) T (\d+)$/.exec(String(line).trim());
    if (!m) return;
    const bounds = this._getPrimaryBounds();
    let covering = false;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
      const L = Number(m[1]), T = Number(m[2]), R = Number(m[3]), B = Number(m[4]);
      const s = BOUNDS_SLACK;
      covering = L <= bounds.x + s && T <= bounds.y + s
        && R >= bounds.x + bounds.width - s && B >= bounds.y + bounds.height - s;
    }
    const overlay = Number(m[5]) > 0; // 存在其他进程的置顶全屏窗口（截图遮罩特征）
    const key = covering ? (overlay ? 'AO' : 'A') : (overlay ? 'O' : 'N');

    if (key === 'N') {          // 无覆盖：立即恢复，不去抖（旧约定：退出全屏立即显示）
      this._pending = null;
      if (this._key !== 'N') { this._key = 'N'; this._report(); }
      return;
    }
    if (key === this._key) { this._pending = null; return; } // 抖回已上报状态：重置确认
    if (this._pending !== key) { this._pending = key; this._count = 1; return; }
    if (++this._count >= CONFIRM_TICKS) {
      this._pending = null;
      this._key = key;
      this._report();
    }
  }

  _report() {
    this.active = this._key !== 'N';
    this.overlay = this._key.includes('O');
    this._onChange(this.active, this.overlay);
  }
}

module.exports = { FullscreenWatch };
