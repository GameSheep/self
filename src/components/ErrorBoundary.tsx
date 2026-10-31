import React from 'react';
import { AlertTriangle, RefreshCw, Download, Trash2 } from 'lucide-react';
import { getStorageKey } from '../lib/storage';

interface Props {
  children: React.ReactNode;
  /** Small label shown in the fallback, e.g. the active view name. */
  scope?: string;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Last line of defence: without this, any render error (e.g. a restored backup
 * missing a collection) unmounts the whole tree and the user sees a blank page
 * with no way to recover other than devtools.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Self-Hub] render error caught by ErrorBoundary', error, info);
    this.setState({ info: info.componentStack || '' });
  }

  private reload = () => {
    window.location.reload();
  };

  private exportRaw = () => {
    try {
      const raw = localStorage.getItem(getStorageKey()) || '{}';
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `self-hub-rescue-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`导出失败: ${(err as Error)?.message || err}`);
    }
  };

  private resetAll = () => {
    if (!confirm('这会清空浏览器本地保存的全部 Self-Hub 数据（含金库凭据密文）并重置为出厂状态，且不可撤销。确定继续？')) {
      return;
    }
    const wipeStores = async () => {
      try {
        localStorage.clear();
        sessionStorage.clear();
        if (indexedDB?.databases) {
          // Deletion is async and aborted by navigation — reload only after
          // every database reports closed, or the v3 library survives the
          // "factory reset" intact.
          const dbs = await indexedDB.databases();
          await Promise.all(dbs.filter((d) => d.name).map((d) => {
            return new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(d.name!);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            });
          }));
        }
      } catch {
        // ignore: the reload below still resets the storage-backed UI state
      }
      window.location.reload();
    };
    void wipeStores();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-sh-bg text-sh-fg flex items-center justify-center p-6">
        <div className="max-w-2xl w-full bg-sh-surface border border-sh-danger/50 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-sh-danger">
            <AlertTriangle className="w-5 h-5" />
            <h1 className="text-base font-semibold">
              界面渲染出错{this.props.scope ? ` · ${this.props.scope}` : ''}
            </h1>
          </div>
          <p className="text-xs text-sh-muted leading-relaxed">
            你的数据仍然保存在浏览器本地，没有丢失。可以先重新加载；如果反复出错，请先导出原始数据再重置。
          </p>
          <pre className="text-[11px] font-mono text-sh-danger bg-sh-bg border border-sh-danger/50 rounded-xl p-3 overflow-auto max-h-48 whitespace-pre-wrap">
            {this.state.error.message}
            {this.state.info ? `\n${this.state.info.slice(0, 800)}` : ''}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={this.reload}
              className="px-4 py-2 rounded-xl bg-sh-accent text-sh-accent-fg text-xs font-semibold flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重新加载
            </button>
            <button
              onClick={this.exportRaw}
              className="px-4 py-2 rounded-xl bg-sh-surface2 border border-sh-line text-sh-muted text-xs flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              导出原始数据
            </button>
            <button
              onClick={this.resetAll}
              className="px-4 py-2 rounded-xl bg-sh-danger/10 border border-sh-danger/50 text-sh-danger text-xs flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              清空并重置
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
