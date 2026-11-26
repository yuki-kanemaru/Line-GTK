import { dirname, join } from "@std/path";
import { loginWithAuthToken } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import {
  ensurePrivateDir,
  readPrivateTextFile,
  writePrivateTextFile,
} from "./storage.ts";

export type LineDevice = "ANDROID" | "ANDROIDSECONDARY" | "DESKTOPWIN";
export type LegyEncryptedMode = boolean | "auto";

// 2026-11-18以降、LINEのLEGY暗号化ゲートウェイ(/enc)が404を返すため既定で平文HTTPS経路を使う。
export function legyOptions(raw?: string): { encrypted: LegyEncryptedMode } {
  let value = raw;
  if (value === undefined) {
    try {
      value = Deno.env.get("LINE_LEGY_ENCRYPTED");
    } catch {
      value = undefined;
    }
  }
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto") return { encrypted: "auto" };
  if (
    normalized === "1" || normalized === "true" ||
    normalized === "on" || normalized === "yes"
  ) {
    return { encrypted: true };
  }
  return { encrypted: false };
}

// セッションの機種と同じ設定で復元する。PCにはAndroidのバージョンを渡さない。
export function loginInit(
  device: LineDevice,
  androidVersion: string,
  legy = legyOptions(),
) {
  return device === "DESKTOPWIN"
    ? { device, legy }
    : { device, version: androidVersion, legy };
}

export async function createAuthStorage(path: string) {
  await ensurePrivateDir(dirname(path));
  const storage = new FileStorage(path);
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
  return storage;
}

export async function restoreSession(
  token: string,
  device: LineDevice,
  storagePath: string,
  androidVersion: string,
  authenticate: typeof loginWithAuthToken = loginWithAuthToken,
) {
  return await authenticate(token, {
    ...loginInit(device, androidVersion),
    storage: await createAuthStorage(storagePath),
  });
}

export function isAppTypeMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ApplicationType mismatch");
}

function fallbackDeviceFor(device: LineDevice): LineDevice | null {
  if (device === "DESKTOPWIN") return "ANDROIDSECONDARY";
  if (device === "ANDROIDSECONDARY") return "DESKTOPWIN";
  return null;
}

// 途中失敗したログインでrefreshTokenとauth-device.txtの機種が食い違った場合を自動修復する。
export async function restoreSessionWithFallback(
  token: string,
  device: LineDevice,
  storagePath: string,
  androidVersion: string,
  authenticate: typeof loginWithAuthToken = loginWithAuthToken,
): Promise<{
  client: Awaited<ReturnType<typeof loginWithAuthToken>>;
  device: LineDevice;
}> {
  try {
    const client = await restoreSession(
      token,
      device,
      storagePath,
      androidVersion,
      authenticate,
    );
    return { client, device };
  } catch (error) {
    const fallback = fallbackDeviceFor(device);
    if (!fallback || !isAppTypeMismatchError(error)) throw error;
    const client = await restoreSession(
      token,
      fallback,
      storagePath,
      androidVersion,
      authenticate,
    );
    return { client, device: fallback };
  }
}

export class AuthStore {
  readonly tokenPath: string;
  readonly devicePath: string;

  constructor(dataDir: string) {
    this.tokenPath = join(dataDir, "auth-token.txt");
    this.devicePath = join(dataDir, "auth-device.txt");
  }

  async save(token: string, device: LineDevice): Promise<void> {
    await writePrivateTextFile(this.tokenPath, token);
    await writePrivateTextFile(this.devicePath, device);
  }

  async loadToken(): Promise<string | null> {
    try {
      const token = (await readPrivateTextFile(this.tokenPath)).trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async loadDevice(): Promise<LineDevice> {
    try {
      const device = (await readPrivateTextFile(this.devicePath)).trim();
      if (
        device === "ANDROID" || device === "ANDROIDSECONDARY" ||
        device === "DESKTOPWIN"
      ) {
        return device;
      }
    } catch { /* missing */ }
    return "DESKTOPWIN";
  }

  async clear(): Promise<void> {
    for (const path of [this.tokenPath, this.devicePath]) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}
