import React from 'react';
import { Database, FileText, Highlighter } from 'lucide-react';
import { buildRoute } from '../../app/routes';

export interface LibraryTabsProps {
  /** Which pane is showing. */
  active: 'notes' | 'annotations' | 'sources';
  onNavigate: (path: string) => void;
}

/** Mobile pane shortcuts; desktop already exposes these destinations in the sidebar. */
export const LibraryTabs: React.FC<LibraryTabsProps> = ({ active, onNavigate }) => {
  const tabs = [
    { id: 'notes' as const, label: '笔记', icon: FileText, path: `${buildRoute('library')}?view=notes` },
    {
      id: 'sources' as const,
      label: '远端笔记',
      icon: Database,
      path: `${buildRoute('library')}?view=sources`
    },
    {
      id: 'annotations' as const,
      label: '网页批注',
      icon: Highlighter,
      path: `${buildRoute('library')}?type=webpage`
    }
  ];
  return (
    <div className="md:hidden flex flex-wrap items-center gap-1.5 mb-3" role="tablist" aria-label="资料库视图">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onNavigate(tab.path)}
          data-library-tab={tab.id}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border whitespace-nowrap transition-colors sh-tap ${
            active === tab.id
              ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg font-medium'
              : 'border-sh-line text-sh-muted hover:text-sh-fg'
          }`}
        >
          <tab.icon className="w-3.5 h-3.5" aria-hidden />
          {tab.label}
        </button>
      ))}
    </div>
  );
};

export default LibraryTabs;
