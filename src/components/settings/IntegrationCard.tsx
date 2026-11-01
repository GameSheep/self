import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { HubState } from '../../types';
import { IntegrationDef, IntegrationId } from '../../lib/integrations';
import { changedKeys, connectionFacts, connectionStatus } from '../../lib/connectionState';
import { Button, SaveFeedback, StatusPill, type SaveState } from '../../shared/ui';

interface IntegrationCardProps {
  def: IntegrationDef;
  state: HubState;
  /** Commit this draft. Must be a real write — the card verifies the result. */
  onSave: (id: IntegrationId, values: Record<string, string>) => void;
  /**
   * Unsaved-edit state, lifted so the settings shell can protect navigation
   * away from a half-edited connection (see SettingsModal).
   */
  onDirtyChange?: (id: IntegrationId, dirty: boolean) => void;
  /** Live draft, published so 「保存后离开」 can commit exactly what is on screen. */
  onDraftChange?: (id: IntegrationId, values: Record<string, string>) => void;
  /** Probe the current draft. Never saves — the pane records the result. */
  onTest?: (draft: Record<string, string>) => void;
  testing?: boolean;
  /**
   * Incremented by the shell when the user chooses 「放弃修改」 in the leave
   * guard: the draft goes back to the persisted values.
   */
  resetSignal?: number;
  /** Rendered under the fields: test output, unsupported-capability notice… */
  children?: React.ReactNode;
}

/**
 * One consistent layout for every external connection.
 * Fields are generated from the registry, so a new integration never needs a new
 * bespoke form — which is exactly how the settings drifted apart before.
 * · draft; 「保存连接」 commits it, 「取消」 throws it away, and a green tick is only
 */
export const IntegrationCard: React.FC<IntegrationCardProps> = ({
  def,
  state,
  onSave,
  onDirtyChange,
  onDraftChange,
  onTest,
  testing = false,
  resetSignal,
  children
}) => {
  const persisted = useMemo(() => def.read(state), [def, state]);
  const persistedSig = JSON.stringify(persisted);
  const [draft, setDraft] = useState<Record<string, string>>(persisted);
  const [phase, setPhase] = useState<SaveState>('idle');
/**
 * Collapsed by default.
 * Six integrations rendered as six full forms meant one screen of nothing but inputs, and the
 * user could not see that OSS / WebDAV were even there. The header keeps what matters at a
 * · edits or a visible error always opens itself, so a draft can never be hidden behind the
 */
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Record<string, string> | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const persistedRef = useRef(persisted);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastSigRef = useRef(persistedSig);

  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  const draftCb = useRef(onDraftChange);
  draftCb.current = onDraftChange;

/**
 * Re-sync when the saved values change from elsewhere (restore, another tab).
 * The old version re-synced on every `state` identity change, which would now
 * silently throw away an unsaved draft whenever an unrelated part of the app
 */
  useEffect(() => {
    if (lastSigRef.current === persistedSig) return;
    const wasDirty = changedKeys(def, draftRef.current, persistedRef.current).length > 0;
    lastSigRef.current = persistedSig;
    persistedRef.current = persisted;
    if (!wasDirty) setDraft(persisted);
  }, [def, persisted, persistedSig]);

  const dirty = changedKeys(def, draft, persisted).length > 0;
  const status = connectionStatus(state, def, draft);
  const facts = connectionFacts(state, def, draft);

  /** 「放弃修改」 from the leave guard: back to the persisted values. */
  const resetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetRef.current === resetSignal) return;
    resetRef.current = resetSignal;
    setPending(null);
    setPhase('idle');
    setErrorText(null);
    setDraft(def.read(stateRef.current));
  }, [def, resetSignal]);

  // Tell the shell which connections have unsaved edits. On unmount the id is
  // cleared, so a card that disappears cannot leave a phantom "dirty" behind.
  useEffect(() => {
    dirtyCb.current?.(def.id, dirty);
  }, [def.id, dirty]);
  useEffect(() => {
    return () => dirtyCb.current?.(def.id, false);
  }, [def.id]);

  useEffect(() => {
    draftCb.current?.(def.id, draft);
  }, [def.id, draft]);

  // Publish a render-phase warning if the shell forgets to persist. Nothing to
  // do here beyond keeping the draft; the shell owns the write.
  const publishDraft = (next: Record<string, string>) => {
    setDraft(next);
    if (phase !== 'saving') {
      setPhase('idle');
      setErrorText(null);
    }
  };

  const setField = (key: string, value: string) => {
    const next = { ...draftRef.current, [key]: value };
    // Switching provider must not carry the previous service's model/base URL
    // over: a leftover `deepseek-chat` sent to Gemini is a guaranteed 400.
    for (const resetKey of def.resetOnChange?.[key] ?? []) {
      if (resetKey !== key) next[resetKey] = '';
    }
    publishDraft(next);
  };

  const handleSave = () => {
    setErrorText(null);
    setPhase('saving');
    setPending(draftRef.current);
    try {
      onSave(def.id, draftRef.current);
    } catch (err) {
      setPending(null);
      setPhase('error');
      setErrorText(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * The parent writer is synchronous, so "did it actually save?" is answered on
   * the next render by comparing the submitted draft with what the state now
   * holds. Only then is 「已保存」 shown. Differing values are a failure, not a
   * success — a green tick must never lie.
   */
  useEffect(() => {
    if (phase !== 'saving' || !pending) return;
    if (changedKeys(def, pending, def.read(state)).length === 0) {
      setPhase('saved');
      setPending(null);
      return;
    }
    const timer = setTimeout(() => {
      if (changedKeys(def, pending, def.read(stateRef.current)).length === 0) {
        setPhase('saved');
        setPending(null);
      } else {
        setPhase('error');
        setPending(null);
        setErrorText('保存未生效，请重试');
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [def, phase, pending, state]);

  const handleCancel = () => {
    if (!dirty) return;
    setPending(null);
    setPhase('idle');
    setErrorText(null);
    setDraft(def.read(stateRef.current));
  };

  const feedback: SaveState = phase !== 'idle' ? phase : dirty ? 'dirty' : 'idle';
  const target = def.target?.(state, draft);
  /** Fields are visible on demand — but never hidden while there is unsaved work or an error. */
  const showFields = expanded || dirty || phase === 'saving' || phase === 'error';

  return (
    <div className="rounded-xl border border-sh-line bg-sh-surface p-4 space-y-3" data-integration={def.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-sh-fg">{def.title}</h4>
          <p className="text-[11px] text-sh-muted mt-0.5 leading-relaxed">{def.description}</p>
          {def.capabilities.length === 0 && (
            <p className="text-[11px] text-sh-warn mt-1 leading-relaxed" data-connection-unsupported={def.id}>
              当前不支持拉取：本版本还没有接通它的远端接口，只能手工维护本地记录。
            </p>
          )}
        </div>
        {/* Four facts, never one 「已配置」 badge. */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span data-connection-stage={def.id} data-stage={status.stage} title={status.detail}>
            <StatusPill tone={status.tone} label={status.label} />
          </span>
          <button
            onClick={() => setExpanded((open) => !open)}
            data-integration-toggle={def.id}
            aria-expanded={showFields}
            className="text-[11px] text-sh-info hover:underline"
          >
            {showFields ? '收起' : '配置'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {facts.map((fact) => (
          <div
            key={fact.key}
            data-connection-fact={`${def.id}.${fact.key}`}
            title={fact.detail}
            className="rounded-lg border border-sh-line bg-sh-surface2/60 px-2 py-1.5 min-w-0"
          >
            <div className="text-[10px] text-sh-subtle">{fact.label}</div>
            <div
              className={clsx(
                'text-[11px] mt-0.5 break-words',
                fact.tone === 'ok' && 'text-sh-ok',
                fact.tone === 'warn' && 'text-sh-warn',
                fact.tone === 'danger' && 'text-sh-danger',
                fact.tone === 'info' && 'text-sh-info',
                fact.tone === 'neutral' && 'text-sh-muted'
              )}
            >
              {fact.value}
            </div>
          </div>
        ))}
      </div>

      {showFields && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {def.fields.map((field) => {
          const on = (draft[field.key] ?? 'false') === 'true';

          if (field.type === 'toggle') {
            return (
              <div key={field.key} className="sm:col-span-2 rounded-lg border border-sh-line bg-sh-surface2/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] text-sh-fg">{field.label}</div>
                    {field.hint && <p className="text-[10px] text-sh-muted mt-0.5 leading-relaxed">{field.hint}</p>}
                  </div>
                  <button
                    onClick={() => setField(field.key, on ? 'false' : 'true')}
                    data-field={`${def.id}.${field.key}`}
                    data-enabled={on ? 'true' : 'false'}
                    aria-pressed={on}
                    className={clsx(
                      'shrink-0 w-9 h-5 rounded-full transition-colors relative',
                      on ? 'bg-sh-ok' : 'bg-sh-line-strong'
                    )}
                    title={on ? '点击关闭（保存后生效）' : '点击开启（保存后生效）'}
                  >
                    <span
                      className={clsx(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                        on ? 'left-[18px]' : 'left-0.5'
                      )}
                    />
                  </button>
                </div>
                {on && field.warning && (
                  <p className="mt-2 text-[10px] text-sh-warn leading-relaxed" data-warning={def.id}>
                    ⚠️ {field.warning}
                  </p>
                )}
              </div>
            );
          }

          const wide = field.type === 'password' || field.key === 'bucket' || field.key === 'url';
          const controlClass = clsx(
            'w-full bg-sh-surface2 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong',
            field.mono && 'font-mono'
          );
          return (
            <label key={field.key} className={clsx('block min-w-0', wide && 'sm:col-span-2')}>
              <span className="block text-[11px] text-sh-muted mb-1">{field.label}</span>
              {field.type === 'select' ? (
                <select
                  data-field={`${def.id}.${field.key}`}
                  value={draft[field.key] ?? ''}
                  onChange={(e) => setField(field.key, e.target.value)}
                  className={controlClass}
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
                  onChange={(e) => setField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                  className={controlClass}
                />
              )}
              {field.hint && <span className="block text-[10px] text-sh-subtle mt-1 leading-relaxed">{field.hint}</span>}
            </label>
          );
        })}
      </div>

      {target && <p className="text-[10px] font-mono text-sh-subtle break-all">目标：{target}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || phase === 'saving'}
          data-save={def.id}
        >
          保存连接
        </Button>
        <Button variant="secondary" size="sm" onClick={handleCancel} disabled={!dirty} data-cancel={def.id}>
          取消
        </Button>
        {onTest && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onTest(draft)}
            busy={testing}
            data-test-connection={def.id}
            data-testid={def.id === 'webdav' ? 'webdav-test' : def.id === 'ai' ? 'ai-test' : undefined}
          >
            {testing ? '测试中…' : '测试连接'}
          </Button>
        )}
        <SaveFeedback state={feedback} message={errorText ?? undefined} onRetry={phase === 'error' ? handleSave : undefined} />
      </div>

      {children}
        </>
      )}
    </div>
  );
};

export default IntegrationCard;
