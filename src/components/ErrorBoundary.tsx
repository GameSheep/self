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
    try {
      localStorage.clear();
      sessionStorage.clear();
      if (indexedDB?.databases) {
        indexedDB.databases().then((dbs) => dbs.forEach((d) => d.name && indexedDB.deleteDatabase(d.name)));
      }
    } catch {}
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-[#090a0c] text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full bg-[#121316] border border-red-900/50 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <h1 className="text-base font-semibold">
              界面渲染出错{this.props.scope ? ` · ${this.props.scope}` : ''}
            </h1>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            你的数据仍然保存在浏览器本地，没有丢失。可以先重新加载；如果反复出错，请先导出原始数据再重置。
          </p>
          <pre className="text-[11px] font-mono text-red-300 bg-black/40 border border-red-900/40 rounded-xl p-3 overflow-auto max-h-48 whitespace-pre-wrap">
            {this.state.error.message}
            {this.state.info ? `\n${this.state.info.slice(0, 800)}` : ''}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={this.reload}
              className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 text-xs font-semibold flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重新加载
            </button>
            <button
              onClick={this.exportRaw}
              className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              导出原始数据
            </button>
            <button
              onClick={this.resetAll}
              className="px-4 py-2 rounded-xl bg-red-950/40 border border-red-800/40 text-red-400 text-xs flex items-center gap-1.5"
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
