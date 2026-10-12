import {PublicError} from "./oauth.mjs";

export function validateSessionId(value) {
  if(typeof value!=="string"||!value.length||value.length>256||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))throw new PublicError(400,"invalid_session_id","session_id 必须是 1–256 字符的非空字符串，不能包含控制字符或首尾空格。");
  return value;
}

export function sessionIdFromRequest(body) {
  return Object.hasOwn(body,"session_id")?validateSessionId(body.session_id):null;
}
