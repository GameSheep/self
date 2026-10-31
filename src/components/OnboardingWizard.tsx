import React, { useState } from 'react';
import { Check, ChevronRight, Layers, HardDrive, Sparkles, X } from 'lucide-react';
import { FEATURE_DEFS, FeatureFlags, FeatureId, isFeatureEnabled } from '../lib/features';

interface OnboardingWizardProps {
  isOpen: boolean;
  /** Current flags, used as the starting point. */
  features: Partial<FeatureFlags> | undefined;
  /** Apply the chosen modules and finish. */
  onFinish: (features: Partial<FeatureFlags>) => void;
  /** Skip without changing anything. */
  onSkip: () => void;
  /** Optional: jump straight to the storage settings after finishing. */
  onOpenStorage: () => void;
}

/**
 * First-run guide.
 *
 * The app has ~11 modules; showing all of them on day one is the opposite of
 * "simple to use". This asks one question — which modules do you actually want —
 * and applies the existing feature switches, so the answer is immediate and
 * reversible in settings.
 */
export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  isOpen,
  features,
  onFinish,
  onSkip,
  onOpenStorage
}) => {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [draft, setDraft] = useState<Partial<FeatureFlags>>(() => {
    const init: Partial<FeatureFlags> = {};
    FEATURE_DEFS.forEach((def) => {
      init[def.id] = isFeatureEnabled(features, def.id);
    });
    return init;
  });

  if (!isOpen) return null;

  const toggle = (id: FeatureId) => setDraft((prev) => ({ ...prev, [id]: !prev[id] }));
  const enabledCount = FEATURE_DEFS.filter((d) => draft[d.id]).length;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-in fade-in">
      <div
        className="w-full max-w-lg bg-sh-surface border border-sh-line rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        data-testid="onboarding"
      >
        <div className="flex items-center justify-between p-4 border-b border-sh-line">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-sh-surface2 border border-sh-line-strong flex items-center justify-center text-[11px] text-sh-muted font-mono">
              {step + 1}/3
            </span>
            <h3 className="text-sm font-semibold text-sh-fg">
              {step === 0 ? '欢迎使用 Self-Hub' : step === 1 ? '你实际会用哪些模块？' : '存储与备份'}
            </h3>
          </div>
          <button
            onClick={onSkip}
            className="p-1 rounded-lg hover:bg-sh-surface2 text-sh-subtle hover:text-sh-fg"
            data-testid="onboarding-skip"
            title="跳过向导"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto max-h-[60vh]">
          {step === 0 && (
            <>
              <p className="text-xs text-sh-muted leading-relaxed">
                这是一个本地优先的个人工作台：网站书签、倒计时提醒、加密金库、Obsidian 笔记都在一个地方。
              </p>
              <p className="text-xs text-sh-muted leading-relaxed">
                接下来花 30 秒选一下你需要的模块，用不到的会从侧边栏隐藏（数据不会删除，随时能在设置里打开）。
              </p>
              <div className="rounded-xl border border-sh-line bg-sh-surface2 p-3 text-[11px] text-sh-subtle leading-relaxed">
                这些是核心功能，始终可用：仪表盘、网站与工作台、倒计时与续费、多平台数据互通（Obsidian）。
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-xs text-sh-muted">关掉不用的模块，界面会清爽很多。已关闭 {FEATURE_DEFS.length - enabledCount} 个。</p>
              <div className="rounded-xl border border-sh-line divide-y divide-sh-line">
                {FEATURE_DEFS.map((def) => {
                  const on = Boolean(draft[def.id]);
                  return (
                    <button
                      key={def.id}
                      onClick={() => toggle(def.id)}
                      data-onboarding-feature={def.id}
                      data-enabled={on ? 'true' : 'false'}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-sh-surface2"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs text-sh-fg">{def.label}</span>
                        <span className="block text-[10px] text-sh-subtle mt-0.5 leading-relaxed">{def.description}</span>
                      </span>
                      <span
                        className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${
                          on ? 'bg-sh-ok' : 'bg-sh-line'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-sh-accent transition-all ${
                            on ? 'left-[18px]' : 'left-0.5'
                          }`}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs text-sh-muted leading-relaxed">
                要不要现在接上云端？接上之后笔记与全部数据会自动备份，换设备也能恢复。
              </p>
              <div className="space-y-2">
                <div className="rounded-xl border border-sh-line bg-sh-surface2 p-3">
                  <div className="flex items-center gap-2 text-xs text-sh-fg">
                    <HardDrive className="w-3.5 h-3.5 text-sh-info" /> 阿里云 OSS · 存 Obsidian 笔记库
                  </div>
                  <p className="text-[10px] text-sh-subtle mt-1 leading-relaxed">需要 Bucket、Endpoint、AccessKey。</p>
                </div>
                <div className="rounded-xl border border-sh-line bg-sh-surface2 p-3">
                  <div className="flex items-center gap-2 text-xs text-sh-fg">
                    <Layers className="w-3.5 h-3.5 text-sh-info" /> WebDAV · InfiniCLOUD / Nextcloud
                  </div>
                  <p className="text-[10px] text-sh-subtle mt-1 leading-relaxed">只需连接地址、账号与应用密码。</p>
                </div>
                <div className="rounded-xl border border-sh-line bg-sh-surface2 p-3">
                  <div className="flex items-center gap-2 text-xs text-sh-fg">
                    <Sparkles className="w-3.5 h-3.5 text-sh-warn" /> 稍后再说
                  </div>
                  <p className="text-[10px] text-sh-subtle mt-1 leading-relaxed">
                    数据先存在本机，随时可在「系统设置 → 存储与备份」里接入。
                  </p>
                </div>
              </div>
              <p className="text-[10px] text-sh-subtle leading-relaxed">
                无论选哪个，密钥都只保存在本机；云端备份在上传前会自动剥离全部凭据。
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 p-4 border-t border-sh-line">
          <button
            onClick={() => (step === 0 ? onSkip() : setStep((step - 1) as 0 | 1 | 2))}
            className="px-3 py-1.5 rounded-lg bg-sh-surface2 border border-sh-line text-sh-muted text-xs"
            data-testid="onboarding-back"
          >
            {step === 0 ? '跳过' : '上一步'}
          </button>

          {step < 2 ? (
            <button
              onClick={() => setStep((step + 1) as 0 | 1 | 2)}
              className="px-3.5 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg font-semibold text-xs flex items-center gap-1"
              data-testid="onboarding-next"
            >
              下一步 <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  onFinish(draft);
                  onOpenStorage();
                }}
                className="px-3 py-1.5 rounded-lg bg-sh-surface2 hover:bg-sh-surface2 text-sh-fg text-xs"
                data-testid="onboarding-configure"
              >
                现在去配置
              </button>
              <button
                onClick={() => onFinish(draft)}
                className="px-3.5 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg font-semibold text-xs flex items-center gap-1"
                data-testid="onboarding-finish"
              >
                <Check className="w-3.5 h-3.5" /> 开始使用
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
