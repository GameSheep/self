import React, { useEffect, useMemo, useState } from 'react';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || '';
  }
}

/** Deterministic per-hostname hue, shared by every icon fallback in the app. */
export function siteHue(url: string): number {
  const hostname = hostnameOf(url);
  let h = 0;
  for (let i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) % 360;
  return h;
}

interface SiteIconProps {
  /** The site URL; the icon is derived from its origin, never stored manually. */
  url: string;
  /** Fallback letter source (usually the site title). */
  title?: string;
  /** Box size in px. Default 32. */
  size?: number;
  className?: string;
  /** Rendered as a plain block (default) or a square tile with rounded corners. */
  rounded?: 'md' | 'lg' | 'xl';
  'data-testid'?: string;
}

/**
 * Auto-recognized site icon, derived purely from the URL.
 * How the "recognition" works: an <img> pointing at the site's own
 * `{origin}/favicon.ico` makes the *browser* fetch it — no parsing of the site's
 * · service, so the bookmark list is never leaked anywhere. When the site has no
 */
export const SiteIcon: React.FC<SiteIconProps> = ({
  url,
  title,
  size = 32,
  className = '',
  rounded = 'lg',
  'data-testid': testId
}) => {
  const [iconFailed, setIconFailed] = useState(false);

  // A corrected URL should retry the favicon immediately, not stay on the fallback.
  useEffect(() => {
    setIconFailed(false);
  }, [url]);

  const hostname = hostnameOf(url);
  const hue = useMemo(() => siteHue(url), [url]);
  const initial = (title || hostname || '?').trim().charAt(0).toUpperCase() || '?';

  let faviconUrl = '';
  try {
    if (url.trim()) {
      const base = url.startsWith('http') ? url : `https://${url}`;
      // Chromium silently cancels subresource requests whose URL path ends in a bare
      // `/favicon.ico` (img AND fetch, no network round-trip) — reserving that exact
      // request for its own favicon machinery. A query suffix makes the URL a normal
      // image request again; `?s=1` also acts as a light cache-buster.
      faviconUrl = new URL('/favicon.ico?s=1', base).href;
    }
  } catch {
    faviconUrl = '';
  }

  const radius = rounded === 'xl' ? 'rounded-xl' : rounded === 'lg' ? 'rounded-lg' : 'rounded-md';
  const box = { width: size, height: size };

  if (faviconUrl && !iconFailed) {
    return (
      <img
        src={faviconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setIconFailed(true)}
        data-testid={testId}
        data-site-icon-src={faviconUrl}
        style={{ ...box, backgroundColor: `hsl(${hue} 25% 55%)` }}
        className={`object-contain border border-sh-line shrink-0 ${radius} ${className}`}
      />
    );
  }

  return (
    <span
      data-testid={testId}
      data-site-icon-fallback="initial"
      style={{ ...box, backgroundColor: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 75% 75%)` }}
      className={`border border-sh-line flex items-center justify-center font-bold shrink-0 ${radius} ${className}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
};

export default SiteIcon;
