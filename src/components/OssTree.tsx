import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  File,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  FolderInput,
  Trash2,
  RotateCcw
} from 'lucide-react';
import { OssTreeNode, filterOssTree, collectDirPaths } from '../lib/s3Client';

interface OssTreeProps {
  root: OssTreeNode;
  searchTerm: string;
  selectedKey?: string;
  onSelectFile: (node: OssTreeNode) => void;
  /** Rendered per-folder before "show more" kicks in. */
  pageSize?: number;
  /** Extra file keys to treat as matches (e.g. tag hits found in loaded note bodies). */
  extraMatchKeys?: Set<string>;
  /** Row actions; omitted actions are not rendered. */
  onRename?: (node: OssTreeNode) => void;
  onMove?: (node: OssTreeNode) => void;
  onDelete?: (node: OssTreeNode) => void;
  /** Restore an object that lives in the trash back to its original path. */
  onRestore?: (node: OssTreeNode) => void;
  /** Which nodes offer the restore action. */
  canRestore?: (node: OssTreeNode) => boolean;
  /** Directory paths to expand on load (e.g. the configured vault prefix). */
  initialExpanded?: string[];
}

const EDITABLE_EXT = ['.md', '.markdown', '.txt'];

export function isEditableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return EDITABLE_EXT.some((ext) => lower.endsWith(ext));
}

export function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name);
}

function fileIcon(name: string) {
  const lower = name.toLowerCase();
  if (isEditableFile(name)) return <FileText className="w-3.5 h-3.5 shrink-0 text-sh-focus" />;
  if (isImageFile(lower)) return <ImageIcon className="w-3.5 h-3.5 shrink-0 text-sh-info" />;
  return <File className="w-3.5 h-3.5 shrink-0 text-sh-subtle" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Tree view over the whole OSS bucket.
 * The previous UI showed a flat list of the first 200 objects under a single
 */
export const OssTree: React.FC<OssTreeProps> = ({
  root,
  searchTerm,
  selectedKey,
  onSelectFile,
  pageSize = 100,
  extraMatchKeys,
  onRename,
  onMove,
  onDelete,
  onRestore,
  canRestore,
  initialExpanded
}) => {
  const searching = searchTerm.trim().length > 0;

  const visibleChildren = useMemo(() => {
    if (!searching) return root.children;
    // `extraMatchKeys` carries content matches (e.g. a #tag found in a loaded note).
    return filterOssTree(root.children, searchTerm, extraMatchKeys);
  }, [root, searchTerm, searching, extraMatchKeys]);

  // While searching, every folder in the pruned tree is expanded automatically.
  const searchExpanded = useMemo(
    () => (searching ? new Set(collectDirPaths(visibleChildren)) : new Set<string>()),
    [searching, visibleChildren]
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [limits, setLimits] = useState<Record<string, number>>({});

  // Expand the vault prefix (and a lone root folder) so the user lands on
  // content instead of a closed folder. Explicit paths beat guessing: once a
  // `.trash/` folder exists there are two roots and a heuristic fails.
  React.useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of initialExpanded || []) {
        const normalized = path.endsWith('/') ? path : `${path}/`;
        if (normalized) next.add(normalized);
      }
      if (root.children.length === 1 && root.children[0].isDir) {
        next.add(root.children[0].path);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [root, initialExpanded]);

  const isExpanded = (path: string) => (searching ? true : expanded.has(path));

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: OssTreeNode[], depth: number): React.ReactNode => {
    const limit = searching ? Number.MAX_SAFE_INTEGER : undefined;

    /** Hover actions shared by files and folders. */
    const rowActions = (node: OssTreeNode) => {
      const restorable = Boolean(onRestore && canRestore?.(node));
      if (!onRename && !onMove && !onDelete && !restorable) return null;
      return (
        <span className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity shrink-0 bg-sh-surface2 rounded-md px-0.5">
          {restorable && (
            <button
              type="button"
              title="从回收站恢复"
              onClick={(e) => {
                e.stopPropagation();
                onRestore?.(node);
              }}
              className="p-0.5 rounded hover:bg-sh-surface2 text-sh-ok hover:text-sh-ok"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          {!restorable && onRename && (
            <button
              type="button"
              title={node.isDir ? '重命名目录' : '重命名'}
              onClick={(e) => {
                e.stopPropagation();
                onRename(node);
              }}
              className="p-0.5 rounded hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {!restorable && onMove && (
            <button
              type="button"
              title={node.isDir ? '移动目录' : '移动到…'}
              onClick={(e) => {
                e.stopPropagation();
                onMove(node);
              }}
              className="p-0.5 rounded hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg"
            >
              <FolderInput className="w-3 h-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              title={node.isDir ? '删除目录' : '删除'}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node);
              }}
              className="p-0.5 rounded hover:bg-sh-surface2 text-sh-muted hover:text-sh-danger"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </span>
      );
    };

    /**
     * Trailing meta cell. Size/count fades out while the actions fade in, both
     * absolutely positioned so hovering never shifts the row under the cursor
     * (that shift made a plain row click land on the rename button).
     */
    const metaCell = (label: string | number, node: OssTreeNode) => (
      <span className="ml-auto relative shrink-0 w-[74px] h-4 flex items-center justify-end">
        <span className="text-[10px] font-mono text-sh-subtle group-hover/row:opacity-0 transition-opacity">
          {label}
        </span>
        {rowActions(node)}
      </span>
    );

    return nodes.map((node) => {
      const pad = { paddingLeft: `${depth * 14 + 8}px` };

      if (node.isDir) {
        const open = isExpanded(node.path);
        const shown = limit ?? limits[node.path] ?? pageSize;
        const children = node.children.slice(0, shown);
        const hidden = node.children.length - children.length;

        return (
          <div key={`d:${node.path}`}>
            <div
              className="group/row w-full flex items-center gap-1.5 py-1.5 pr-2 rounded-lg text-xs text-sh-muted hover:bg-sh-surface2 transition-colors cursor-pointer"
              style={pad}
              data-oss-kind="dir"
              data-oss-path={node.path}
              onClick={() => toggle(node.path)}
            >
              {open ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-sh-subtle" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-sh-subtle" />
              )}
              {open ? (
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-sh-warn" />
              ) : (
                <Folder className="w-3.5 h-3.5 shrink-0 text-sh-warn" />
              )}
              <span className="truncate font-medium">{node.name}</span>
              {metaCell(node.children.length, node)}
            </div>
            {open && (
              <div>
                {renderNodes(children, depth + 1)}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setLimits((prev) => ({ ...prev, [node.path]: (prev[node.path] ?? pageSize) + pageSize * 2 }))
                    }
                    style={{ paddingLeft: `${(depth + 1) * 14 + 26}px` }}
                    className="w-full text-left py-1 text-[11px] text-sh-info hover:text-sh-info"
                  >
                    还有 {hidden} 项，点击加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        );
      }

      const selected = node.path === selectedKey;
      return (
        <div
          key={`f:${node.path}`}
          onClick={() => onSelectFile(node)}
          style={pad}
          data-oss-kind="file"
          data-oss-path={node.path}
          className={`group/row w-full flex items-center gap-1.5 py-1.5 pr-2 rounded-lg text-xs transition-colors cursor-pointer ${
            selected ? 'bg-sh-focus/10 text-sh-focus' : 'text-sh-muted hover:bg-sh-surface2'
          }`}
          title={node.path}
        >
          <span className="w-3.5 shrink-0" />
          {fileIcon(node.name)}
          <span className="truncate">{node.name}</span>
          {metaCell(formatSize(node.size), node)}
        </div>
      );
    });
  };

  if (visibleChildren.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-sh-subtle">
        {searching ? '没有匹配的文件或目录' : '该前缀下没有任何对象'}
      </div>
    );
  }

  return <div className="space-y-0.5">{renderNodes(visibleChildren, 0)}</div>;
};

export default OssTree;
