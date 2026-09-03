import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";

export function configureNetworkProxy(): string | undefined {
  let proxy = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
  if (!proxy && process.platform === "darwin") {
    try {
      const output = execFileSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 3_000 });
      const enabled = /HTTPSEnable\s*:\s*1/.test(output);
      const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (enabled && host && port) proxy = `http://${host}:${port}`;
    } catch { /* direct network remains available */ }
  }
  if (!proxy) return undefined;
  setGlobalDispatcher(new ProxyAgent(proxy));
  return proxy;
}
