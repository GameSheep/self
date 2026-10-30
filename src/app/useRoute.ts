/**
 * Route state for the shell (P1-01).
 *
 * A tiny subscription instead of a router library: the workspace only needs
 * "what is the current route" plus "go there". Keeping it in one hook means
 * browser back/forward, in-app links and the settings deep links all agree.
 */
import { useCallback, useEffect, useState } from 'react';
import { currentRoute, navigate, type Route } from './routes';

export interface UseRouteResult {
  route: Route;
  /** Push a new history entry (a real navigation the user can go back from). */
  go: (path: string) => void;
  /** Replace the current entry (filter changes, section switches). */
  replace: (path: string) => void;
  canGoBack: boolean;
}

export function useRoute(): UseRouteResult {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    const onChange = () => {
      setRoute(currentRoute());
      setDepth((d) => d + 1);
    };
    window.addEventListener('hashchange', onChange);
    // Normalise a bare "/" or an old `#dashboard` style link on first paint.
    if (!window.location.hash || window.location.hash === '#') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/home`);
      setRoute(currentRoute());
    }
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((path: string) => navigate(path, false), []);
  const replace = useCallback((path: string) => navigate(path, true), []);

  return { route, go, replace, canGoBack: depth > 0 };
}
