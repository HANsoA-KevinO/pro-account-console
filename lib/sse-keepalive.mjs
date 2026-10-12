export function keepStreamAlive(res,intervalMs){
  if(!intervalMs)return;
  const pulse=()=>{
    if(res.destroyed||res.writableEnded)return cleanup();
    if(!res.headersSent){
      res.gatewayStreaming=true;
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store, no-transform","x-accel-buffering":"no"});
      res.flushHeaders?.();
    }
    if(!res.writableNeedDrain)res.write(": gateway keepalive\n\n");
  };
  const timer=setInterval(pulse,intervalMs);timer.unref();
  const cleanup=()=>{clearInterval(timer);res.off("close",cleanup);res.off("finish",cleanup);};
  res.on("close",cleanup);res.on("finish",cleanup);
}
