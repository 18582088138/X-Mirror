import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";

export function createNetworkRequest(env) {
  const explicitProxy = env.XMAX_PROXY_URL?.trim();
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy ?? "";
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy ?? "";
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  const dispatcher = explicitProxy
    ? new ProxyAgent(explicitProxy)
    : httpProxy || httpsProxy
      ? new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy })
      : undefined;
  return {
    proxyEnabled: Boolean(dispatcher),
    request: dispatcher
      ? (url, options) => undiciFetch(url, { ...options, dispatcher })
      : fetch,
    close: () => dispatcher?.close(),
  };
}
