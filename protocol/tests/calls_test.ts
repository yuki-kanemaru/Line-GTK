import { assertEquals } from "@std/assert";
import {
  configureCallRuntime,
  handleCallCancel,
  handleIncomingCall,
  normalizeCancelCall,
  normalizeIncomingCall,
} from "../src/calls.ts";

const PEER_MID = "ubdd716f5b629aebc43caa2edd7505591";
const GROUP_MID = "c4cb2ea1bc2ca922853d2bde760f6d16b";

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
});
