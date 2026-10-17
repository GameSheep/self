import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { HubState } from '../../types';
import { IntegrationDef } from '../../lib/integrations';

interface IntegrationCardProps {
  def: IntegrationDef;
  state: HubState;
  /** Persist this integration's values (already merged into state by the hook). */
  onSave: (id: IntegrationDef['id'], values: Record<string, string>) => void;
  /** Optional extra row rendered under the fields (test button, results…). */
  children?: React.ReactNode;
  /** Rendered next to the fields, e.g. a connection test button. */
  actions?: (draft: Record<string, string>) => React.ReactNode;
}

/**
 * One consistent layout for every external connection.
 *
 * Fields are generated from the registry, so a new integration never needs a new
 * bespoke form — which is exactly how the settings drifted apart before.
 */
export const IntegrationCard: React.FC<IntegrationCardProps> = ({ def, state, onSave, children, actions }) => {
  const configured = def.isConfigured(state);
  const persisted = useMemo(() => def.read(state), [def, state]);
  const [draft, setDraft] = useState<Record<string, string>>(persisted);
  const [saved, setSaved] = useState(false);

  // Re-sync when the persisted values change from elsewhere (e.g. restore).
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const dirty = Object.keys(persisted).some((k) => (draft[k] ?? '') !== (persisted[k] ?? ''));

  const handleSave = () => {
    onSave(def.id, draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Persist on blur: one less "remember to press save" step, and it means the
  // footer's batch button can never write stale values over what is on screen.
  const handleBlur = () => {
    if (dirty) onSave(def.id, draft);
  };

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3"
      data-integration={def.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${configured ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {def.title}
          </h4>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{def.description}</p>
        </div>
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-mono ${
            configured
              ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-400'
              : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          {configured ? '已配置' : '未配置'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {def.fields.map((field) => {
          const on = (draft[field.key] ?? 'false') === 'true';

          if (field.type === 'toggle') {
            return (
              <div key={field.key} className="sm:col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] text-zinc-300">{field.label}</div>
                    {field.hint && (
                      <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">{field.hint}</p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      const next = { ...draft, [field.key]: on ? 'false' : 'true' };
                      setDraft(next);
                      // Toggles are dangerous-by-nature: persist immediately so the
                      // state on screen always equals the state in effect.
                      onSave(def.id, next);
                    }}
                    data-field={`${def.id}.${field.key}`}
                    data-enabled={on ? 'true' : 'false'}
                    aria-pressed={on}
                    className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                      on ? 'bg-amber-600' : 'bg-zinc-700'
                    }`}
                    title={on ? '点击关闭' : '点击开启'}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                        on ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
                {on && field.warning && (
                  <p className="mt-2 text-[10px] text-amber-300 leading-relaxed" data-warning={def.id}>
                    ⚠️ {field.warning}
                  </p>
                )}
              </div>
            );
          }

          const wide = field.type === 'password' || field.key === 'bucket' || field.key === 'url';
          return (
            <label key={field.key} className={`block ${wide ? 'sm:col-span-2' : ''}`}>
              <span className="block text-[11px] text-zinc-400 mb-1">{field.label}</span>
              {field.type === 'select' ? (
                <select
                  data-field={`${def.id}.${field.key}`}
                  value={draft[field.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                  onBlur={handleBlur}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                >
                  {(field.options || []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'password' ? 'password' : 'text'}
                  data-field={`${def.id}.${field.key}`}
                  value={draft[field.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                  onBlur={handleBlur}
                  placeholder={field.placeholder}
                  autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                  className={`w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700 ${
                    field.mono ? 'font-mono' : ''
                  }`}
                />
              )}
              {field.hint && <span className="block text-[10px] text-zinc-500 mt-1 leading-relaxed">{field.hint}</span>}
            </label>
          );
        })}
      </div>

      {def.target && def.target(state, draft) && (
        <p className="text-[10px] font-mono text-zinc-600 break-all">目标：{def.target(state, draft)}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          data-save={def.id}
          className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-medium"
        >
          {saved ? '已保存' : dirty ? '保存' : '已保存'}
        </button>
        {actions?.(draft)}
        {children}
      </div>
    </div>
  );
};

export default IntegrationCard;


