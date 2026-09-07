import WebSocket from "ws";

import { packAuthTicket } from "../../js/network.js";

function cookiePair(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

export async function requestMatchAdmission(origin, { cookie = "", headers = {} } = {}) {
  const response = await fetch(`${origin}/api/potspark/match-ticket`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Potspark-Request": "1",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: "{}",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Match admission failed (${response.status})`);
  return {
    ticket: payload.ticket,
    cookie: cookie || cookiePair(response.headers.get("set-cookie")),
    payload,
  };
}

export async function createAuthenticatedSocket(webSocketUrl, origin, headers = {}, cookie = "") {
  const admission = await requestMatchAdmission(origin, { cookie, headers });
  const ws = new WebSocket(webSocketUrl, {
    origin,
    headers: {
      ...headers,
      Cookie: admission.cookie,
    },
  });
  ws.once("open", () => ws.send(packAuthTicket(admission.ticket)));
  return { ws, ...admission };
}
