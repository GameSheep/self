import React, { useState } from 'react';
import { ShieldCheck, Lock, Key, X, Check, AlertCircle } from 'lucide-react';
import { getMasterAuth, setMasterAuth } from '../../lib/storage';
import { createPasswordHash, verifyPasswordHash, saveTrustedSession } from '../../lib/crypto';

interface MasterKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (password: string) => void;
}

export const MasterKeyModal: React.FC<MasterKeyModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Never keep a typed password / error message across open-close cycles.
  React.useEffect(() => {
    if (isOpen) {
      setPassword('');
      setConfirmPassword('');
      setErrorMsg('');
      setLoading(false);
    }
  }, [isOpen]);

  // Global window keydown listener for ESC
  React.useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const existingAuth = getMasterAuth();
  const isFirstTime = !existingAuth;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);

    try {
      if (!password.trim()) {
        setErrorMsg('请输入主密码');
        setLoading(false);
        return;
      }

      if (isFirstTime) {
        if (password.length < 6) {
          setErrorMsg('主密码长度不能少于 6 位');
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setErrorMsg('两次输入的密码不一致');
          setLoading(false);
          return;
        }

        const authHash = await createPasswordHash(password);
        setMasterAuth(authHash.hash, authHash.salt);

        if (rememberDevice) {
          await saveTrustedSession(password);
        }

        onSuccess(password);
        onClose();
      } else {
        const isValid = await verifyPasswordHash(password, existingAuth.hash, existingAuth.salt);
        if (!isValid) {
          setErrorMsg('主密码错误，请重试');
          setLoading(false);
          return;
        }

        if (rememberDevice) {
          await saveTrustedSession(password);
        }

        onSuccess(password);
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(err.message || '验证失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#121316] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-950/50 border border-emerald-800/50 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {isFirstTime ? '初始化主密码 (Master Password)' : '解锁安全金库'}
              </h2>
              <p className="text-xs text-zinc-500 font-mono">
                {isFirstTime ? '设置仅您自己知道的解密凭证' : '输入主密码以查看/复制敏感资产'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              主密码 (Master Password)
            </label>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
            />
          </div>

          {isFirstTime && (
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                确认主密码
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入以确认"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-zinc-700"
              />
            </div>
          )}

          {/* Remember this device checkbox */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="remember"
              checked={rememberDevice}
              onChange={(e) => setRememberDevice(e.target.checked)}
              className="rounded bg-zinc-900 border-zinc-700 text-emerald-500 focus:ring-0"
            />
            <label htmlFor="remember" className="text-xs text-zinc-400 cursor-pointer select-none">
              在这台常用设备保持记住（30天内免密自动加载）
            </label>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-950/40 border border-red-800/40 text-red-400 text-xs">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="text-[11px] text-zinc-500 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800/80 leading-relaxed">
            🛡️ <strong>零知识加密承诺</strong>：主密码绝不上网、绝不保存到远程服务器，仅在您本地浏览器中进行端到端解密。
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold flex items-center gap-1.5 shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{isFirstTime ? '完成设置并开启金库' : '立即解锁'}</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
