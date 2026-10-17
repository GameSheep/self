/**
 * Server health probing.
 *
 * The UI used to hardcode `status: 'online'` when a server was created, so the
 * dashboard's "N/M 运行中" was pure fiction. A browser cannot open raw TCP
 * sockets, so the only honest signal is an HTTP(S) probe of a URL the user
 * provides. When there is nothing to probe we say so instead of claiming "online".
 */
import { ServerDeployment } from '../types';

export type HealthState = 'online' | 'offline' | 'unknown' | 'checking';

export interface HealthResult {
  state: HealthState;
  /** Human-readable explanation shown on the card. */
  message: string;
  latencyMs?: number;
  statusCode?: number;
  checkedAt: number;
}

const PROBE_TIMEOUT_MS = 8000;

/** Derive a probeable URL from the server record, or null when we cannot probe. */
export function probeUrlFor(server: ServerDeployment): { url: string; source: 'healthUrl' | 'domain' | 'ip-port' } | null {
  if (server.healthUrl && /^https?:\/\//i.test(server.healthUrl)) {
    return { url: server.healthUrl, source: 'healthUrl' };
  }
  if (server.domain) {
    const host = server.domain.replace(/^https?:\/\//i, '');
    return { url: `https://${host}`, source: 'domain' };
  }
  // An IP + port only tells us where SSH lives; browsers cannot probe it.
  return null;
}

/**
 * Probe a server.
 *
 * `mode: 'no-cors'` is used as a fallback: the response is opaque (status 0) but
 * a resolved promise still proves something answered on that host/port, while a
 * rejection means DNS/TLS/connection failed.
 */
export async function checkServerHealth(server: ServerDeployment): Promise<HealthResult> {
  const target = probeUrlFor(server);
  const checkedAt = Date.now();

  if (!target) {
    return {
      state: 'unknown',
      checkedAt,
      message: '没有可用于探测的地址（浏览器无法直连 SSH 端口）。可在服务器信息里填「健康检查 URL」或绑定域名。'
    };
  }

  const started = Date.now();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;

  try {
    const res = await fetch(target.url, {
      method: 'GET',
      mode: 'cors',
      redirect: 'follow',
      signal: controller?.signal,
      cache: 'no-store'
    });
    const latencyMs = Date.now() - started;
    if (res.ok || res.status === 401 || res.status === 403) {
      // 401/403 still proves the service is up and reachable.
      return {
        state: 'online',
        checkedAt,
        latencyMs,
        statusCode: res.status,
        message: `HTTP ${res.status} · ${latencyMs}ms`
      };
    }
    return {
      state: 'offline',
      checkedAt,
      latencyMs,
      statusCode: res.status,
      message: `HTTP ${res.status} ${res.statusText || ''}`.trim()
    };
  } catch (err: any) {
    // CORS blocks reading the response but the host still answered; retry opaque.
    const aborted = err?.name === 'AbortError';
    if (aborted) {
      return { state: 'offline', checkedAt, message: `超时（>${PROBE_TIMEOUT_MS / 1000}s）` };
    }

    try {
      const startedOpaque = Date.now();
      await fetch(target.url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
      const latencyMs = Date.now() - startedOpaque;
      return {
        state: 'online',
        checkedAt,
        latencyMs,
        message: `可达 · ${latencyMs}ms（跨域被拦截，无法读取状态码）`
      };
    } catch {
      return {
        state: 'offline',
        checkedAt,
        message: '无法连接（DNS / TLS / 端口不可达）'
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe many servers with bounded concurrency. */
export async function checkServersHealth(
  servers: ServerDeployment[],
  concurrency = 4
): Promise<Record<string, HealthResult>> {
  const out: Record<string, HealthResult> = {};
  let cursor = 0;

  const worker = async () => {
    while (cursor < servers.length) {
      const server = servers[cursor++];
      out[server.id] = await checkServerHealth(server);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

/** Short label + tone for the status pill. */
export function healthPresentation(state: HealthState): { label: string; tone: 'ok' | 'bad' | 'idle' | 'busy' } {
  switch (state) {
    case 'online':
      return { label: '在线', tone: 'ok' };
    case 'offline':
      return { label: '不可达', tone: 'bad' };
    case 'checking':
      return { label: '检测中', tone: 'busy' };
    default:
      return { label: '未探测', tone: 'idle' };
  }
}
