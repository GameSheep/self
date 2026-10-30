import React from 'react';
import type { NavSite } from '../../types';
import { SiteIcon } from '../../components/SiteIcon';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || '';
  }
}

/**
 * "New tab page" style tile: a real favicon first, colored initial as fallback.
 *
 * Icon derivation lives in the shared <SiteIcon> (see its doc comment): the
 * favicon request goes to the site itself only — no third-party icon service —
 * so the home page never leaks the bookmark list to anyone else.
 */
export const HomeSiteTile: React.FC<{ site: NavSite; onVisit: (id: string) => void }> = ({ site, onVisit }) => {
  const hostname = hostnameOf(site.url);

  return (
    <a
      href={site.url}
      target="_blank"
      rel="noreferrer"
      onClick={() => onVisit(site.id)}
      data-site-card={site.id}
      title={`${site.title}\n${site.url}`}
      className="group flex flex-col items-center gap-2 rounded-xl border border-sh-line bg-sh-surface2/60 px-2 py-3 hover:border-sh-line-strong hover:bg-sh-surface2 transition-colors sh-tap"
    >
      <span className="transition-transform group-hover:scale-110">
        <SiteIcon url={site.url} title={site.title} size={40} rounded="xl" />
      </span>
      <span className="w-full text-center text-xs text-sh-fg truncate">{site.title || hostname}</span>
    </a>
  );
};
