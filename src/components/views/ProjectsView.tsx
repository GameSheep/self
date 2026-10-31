import React, { useEffect, useMemo, useState } from 'react';
import { FolderKanban, Plus, Save, Trash2 } from 'lucide-react';
import type { HubState, ProjectItem } from '../../types';
import { ConfirmButton, EmptyState, PageHeader, inputClass, useDirtyGuard } from '../../shared/ui';

export interface ProjectsViewProps {
  state: HubState;
  onAddProject: (project: ProjectItem) => void;
  onUpdateProject: (project: ProjectItem) => void;
  onDeleteProject: (id: string) => void;
  onNavigate?: (path: string) => void;
  /**
   * Deep-link target (`#/projects/:id`, from a search hit or an inbox
   * conversion): selects that project instead of the most recent one.
   */
  initialSelectedId?: string;
}

/**
 * 项目 (4) — name plus one block of text.
 * The previous page was a hub: status, repo, deploy URL, tags, a decision log and five
 * "link a note / site / server / reminder / credential" pickers. Using it meant leaving the
 */
export const ProjectsView: React.FC<ProjectsViewProps> = ({
  state,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  initialSelectedId
}) => {
  const projects = useMemo(
    () => [...(state.projects ?? [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [state.projects]
  );
  const [selectedId, setSelectedId] = useState<string>(
    initialSelectedId && projects.some((p) => p.id === initialSelectedId) ? initialSelectedId : projects[0]?.id ?? ''
  );
  const [draftName, setDraftName] = useState('');
  const [draftText, setDraftText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const selected = projects.find((project) => project.id === selectedId) ?? null;

  // Deep links can also land while the view is already mounted (a second
  // search from another page): re-point selection whenever the prop changes.
  useEffect(() => {
    if (initialSelectedId && initialSelectedId !== selectedId && projects.some((p) => p.id === initialSelectedId)) {
      setSelectedId(initialSelectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedId]);

  // Load the selected project into the editor.
  useEffect(() => {
    if (!selected) {
      setDraftName('');
      setDraftText('');
      setDirty(false);
      return;
    }
    setDraftName(selected.name);
    setDraftText(selected.description ?? '');
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (!selectedId && projects.length > 0) setSelectedId(projects[0].id);
  }, [projects, selectedId]);

  const save = () => {
    if (!selected) return;
    const name = draftName.trim();
    if (!name) {
      // A silent return made the save button look broken; say what is missing.
      setNameError('项目名称不能为空。');
      return;
    }
    setNameError(null);
    onUpdateProject({ ...selected, name, description: draftText, updatedAt: Date.now() });
    setDirty(false);
  };

  // 切换 / 新建都会丢掉编辑缓冲，统一走守卫；旧实现用 window.confirm，
  // 而且 createProject 先建后问——点「取消」也已经建出了一个空项目。
  const { request: requestLeave, dialog: guardDialog } = useDirtyGuard({
    isDirty: dirty,
    title: '这个项目还没有保存',
    message: '切换会放弃当前编辑；留在本页可先按 Ctrl/⌘ + Enter 保存。'
  });

  /** Switching projects discards the editor buffer; confirm when it changed. */
  const selectProject = (id: string) => {
    if (id === selectedId) return;
    requestLeave().then((ok) => {
      if (ok) setSelectedId(id);
    });
  };

  const createProject = () => {
    // Guard BEFORE creating: the old order added the project first, so even a
    // cancelled dialog left an empty 「新项目」 in the list — one per click.
    requestLeave().then((ok) => {
      if (!ok) return;
      const project: ProjectItem = {
        id: `proj-${Date.now()}`,
        name: '新项目',
        description: '',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      onAddProject(project);
      setSelectedId(project.id);
    });
  };

  const removeProject = () => {
    if (!selected) return;
    onDeleteProject(selected.id);
    setSelectedId('');
  };

  return (
    <div data-testid="projects-view">
      {guardDialog}
      <PageHeader
        title="项目"
        description="一个项目就是名字 + 一块文本。直接写，别处不用去。"
        actions={
          <button
            onClick={createProject}
            data-testid="project-add"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold sh-tap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            新建项目
          </button>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="w-5 h-5" />}
          title="还没有项目"
          description="新建一个项目，把想法、进展、命令直接写进那一块文本里。"
          action={
            <button
              onClick={createProject}
              className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
            >
              新建项目
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
          <aside className="space-y-1.5" aria-label="项目列表">
            {projects.map((project) => {
              const active = project.id === selectedId;
              return (
                <button
                  key={project.id}
                  onClick={() => selectProject(project.id)}
                  data-testid={`project-row-${project.id}`}
                  aria-current={active ? 'true' : undefined}
                  className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${
                    active
                      ? 'bg-sh-surface2 border-sh-line-strong text-sh-fg'
                      : 'border-sh-line text-sh-muted hover:text-sh-fg'
                  }`}
                >
                  <span className="block text-xs font-medium truncate">{project.name}</span>
                  <span className="block text-[10px] text-sh-subtle truncate">
                    {project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : ''}
                  </span>
                </button>
              );
            })}
          </aside>

          {selected && (
            <section className="rounded-2xl border border-sh-line bg-sh-surface p-4 space-y-3" data-testid="project-editor">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={draftName}
                  onChange={(e) => {
                    setDraftName(e.target.value);
                    setNameError(null);
                    setDirty(true);
                  }}
                  aria-label="项目名称"
                  aria-invalid={nameError ? true : undefined}
                  data-testid="project-name"
                  className={`${inputClass} flex-1 min-w-[200px] text-sm font-semibold ${nameError ? 'border-sh-danger' : ''}`}
                />
                <button
                  onClick={save}
                  disabled={!dirty}
                  data-testid="project-save"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" aria-hidden />
                  {dirty ? '保存' : '已保存'}
                </button>
                <ConfirmButton
                  onConfirm={removeProject}
                  confirmLabel="确认删除？"
                  confirmDetail={selected.name}
                  data-testid="project-delete"
                  className="p-1.5 rounded-lg border border-sh-line text-sh-danger hover:bg-sh-danger/10"
                  aria-label={`删除项目 ${selected.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                </ConfirmButton>
              </div>
              {nameError && (
                <p className="text-[11px] text-sh-danger" role="alert">
                  {nameError}
                </p>
              )}

              <textarea
                value={draftText}
                onChange={(e) => {
                  setDraftText(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    save();
                  }
                }}
                rows={18}
                placeholder="想写什么就写什么：进度、命令、链接、待办…（Ctrl/⌘ + Enter 保存）"
                data-testid="project-text"
                className="w-full bg-sh-surface2 border border-sh-line rounded-xl px-3 py-2 text-sm text-sh-fg leading-relaxed focus:outline-none focus:border-sh-line-strong resize-y"
              />
              <p className="text-[11px] text-sh-subtle">
                {draftText.length} 字符 · 保存后立即写入本机
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export default ProjectsView;
