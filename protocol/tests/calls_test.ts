import { assertEquals } from "@std/assert";
import type { IncomingAudioCall, PlanetEndReason } from "@evex/linejs/call";
import {
  configureCallRuntime,
  handleCallCancel,
  handleCallMessage,
  handleIncomingCall,
  normalizeCancelCall,
  normalizeIncomingCall,
  resetIncomingCall,
} from "../src/calls.ts";

const PEER_MID = "ubdd716f5b629aebc43caa2edd7505591";
const OTHER_MID = "u9f049104dd93745b7d0ff9e4fd896e65";
const SELF_MID = "u4e1ca228e9959a69bc018417ffc391d6";
const GROUP_MID = "c4cb2ea1bc2ca922853d2bde760f6d16b";

function sampleAudio(callId = "CALL-AUDIO-1"): IncomingAudioCall {
  return {
    callId,
    callerMid: PEER_MID,
    localMid: SELF_MID,
    createdAt: 1795736950181,
    credential: new Uint8Array(32),
    route: {
      voipAddress: "127.0.0.1",
      voipAddress6: "",
      voipUdpPort: 10000,
      commParam: "{}",
      fromToken: "TOK12345",
      fromZone: "jpdc",
      toZone: "jpdc",
      toMid: PEER_MID,
    },
  };
}

Deno.test("1対1音声通話の着信イベントはそのまま正規化される", () => {
  const result = normalizeIncomingCall({
    audio: {
      callId: "179557B9-DB30-4ED4-BA9E-C052C8005894",
      callerMid: PEER_MID,
    },
    callMid: "179557B9-DB30-4ED4-BA9E-C052C8005894",
    from: PEER_MID,
    kind: "AUDIO",
  });
  assertEquals(result, {
    callId: "179557B9-DB30-4ED4-BA9E-C052C8005894",
    from: PEER_MID,
    kind: "AUDIO",
  });
});

Deno.test("ビデオ通話着信でparam1/param2がずれても発信者MID・通話ID・種別を復元し鍵JSONを漏らさない", () => {
  const rawJson = JSON.stringify({
    d: "CV",
    k: "CV",
    n: "2WHVV9V27Z",
    vs: "68A4A1BB-13DC-4361-900C-1F7381C104A4",
    vc: JSON.stringify({ mpkey: "fixture-secret-key" }),
  });
  const result = normalizeIncomingCall({
    callMid: PEER_MID,
    from: "2WHVV9V27Z",
    kind: rawJson,
    raw: {
      param1: PEER_MID,
      param2: "2WHVV9V27Z",
      param3: rawJson,
    },
  });
  assertEquals(result, {
    callId: "68A4A1BB-13DC-4361-900C-1F7381C104A4",
    from: PEER_MID,
    kind: "VIDEO",
  });
});

Deno.test("グループ通話や未知のJSONペイロードでも発信者MIDを抽出し生JSONをkindにしない", () => {
  const groupJson = JSON.stringify({
    g: GROUP_MID,
    n: "TOKEN12345",
    vs: "AAA-BBB",
  });
  assertEquals(
    normalizeIncomingCall({
      callMid: "TOKEN12345",
      from: "TOKEN12345",
      kind: groupJson,
    }),
    {
      callId: "AAA-BBB",
      from: GROUP_MID,
      kind: "GROUP",
    },
  );
  assertEquals(
    normalizeIncomingCall({
      callMid: PEER_MID,
      from: "TOKEN12345",
      kind: '{"unknown":true}',
    }),
    {
      callId: "TOKEN12345",
      from: PEER_MID,
      kind: "CALL",
    },
  );
});

Deno.test("通話キャンセルでcallMidとfromが入れ替わっても相手MIDと通話IDを復元する", () => {
  assertEquals(
    normalizeCancelCall({
      callMid: PEER_MID,
      from: "2WHVV9V27Z",
      reason: '{"secret":"drop"}',
      raw: {
        param1: PEER_MID,
        param2: "2WHVV9V27Z",
        param3: '{"secret":"drop"}',
      },
    }),
    {
      callId: "2WHVV9V27Z",
      from: PEER_MID,
      reason: "",
    },
  );
});

Deno.test("handleIncomingCallとhandleCallCancelが正規化済みペイロードを通知する", () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  configureCallRuntime({
    getClient: () => null,
    loadAuthDevice: () => Promise.resolve("ANDROIDSECONDARY"),
    emitEvent: (event, payload = {}) => {
      events.push({ event, payload });
    },
    ok: () => {},
    fail: () => {},
    incomingTimeoutMs: 0,
  });

  const rawJson = JSON.stringify({
    k: "CV",
    n: "2WHVV9V27Z",
    vs: "A3CF92B3-570C-4CD6-B2D7-9C0F5263BBA6",
  });
  handleIncomingCall({
    callMid: PEER_MID,
    from: "2WHVV9V27Z",
    kind: rawJson,
  });
  handleCallCancel({
    callMid: PEER_MID,
    from: "2WHVV9V27Z",
    reason: "CANCELED",
  });
  // 既に終了済みの着信に対する重複キャンセルは再送しない。
  handleCallCancel({
    callMid: PEER_MID,
    from: "2WHVV9V27Z",
    reason: "CANCELED",
  });

  assertEquals(events, [
    {
      event: "call_incoming",
      payload: {
        callId: "A3CF92B3-570C-4CD6-B2D7-9C0F5263BBA6",
        from: PEER_MID,
        kind: "VIDEO",
      },
    },
    {
      event: "call_canceled",
      payload: {
        callId: "2WHVV9V27Z",
        from: PEER_MID,
        reason: "CANCELED",
      },
    },
  ]);
  resetIncomingCall();
});

Deno.test("他端末で応答しPLANETからリモート解放が届いたら即座に着信通知を止める", async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let resolveEnded!: (reason: PlanetEndReason) => void;
  let closedAfterRemote = 0;
  let declined = 0;
  configureCallRuntime({
    getClient: () => null,
    loadAuthDevice: () => Promise.resolve("ANDROIDSECONDARY"),
    emitEvent: (event, payload = {}) => {
      events.push({ event, payload });
    },
    ok: () => {},
    fail: () => {},
    incomingTimeoutMs: 0,
    watchIncomingAudio: () =>
      Promise.resolve({
        ended: new Promise<PlanetEndReason>((resolve) => {
          resolveEnded = resolve;
        }),
        accept: () => Promise.resolve({ mediaReady: true }),
        transport: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          send: () => Promise.resolve(),
          receive: async function* () {},
        },
        decline: () => {
          declined++;
          return Promise.resolve();
        },
        closeAfterRemote: () => {
          closedAfterRemote++;
          return Promise.resolve();
        },
      }),
  });

  const audio = sampleAudio("UUID-REMOTE-ANSWER");
  handleIncomingCall({
    audio,
    callMid: audio.callId,
    from: PEER_MID,
    kind: "AUDIO",
  });
  await Promise.resolve();
  await Promise.resolve();

  resolveEnded({ by: "remote", relCode: 16, releaser: "system" });
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(closedAfterRemote, 1);
  assertEquals(declined, 0);
  assertEquals(events, [
    {
      event: "call_incoming",
      payload: {
        callId: "UUID-REMOTE-ANSWER",
        from: PEER_MID,
        kind: "AUDIO",
      },
    },
    {
      event: "call_canceled",
      payload: {
        callId: "UUID-REMOTE-ANSWER",
        from: PEER_MID,
        reason: "handled_elsewhere",
      },
    },
  ]);
  resetIncomingCall();
});

Deno.test("VERIFY拒否や通話履歴メッセージ・タイムアウトでも着信を止め、他端末通話を誤切断しない", async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  configureCallRuntime({
    getClient: () => null,
    loadAuthDevice: () => Promise.resolve("ANDROIDSECONDARY"),
    emitEvent: (event, payload = {}) => {
      events.push({ event, payload });
    },
    ok: () => {},
    fail: () => {},
    incomingTimeoutMs: 0,
    watchIncomingAudio: () =>
      Promise.reject(new Error("incoming VERIFY rejected")),
  });

  const audio = sampleAudio("UUID-ALREADY-ANSWERED");
  handleIncomingCall({
    audio,
    callMid: audio.callId,
    from: PEER_MID,
    kind: "AUDIO",
  });
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(events[1], {
    event: "call_canceled",
    payload: {
      callId: "UUID-ALREADY-ANSWERED",
      from: PEER_MID,
      reason: "handled_elsewhere",
    },
  });

  // ビデオ通話など PLANET 監視なしでも CALL 履歴メッセージで着信が閉じる
  events.length = 0;
  handleIncomingCall({
    callMid: PEER_MID,
    from: "2WHVV9V27Z",
    kind: JSON.stringify({ k: "CV", n: "2WHVV9V27Z", vs: "UUID-VIDEO-1" }),
  });
  handleCallMessage(OTHER_MID);
  assertEquals(events.length, 1);
  handleCallMessage(PEER_MID);
  assertEquals(events[1], {
    event: "call_canceled",
    payload: {
      callId: "UUID-VIDEO-1",
      from: PEER_MID,
      reason: "handled_elsewhere",
    },
  });

  // タイムアウト時は通知だけ止め、検証済みセッションへ REL_REQ (decline) を送らない
  events.length = 0;
  let declined = 0;
  configureCallRuntime({
    getClient: () => null,
    loadAuthDevice: () => Promise.resolve("ANDROIDSECONDARY"),
    emitEvent: (event, payload = {}) => {
      events.push({ event, payload });
    },
    ok: () => {},
    fail: () => {},
    incomingTimeoutMs: 15,
    watchIncomingAudio: () =>
      Promise.resolve({
        ended: new Promise<PlanetEndReason>(() => {}),
        accept: () => Promise.resolve({ mediaReady: true }),
        transport: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          send: () => Promise.resolve(),
          receive: async function* () {},
        },
        decline: () => {
          declined++;
          return Promise.resolve();
        },
        closeAfterRemote: () => Promise.resolve(),
      }),
  });
  const timedAudio = sampleAudio("UUID-TIMEOUT");
  handleIncomingCall({
    audio: timedAudio,
    callMid: timedAudio.callId,
    from: PEER_MID,
    kind: "AUDIO",
  });
  await new Promise((r) => setTimeout(r, 40));

  assertEquals(declined, 0);
  assertEquals(events[1], {
    event: "call_canceled",
    payload: {
      callId: "UUID-TIMEOUT",
      from: PEER_MID,
      reason: "timeout",
    },
  });
  resetIncomingCall();
});
