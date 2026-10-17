/**
 * Server actions, including the real health probing.
 *
 * The probing used to sit inline in App together with the `checking` state
 * transitions; keeping it in its own hook means the "never claim online without
 * a probe" rule lives in exactly one place.
 */
import { useCallback, useRef } from 'react';
import { HubState, ServerDeployment } from '../types';
import { checkServerHealth, checkServersHealth } from '../lib/serverHealth';
import type { StateUpdater } from './useSiteActions';

export function useServerActions(state: HubState, updateState: StateUpdater) {
  const stateRef = useRef(state);
  stateRef.current = state;

  const addServer = useCallback(
    (server: ServerDeployment) => {
      updateState((prev) => ({ ...prev, servers: [server, ...prev.servers] }));
    },
    [updateState]
  );

  const deleteServer = useCallback(
    (id: string) => {
      updateState((prev) => ({ ...prev, servers: prev.servers.filter((s) => s.id !== id) }));
    },
    [updateState]
  );

  const applyResult = (id: string, result: Awaited<ReturnType<typeof checkServerHealth>>) => {
    updateState((prev) => ({
      ...prev,
      servers: prev.servers.map((s) =>
        s.id === id
          ? {
              ...s,
              status: result.state,
              lastCheckedAt: result.checkedAt,
              lastCheckMessage: result.message,
              lastLatencyMs: result.latencyMs
            }
          : s
      )
    }));
  };

  /** Probe one server and store the real result (never assume "online"). */
  const checkServer = useCallback(
    async (id: string) => {
      const server = stateRef.current.servers.find((s) => s.id === id);
      if (!server) return;
      updateState((prev) => ({
        ...prev,
        servers: prev.servers.map((s) => (s.id === id ? { ...s, status: 'checking' } : s))
      }));
      applyResult(id, await checkServerHealth(server));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateState]
  );

  const checkAllServers = useCallback(async () => {
    const targets = stateRef.current.servers;
    if (targets.length === 0) return;
    updateState((prev) => ({ ...prev, servers: prev.servers.map((s) => ({ ...s, status: 'checking' })) }));

    const results = await checkServersHealth(targets);
    updateState((prev) => ({
      ...prev,
      servers: prev.servers.map((s) => {
        const r = results[s.id];
        if (!r) return s;
        return {
          ...s,
          status: r.state,
          lastCheckedAt: r.checkedAt,
          lastCheckMessage: r.message,
          lastLatencyMs: r.latencyMs
        };
      })
    }));
  }, [updateState]);

  return { addServer, deleteServer, checkServer, checkAllServers };
}
