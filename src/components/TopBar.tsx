import React, { useEffect, useRef, useState } from 'react';
import { Lock, Menu, Moon, Plus, Search, Sparkles, Sun, Unlock, X } from 'lucide-react';
import { visibleNavItems, navLabelForRoute, type NavItem } from '../app/navigation';
import type { FeatureFlags } from '../lib/features';
import type { RouteName } from '../app/routes';

export interface TopBarProps {
  routeName: RouteName;
  /** Page title, already resolved from the route. */
  title: string;
  onNavigate: (path: string) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSearch: () => void;
  onOpenAiIngest: () => void;
  onOpenAddModal: () => void;
  onOpenMasterKeyModal: () => void;
  isUnlocked: boolean;
  onLockVault: () => void;
  features?: Partial<FeatureFlags>;
  inboxCount: number;
}

/**
 * Top bar (P1-01).
 *
 * The old header and the old sidebar each rendered search, AI-ingest, new and
 * settings — two visible copies of the same four actions competing for
 * attention. The header keeps exactly one copy of each global action; the
 * sidebar keeps navigation. On narrow screens the header also carries the
 * navigation, but it reads the same registry, so the two can no longer disagree
 * about what exists.
 */
export const TopBar: React.FC<TopBarProps> = ({
  routeName,
  title,
  onNavigate,
  theme,
  onToggleTheme,
  onOpenSearch,
  onOpenAiIngest,
  onOpenAddModal,
  onOpenMasterKeyModal,
  isUnlocked,
  onLockVault,
  features,
  inboxCount
}) => {
  const [navOpen, setNavOpen] = useState(false);
  const items = visibleNavItems(features);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Mobile nav is a dialog: focus it on open, close on Escape, give focus back
  // to the hamburger on close.
  useEffect(() => {
    if (!navOpen) return;
    menuPanelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navOpen]);

  const closeMobileNav = () => {
    setNavOpen(false);
    menuTriggerRef.current?.focus();
  };

  const renderMobileEntry = (item: NavItem) => (
    <button
      key={item.id}
      onClick={() => {
        onNavigate(item.route);
        setNavOpen(false);
      }}
      className="w-full px-3 py-2.5 rounded-xl text-xs font-medium flex items-center justify-between text-sh-fg hover:bg-sh-surface2"
    >
      <span className="flex items-center gap-2.5">
        <item.icon className="w-4 h-4 text-sh-muted" aria-hidden />
        <span>{item.label}</span>
      </span>
    </button>
  );

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-sh-line bg-sh-bg/90 backdrop-blur-md shrink-0">
        <div className="px-3 sm:px-5 h-14 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              ref={menuTriggerRef}
              onClick={() => setNavOpen(true)}
              className="md:hidden p-2 rounded-lg border border-sh-line text-sh-muted hover:text-sh-fg sh-tap"
              aria-label="打开导航"
              aria-expanded={navOpen}
              data-testid="mobile-nav-toggle"
            >
              <Menu className="w-4 h-4" />
            </button>
            <h1 className="text-sm font-semibold text-sh-fg truncate" data-testid="page-title">
              {title}
            </h1>
          </div>

          {/* Exactly one set of global actions. */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {routeName !== 'home' && <button
              onClick={onOpenSearch}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sh-surface2 border border-sh-line text-xs text-sh-muted hover:text-sh-fg hover:border-sh-line-strong transition-colors sh-tap"
              title="搜索所有内容 (Ctrl+K)"
              data-testid="global-search-trigger"
            >
              <Search className="w-3.5 h-3.5 shrink-0" aria-hidden />
              <span className="hidden sm:inline whitespace-nowrap">搜索</span>
              <kbd className="hidden md:inline-block px-1 py-0.5 text-[9px] font-mono bg-sh-bg rounded text-sh-subtle border border-sh-line">
                Ctrl+K
              </kbd>
            </button>}

            <button
              onClick={onOpenAiIngest}
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sh-surface2 border border-sh-line text-xs text-sh-muted hover:text-sh-fg transition-colors sh-tap"
              title="批量导入向导：用本地规则或已启用的云端 AI 把杂乱内容整理入库（粘贴识别在快捷导航页）"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">AI 批量导入</span>
            </button>

            <button
              onClick={onOpenAddModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg font-semibold text-xs hover:opacity-90 transition-opacity sh-tap"
              title="新建网站、笔记、服务器、凭证或其他条目"
              data-testid="global-new"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">新建</span>
            </button>

            <button
              onClick={onToggleTheme}
              className="p-2 rounded-lg border border-sh-line text-sh-muted hover:text-sh-fg transition-colors sh-tap"
              title={theme === 'dark' ? '切换为明亮主题' : '切换为暗色主题'}
              aria-label={theme === 'dark' ? '切换为明亮主题' : '切换为暗色主题'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" aria-hidden /> : <Moon className="w-4 h-4" aria-hidden />}
            </button>

          </div>
        </div>
      </header>

      {navOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 p-4"
          style={{ background: 'var(--sh-overlay)' }}
          onClick={closeMobileNav}
        >
          <div
            ref={menuPanelRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="bg-sh-surface border border-sh-line rounded-2xl p-3 space-y-1 max-h-[80vh] overflow-y-auto focus:outline-none"
            role="dialog"
            aria-modal="true"
            aria-label="导航"
          >
            <div className="flex items-center justify-between px-2 pb-2 border-b border-sh-line">
              <span className="text-xs font-semibold text-sh-muted">导航</span>
              <button onClick={closeMobileNav} aria-label="关闭导航" className="p-1 text-sh-subtle">
                <X className="w-4 h-4" />
              </button>
            </div>
            {items.map((item) => (
              <React.Fragment key={item.id}>
                {!item.children?.length && renderMobileEntry(item)}
                {item.children?.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => {
                      onNavigate(child.route);
                      closeMobileNav();
                    }}
                    className="sh-tap w-full px-3 py-2 rounded-xl text-sm text-sh-muted hover:text-sh-fg hover:bg-sh-surface2 flex items-center gap-2.5"
                  >
                    <child.icon className="w-3.5 h-3.5" aria-hidden />
                    {child.label}
                  </button>
                ))}
              </React.Fragment>
            ))}
            <button onClick={() => { setNavOpen(false); onOpenAiIngest(); }}
              className="sh-tap w-full px-3 py-2 border-t border-sh-line text-sm text-sh-muted flex items-center gap-2.5">
              <Sparkles className="w-4 h-4" aria-hidden />整理内容
            </button>
            <button onClick={() => { setNavOpen(false); isUnlocked ? onLockVault() : onOpenMasterKeyModal(); }}
              className="sh-tap w-full px-3 py-2 text-sm text-sh-muted flex items-center gap-2.5">
              {isUnlocked ? <Unlock className="w-4 h-4" aria-hidden /> : <Lock className="w-4 h-4" aria-hidden />}
              {isUnlocked ? '锁定金库' : '解锁金库'}
            </button>
            <button
              onClick={() => {
                onNavigate('#/settings/overview');
                closeMobileNav();
              }}
              className="w-full px-3 py-2.5 rounded-xl text-xs font-medium text-sh-muted hover:text-sh-fg hover:bg-sh-surface2 text-left"
            >
              设置
            </button>
            {routeName !== 'inbox' && inboxCount > 0 && (
              <p className="px-3 pt-1 text-[11px] text-sh-subtle">收件箱有 {inboxCount} 条待整理</p>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export { navLabelForRoute };
export default TopBar;
