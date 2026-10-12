import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";

const runtime=new Miniflare(convertV4MiniflareOptions({
  modules:[
    {type:"ESModule",path:fileURLToPath(new URL("../../deploy/cloudflare/worker.mjs",import.meta.url))},
    {type:"ESModule",path:fileURLToPath(new URL("../../deploy/cloudflare/state.mjs",import.meta.url))},
  ],
  compatibilityDate:"2026-10-12",host:"127.0.0.1",port:0,
  // Miniflare currently models global SQLite owners. Jurisdiction routing is
  // checked separately; the deployed service verifies its actual US ID.
  bindings:{GATEWAY_STATE_SECRET:createHash("sha256").update("cloudflare-state-test-fixture").digest("base64url")},
  durableObjects:{STATE:{className:"GatewayState",useSQLite:true},GATEWAY:{className:"GatewayContainer",useSQLite:true}},
  durableObjectsPersist:process.argv[2],
}));
const url=await runtime.ready;console.log(JSON.stringify({url:url.origin}));
process.on("SIGTERM",()=>runtime.dispose().then(()=>process.exit(0)));
