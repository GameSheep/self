import React, { useEffect, useMemo, useState } from 'react';
import { FolderKanban, Plus, Save, Trash2 } from 'lucide-react';
import type { HubState, ProjectItem } from '../../types';
import { EmptyState, PageHeader, inputClass } from '../../shared/ui';

export interface ProjectsViewProps {
  state: HubState;
  onAddProject: (project: ProjectItem) => void;
  onUpdateProject: (project: ProjectItem) => void;
  onDeleteProject: (id: string) => void;
  onNavigate?: (path: string) => void;
}

/**
 * 项目 (4) — name plus one block of text.
 *
 * The previous page was a hub: status, repo, deploy URL, tags, a decision log and five
 * "link a note / site / server / reminder / credential" pickers. Using it meant leaving the
 * page to go somewhere else, which is exactly the complaint. A project is now what the user
 * said it is: a name and a body of text you can dump anything into.
 *
 * Existing data is kept: `description` is the text area; the other fields simply stop being
 * edited here — they stay in the payload and in exports.
 */
export const ProjectsView: React.FC<ProjectsViewProps> = ({
  state,
  onAddProject,
  onUpdateProject,
  onDeleteProject
}) => {
  const projects = useMemo(
    () => [...(state.projects ?? [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [state.projects]
  );
  const [selectedId, setSelectedId] = useState<string>(projects[0]?.id ?? '');
  const [draftName, setDraftName] = useState('');
  const [draftText, setDraftText] = useState('');
  const [dirty, setDirty] = useState(false);

  const selected = projects.find((project) => project.id === selectedId) ?? null;

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
      window.alert('项目名称不能为空。');
      return;
    }
    onUpdateProject({ ...selected, name, description: draftText, updatedAt: Date.now() });
    setDirty(false);
  };

  /** Switching projects discards the editor buffer; confirm when it changed. */
  const selectProject = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm('当前项目的修改尚未保存，切换会放弃这些改动，确定继续吗？')) {
      return;
    }
    setSelectedId(id);
  };

  const createProject = () => {
    const project: ProjectItem = {
      id: `proj-${Date.now()}`,
      name: '新项目',
      description: '',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    onAddProject(project);
    // Creating a project also switches the editor; apply the same discard guard.
    if (dirty && !window.confirm('当前项目的修改尚未保存，切换会放弃这些改动，确定继续吗？')) {
      return;
    }
    setSelectedId(project.id);
  };

  return (
    <div data-testid="projects-view">
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
                    setDirty(true);
                  }}
                  aria-label="项目名称"
                  data-testid="project-name"
                  className={`${inputClass} flex-1 min-w-[200px] text-sm font-semibold`}
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
                <button
                  onClick={() => {
                    onDeleteProject(selected.id);
                    setSelectedId('');
                  }}
                  data-testid="project-delete"
                  className="p-1.5 rounded-lg border border-sh-line text-sh-danger hover:bg-sh-danger/10"
                  aria-label={`删除项目 ${selected.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                </button>
              </div>

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
