import {networkInterfaces} from "node:os";
import {randomBytes} from "node:crypto";
import path from "node:path";
import {readJson,writeJson} from "./storage.mjs";
import {safeEqual} from "./oauth.mjs";

export function isPrivateIPv4(address) {
  if(typeof address!=="string"||!/^\d+\.\d+\.\d+\.\d+$/.test(address))return false;
  const parts=address.split(".").map(Number);
  if(parts.some(value=>value>255))return false;
  return parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168);
}

export function discoverLanAddress(interfaces=networkInterfaces()) {
  const entries=Object.entries(interfaces).sort(([a],[b])=>Number(b==="en0")-Number(a==="en0"));
  for(const[,addresses]of entries)for(const address of addresses??[])if(!address.internal&&address.family==="IPv4"&&isPrivateIPv4(address.address))return address.address;
  throw new Error("未找到局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络。");
}

export function validateLanAuth(auth) {
  if(!auth||typeof auth.username!=="string"||!/^[-\w]{1,64}$/.test(auth.username)||typeof auth.password!=="string"||!auth.password.length||auth.password.length>1024||/[\r\n]/.test(auth.password))throw new Error("内网管理凭据无效：用户名应为字母、数字、下划线或短横线，密码不能为空或包含换行。");
  return auth;
}

export async function loadLanAuth(directory) {
  const file=path.join(directory,"lan-admin.json");
  let auth=await readJson(file);
  if(!auth){auth={username:"admin",password:randomBytes(24).toString("base64url")};await writeJson(file,auth);}
  return validateLanAuth(auth);
}

export async function readLanAuth(directory) {
  return validateLanAuth(await readJson(path.join(directory,"lan-admin.json")));
}

export function acceptsBasicAuth(header,auth) {
  if(typeof header!=="string"||!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header))return false;
  const decoded=Buffer.from(header.slice(6),"base64").toString("utf8"),separator=decoded.indexOf(":");
  if(separator<0)return false;
  const usernameMatches=safeEqual(decoded.slice(0,separator),auth.username);
  const passwordMatches=safeEqual(decoded.slice(separator+1),auth.password);
  return usernameMatches&&passwordMatches;
}
