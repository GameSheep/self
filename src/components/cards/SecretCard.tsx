import React, { useState } from 'react';
import { Key, Eye, EyeOff, Copy, Check, Shield, Trash2, Lock } from 'lucide-react';
import { SecretItem } from '../../types';
import { decryptText } from '../../lib/crypto';

interface SecretCardProps {
  secret: SecretItem;
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onDelete: (id: string) => void;
}

export const SecretCard: React.FC<SecretCardProps> = ({
  secret,
  masterPassword,
  onRequireUnlock,
  onDelete
}) => {
  const [revealed, setRevealed] = useState(false);
  const [decryptedValue, setDecryptedValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleToggleReveal = async () => {
    if (!masterPassword) {
      onRequireUnlock();
      return;
    }

    if (revealed) {
      setRevealed(false);
      return;
    }

    try {
      if (!decryptedValue) {
        const plain = await decryptText(secret.encryptedValue, secret.iv, secret.salt, masterPassword);
        setDecryptedValue(plain);
      }
      setRevealed(true);
    } catch (err) {
      console.error('Decryption failed', err);
    }
  };

  const handleCopy = async () => {
    if (!masterPassword) {
      onRequireUnlock();
      return;
    }

    try {
      let textToCopy = decryptedValue;
      if (!textToCopy) {
        textToCopy = await decryptText(secret.encryptedValue, secret.iv, secret.salt, masterPassword);
        setDecryptedValue(textToCopy);
      }
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onRequireUnlock();
    }
  };

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case 'api_key':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sky-950/60 text-sky-400 border border-sky-800/50 whitespace-nowrap">API Key</span>;
      case 'ssh_key':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 whitespace-nowrap">SSH 凭证</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-purple-950/60 text-purple-400 border border-purple-800/50 whitespace-nowrap">Secret</span>;
    }
  };

  return (
    <div className="group relative p-3.5 sm:p-4 rounded-xl bg-[#121316] border border-[#22242a] card-hover shadow-sm flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-amber-400/90">
              <Key className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                  {secret.name}
                </h3>
                {getCategoryBadge(secret.category)}
              </div>
              {secret.description && (
                <p className="text-[10px] sm:text-[11px] text-zinc-400 truncate mt-0.5">
                  {secret.description}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={() => {
              if (confirm(`确定删除凭据 ${secret.name} 吗？`)) {
                onDelete(secret.id);
              }
            }}
            className="opacity-100 sm:opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-opacity shrink-0"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Secret Display & Masking Box */}
        <div className="relative mt-2.5 p-2 rounded-lg bg-black/60 border border-zinc-800 font-mono text-xs flex items-center justify-between gap-1.5">
          <div className="truncate text-zinc-300 text-[11px] select-all min-w-0">
            {revealed && decryptedValue ? decryptedValue : secret.maskedPreview}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleToggleReveal}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
              title={revealed ? '隐藏明文' : '查看明文'}
            >
              {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={handleCopy}
              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] sm:text-[11px] flex items-center gap-1 transition-colors whitespace-nowrap"
              title="一键解密复制"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Security Status Tag */}
      <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-2.5 pt-2 border-t border-zinc-800/60">
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Shield className="w-3 h-3 text-emerald-500/80 shrink-0" />
          <span>AES-256-GCM 零知识加密</span>
        </div>
        {!masterPassword && (
          <span className="flex items-center gap-1 text-amber-500/90 font-medium whitespace-nowrap">
            <Lock className="w-3 h-3 shrink-0" />
            需主密码
          </span>
        )}
      </div>
    </div>
  );
};
