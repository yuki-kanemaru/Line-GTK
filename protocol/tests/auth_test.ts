import { assertEquals, assertRejects } from "@std/assert";
import type { Client } from "@evex/linejs";
import { join } from "@std/path";
import {
  AuthStore,
  legyOptions,
  loginInit,
  restoreSessionWithFallback,
} from "../src/auth.ts";

Deno.test("auth lifecycle uses private files", async () => {
  const directory = await Deno.makeTempDir({ prefix: "line-gtk-auth-" });
  try {
    const store = new AuthStore(directory);
    assertEquals(await store.loadToken(), null);
    await store.save("secret-token", "ANDROIDSECONDARY");
    assertEquals(await store.loadToken(), "secret-token");
    assertEquals(await store.loadDevice(), "ANDROIDSECONDARY");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(store.tokenPath)).mode! & 0o777, 0o600);
    }
    await store.clear();
    assertEquals(await store.loadToken(), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("LEGY暗号化設定は既定で無効にし環境変数で切り替えられる", () => {
  assertEquals(legyOptions(""), { encrypted: false });
  assertEquals(legyOptions("false"), { encrypted: false });
  assertEquals(legyOptions("0"), { encrypted: false });
  assertEquals(legyOptions("auto"), { encrypted: "auto" });
  assertEquals(legyOptions("AUTO"), { encrypted: "auto" });
  assertEquals(legyOptions("true"), { encrypted: true });
  assertEquals(legyOptions("1"), { encrypted: true });
  assertEquals(legyOptions("invalid"), { encrypted: false });

  assertEquals(loginInit("DESKTOPWIN", "26.6.2", { encrypted: false }), {
    device: "DESKTOPWIN",
    legy: { encrypted: false },
  });
  assertEquals(loginInit("ANDROIDSECONDARY", "26.6.2", { encrypted: false }), {
    device: "ANDROIDSECONDARY",
    version: "26.6.2",
    legy: { encrypted: false },
  });
});

Deno.test("ApplicationType mismatch時はもう一方のセカンダリ機種へフォールバックする", async () => {
  const directory = await Deno.makeTempDir({ prefix: "line-gtk-auth-fb-" });
  const storagePath = join(directory, "storage.json");
  try {
    const tried: string[] = [];
    const restored = await restoreSessionWithFallback(
      "fixture-token",
      "DESKTOPWIN",
      storagePath,
      "26.6.2",
      (token, init) => {
        tried.push(init.device);
        if (init.device === "DESKTOPWIN") {
          return Promise.reject(
            new Error(
              `Request internal failed, getProfile(/S4) -> ${
                JSON.stringify({
                  code: "AUTHENTICATION_FAILED",
                  reason: "ApplicationType mismatch",
                })
              }`,
            ),
          );
        }
        assertEquals(init.version, "26.6.2");
        assertEquals(init.legy, { encrypted: false });
        return Promise.resolve({ authToken: token } as Client);
      },
    );
    assertEquals(tried, ["DESKTOPWIN", "ANDROIDSECONDARY"]);
    assertEquals(restored.device, "ANDROIDSECONDARY");
    assertEquals(restored.client.authToken, "fixture-token");

    await assertRejects(
      () =>
        restoreSessionWithFallback(
          "fixture-token",
          "DESKTOPWIN",
          storagePath,
          "26.6.2",
          () => Promise.reject(new Error("NOT_AUTHORIZED_DEVICE")),
        ),
      Error,
      "NOT_AUTHORIZED_DEVICE",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
