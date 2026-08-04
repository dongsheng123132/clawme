import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdentityKind, IdentityRole } from "./auth.js";

/**
 * 设备凭据：签发、查询、吊销。
 *
 * 在这之前，加一台手机等于手抄一个 64 位十六进制令牌，而吊销等于改环境变量
 * 重启整个 relay —— 于是实践中没人吊销。这里把凭据变成可单独签发、可单独
 * 作废的记录。
 *
 * 三条不肯让步的规矩：
 *  1. **令牌只以哈希形式落盘。** 凭据文件被拖走也无法重放。令牌是 32 字节随机
 *     数，熵足够，用 SHA-256 即可；这里没有需要抗暴力破解的低熵口令。
 *  2. **明文只出现一次。** 签发时返回给调用方，之后 relay 自己也拿不回来。
 *  3. **配对码短期、一次性。** 它是给人手输的，所以短；短就必须有寿命。
 */

/** 人眼和手输友好：去掉了 0/O、1/I/L 这些会认错的字符。 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const DEFAULT_CODE_TTL_MS = 5 * 60_000;
const TOKEN_BYTES = 32;

/** 配对码是短的，所以兑换必须限速；令牌本身足够长，不需要。 */
const REDEEM_FAILURE_WINDOW_MS = 60_000;
const REDEEM_FAILURE_LIMIT = 20;

export class DeviceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "DeviceError";
  }
}

export interface DeviceTemplate {
  name: string;
  actorKind: IdentityKind;
  surface?: string;
  role: IdentityRole;
  machineIds: string[];
}

export interface DeviceRecord extends DeviceTemplate {
  id: string;
  actorId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface PairingRecord {
  id: string;
  codeHash: string;
  template: DeviceTemplate;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedDeviceId?: string;
}

interface DeviceFile {
  devices: DeviceRecord[];
  pairings: PairingRecord[];
}

const EMPTY: DeviceFile = { devices: [], pairings: [] };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 令牌比对走定长哈希 + 恒定时间比较，不让比较耗时泄露前缀信息。 */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function formatCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** 兑换时容忍大小写、连字符和空格 —— 人是照着屏幕念出来输进去的。 */
export function normalizeCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new DeviceError("invalid_pairing_code", "pairing code is required");
  }
  const cleaned = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (cleaned.length !== CODE_LENGTH) {
    throw new DeviceError("invalid_pairing_code", "pairing code is malformed");
  }
  return cleaned;
}

function generateCode(): string {
  // 用拒绝采样而不是取模，避免字母表长度不整除 256 造成的分布倾斜。
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

export interface ResolvedDevice {
  deviceId: string;
  actorId: string;
  actorKind: IdentityKind;
  surface?: string;
  role: IdentityRole;
  machineIds: string[];
}

export class DeviceStore {
  private data: DeviceFile = structuredClone(EMPTY);
  /** tokenHash → device，兑换和鉴权都是 O(1)，不随设备数线性扫描。 */
  private byTokenHash = new Map<string, DeviceRecord>();
  private failures: number[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath =
      process.env.CLAWME_DEVICE_FILE ?? "data/clawme-devices.json",
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<DeviceFile>;
      this.data = {
        devices: parsed.devices ?? [],
        pairings: parsed.pairings ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = structuredClone(EMPTY);
    }
    this.reindex();
  }

  private reindex(): void {
    this.byTokenHash.clear();
    for (const device of this.data.devices) {
      if (!device.revokedAt) this.byTokenHash.set(device.tokenHash, device);
    }
  }

  /** 凭据文件按 0600 落盘；它虽然只存哈希，也没有理由让别的用户读到。 */
  private persist(): void {
    const body = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await mkdir(dirname(this.filePath), { recursive: true }).catch(() => {});
      await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    }).catch((error) => {
      console.error("[clawme] 设备凭据落盘失败：", error);
    });
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  /** 签发配对码。明文只在这里出现一次，relay 之后只留哈希。 */
  createPairingCode(template: DeviceTemplate, ttlMs = DEFAULT_CODE_TTL_MS): {
    code: string;
    expiresAt: string;
  } {
    if (!template.name.trim()) {
      throw new DeviceError("invalid_device_name", "device name is required");
    }
    const now = Date.now();
    const raw = generateCode();
    const record: PairingRecord = {
      id: `pair-${randomBytes(8).toString("hex")}`,
      codeHash: sha256(raw),
      template: { ...template, name: template.name.trim() },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    // 过期和已兑换的记录没有保留价值，顺手清掉，别让文件无限长。
    this.data.pairings = this.data.pairings
      .filter((item) => !item.redeemedAt && Date.parse(item.expiresAt) > now)
      .concat(record);
    this.persist();
    return { code: formatCode(raw), expiresAt: record.expiresAt };
  }

  /**
   * 兑换配对码换取设备令牌。明文令牌只返回这一次。
   *
   * 兑换本身不需要鉴权 —— 配对码就是那一次的凭据。所以这里必须限速。
   */
  redeemPairingCode(rawCode: unknown, deviceName?: string): {
    token: string;
    device: DeviceRecord;
  } {
    const now = Date.now();
    this.failures = this.failures.filter((at) => now - at < REDEEM_FAILURE_WINDOW_MS);
    if (this.failures.length >= REDEEM_FAILURE_LIMIT) {
      throw new DeviceError(
        "too_many_attempts",
        "too many failed pairing attempts; try again later",
        429,
      );
    }

    const code = normalizeCode(rawCode);
    const codeHash = sha256(code);
    const pairing = this.data.pairings.find((item) => hashEquals(item.codeHash, codeHash));

    if (!pairing || pairing.redeemedAt || Date.parse(pairing.expiresAt) <= now) {
      this.failures.push(now);
      this.persist();
      // 不区分"不存在""已用过""已过期"，免得回答本身变成一个枚举接口。
      throw new DeviceError("invalid_pairing_code", "pairing code is invalid or expired", 401);
    }

    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const suffix = randomBytes(4).toString("hex");
    const device: DeviceRecord = {
      ...pairing.template,
      name: deviceName?.trim() || pairing.template.name,
      id: `dev-${suffix}`,
      actorId: `${pairing.template.surface ?? "device"}-${suffix}`,
      tokenHash: sha256(token),
      createdAt: new Date(now).toISOString(),
    };

    pairing.redeemedAt = new Date(now).toISOString();
    pairing.redeemedDeviceId = device.id;
    this.data.devices.push(device);
    this.byTokenHash.set(device.tokenHash, device);
    this.persist();
    return { token, device };
  }

  /** 鉴权路径。已吊销的设备不在索引里，天然拒绝。 */
  resolve(token: string): ResolvedDevice | null {
    const device = this.byTokenHash.get(sha256(token));
    if (!device || device.revokedAt) return null;
    const now = new Date().toISOString();
    // 最后活跃时间每分钟最多写一次，避免每个请求都触发一次落盘。
    if (!device.lastSeenAt || Date.now() - Date.parse(device.lastSeenAt) > 60_000) {
      device.lastSeenAt = now;
      this.persist();
    }
    return {
      deviceId: device.id,
      actorId: device.actorId,
      actorKind: device.actorKind,
      ...(device.surface ? { surface: device.surface } : {}),
      role: device.role,
      machineIds: device.machineIds,
    };
  }

  /** 列表里不含令牌，也不含哈希 —— 运维界面没有理由看到它们。 */
  listDevices(): Array<Omit<DeviceRecord, "tokenHash">> {
    return this.data.devices.map(({ tokenHash: _ignored, ...rest }) => rest);
  }

  /** 吊销是立即生效的：从索引里摘掉，下一个请求就是 401。不需要重启。 */
  revokeDevice(deviceId: string): Omit<DeviceRecord, "tokenHash"> {
    const device = this.data.devices.find((item) => item.id === deviceId);
    if (!device) throw new DeviceError("device_not_found", "device not found", 404);
    if (!device.revokedAt) {
      device.revokedAt = new Date().toISOString();
      this.byTokenHash.delete(device.tokenHash);
      this.persist();
    }
    const { tokenHash: _ignored, ...rest } = device;
    return rest;
  }
}
