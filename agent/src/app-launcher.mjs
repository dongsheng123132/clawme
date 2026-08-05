import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * 在这台电脑上启动程序 —— 但只启动这台电脑自己同意开放的那些。
 *
 * 安全模型只有一句话：**手机发的是 ID，不是命令行。**
 *
 * 命令行只存在于本机这份配置里。手机、relay、任何中间环节都拿不到它，也没有
 * 办法让这里执行一个未列出的东西。少了这道墙，"远程开程序"和"远程任意代码
 * 执行"就是同一件事，而后者是把刚堵上的洞换个地方重挖。
 *
 * 配置形如：
 * ```json
 * [
 *   { "id": "vscode", "name": "VS Code", "label": "VS", "color": "#0a84ff",
 *     "command": "C:/Program Files/Microsoft VS Code/Code.exe" },
 *   { "id": "terminal", "name": "终端", "label": ">_",
 *     "command": "wt.exe", "args": ["-p", "PowerShell"] }
 * ]
 * ```
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class AppLauncher {
  /**
   * @param {Array<object>} apps 本机配置的可启动程序
   * @param {object} [options]
   * @param {Function} [options.spawnFn] 便于测试时替换掉真正的进程启动
   */
  constructor(apps = [], { spawnFn = spawn } = {}) {
    this.spawnFn = spawnFn;
    this.apps = new Map();
    for (const app of Array.isArray(apps) ? apps : []) {
      if (!app || typeof app !== "object") continue;
      const id = typeof app.id === "string" ? app.id.trim() : "";
      const name = typeof app.name === "string" ? app.name.trim() : "";
      const command = typeof app.command === "string" ? app.command.trim() : "";
      // 三样缺一不可：没有 ID 无法被引用，没有名字用户看不懂，
      // 没有命令行这条声明就是个假的。
      if (!ID_PATTERN.test(id) || !name || !command) continue;
      if (this.apps.has(id)) continue;
      this.apps.set(id, {
        id,
        name,
        command,
        args: Array.isArray(app.args) ? app.args.filter((a) => typeof a === "string") : [],
        ...(typeof app.label === "string" && app.label.trim()
          ? { label: app.label.trim().slice(0, 3) }
          : {}),
        ...(typeof app.color === "string" && /^#[0-9a-fA-F]{6}$/.test(app.color.trim())
          ? { color: app.color.trim() }
          : {}),
      });
    }
  }

  static async fromFile(path, options) {
    if (!path) return new AppLauncher([], options);
    try {
      return new AppLauncher(JSON.parse(await readFile(path, "utf8")), options);
    } catch (error) {
      if (error.code === "ENOENT") return new AppLauncher([], options);
      throw error;
    }
  }

  /**
   * 随心跳上报的清单。
   *
   * 刻意剥掉 command 和 args：手机需要知道有什么、怎么画，不需要知道怎么执行。
   */
  manifest() {
    return [...this.apps.values()].map(({ id, name, label, color }) => ({
      id,
      name,
      ...(label ? { label } : {}),
      ...(color ? { color } : {}),
    }));
  }

  get size() {
    return this.apps.size;
  }

  /**
   * 按 ID 启动。未登记的 ID 一律拒绝 —— 这是唯一的入口，没有旁路。
   *
   * 用 spawn 传参数数组，不用 shell 拼串：即便本机配置里带了古怪字符，也不会
   * 变成一次命令注入。
   */
  async launch(appId) {
    const app = this.apps.get(String(appId ?? ""));
    if (!app) {
      return { ok: false, error: `这台电脑没有开放名为 ${appId} 的程序` };
    }
    try {
      const child = this.spawnFn(app.command, app.args, {
        // 脱离 agent：agent 退出不该把用户刚打开的程序一起带走。
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: false,
      });
      child.unref?.();
      return { ok: true, app_id: app.id, pid: child.pid ?? null };
    } catch (error) {
      return { ok: false, app_id: app.id, error: error.message };
    }
  }
}
