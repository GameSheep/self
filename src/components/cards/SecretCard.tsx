import React, { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, Copy, Check, Shield, Trash2, Lock } from 'lucide-react';
import { SecretItem } from '../../types';
import { decryptText } from '../../lib/crypto';
import { ConfirmButton } from '../../shared/ui';

interface SecretCardProps {
  secret: SecretItem;
  masterPassword: string | null;
  onRequireUnlock: () => void;
  onDelete: (id: string) => void;
}

/** The card's own display model: one row per decrypted-or-not field. */
interface FieldRow {
  label: string;
  maskedPreview: string;
  encryptedValue: string;
  iv: string;
  salt: string;
}

/**
 * Normalize legacy (single-value) and multi-field entries into the same row shape.
 *
 * A legacy entry holds its value in the top-level `encryptedValue`; a multi-field entry
 * holds an array in `fields` (with the first field mirrored into the legacy slots for
 * old readers). Normalizing here keeps the rendering single-path.
 */
function rowsFor(secret: SecretItem): FieldRow[] {
  if (secret.fields && secret.fields.length > 0) {
    return secret.fields.map((f) => ({
      label: f.label,
      maskedPreview: f.maskedPreview,
      encryptedValue: f.encryptedValue,
      iv: f.iv,
      salt: f.salt
    }));
  }
  return [
    {
      label: '',
      maskedPreview: secret.maskedPreview,
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      salt: secret.salt
    }
  ];
}

export const SecretCard: React.FC<SecretCardProps> = ({
  secret,
  masterPassword,
  onRequireUnlock,
  onDelete
}) => {
  const rows = rowsFor(secret);
  /** Per-field decryption cache; index-aligned with `rows`. */
  const [decrypted, setDecrypted] = useState<Record<number, string>>({});
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Locking the vault must also erase the plaintext held by this card.
  useEffect(() => {
    if (!masterPassword) {
      setRevealed({});
      setDecrypted({});
      setCopiedIndex(null);
      setErrorMsg('');
    }
  }, [masterPassword]);

  useEffect(() => {
    const onLocked = () => {
      setRevealed({});
      setDecrypted({});
      setCopiedIndex(null);
    };
    window.addEventListener('selfhub:vault-locked', onLocked);
    return () => window.removeEventListener('selfhub:vault-locked', onLocked);
  }, []);

  /** Reset per-card state when a different secret is rendered into this card slot. */
  useEffect(() => {
    setRevealed({});
    setDecrypted({});
    setCopiedIndex(null);
    setErrorMsg('');
  }, [secret.id, secret.updatedAt]);

  const handleToggleReveal = async (index: number) => {
    if (!masterPassword) {
      onRequireUnlock();
      return;
    }

    if (revealed[index]) {
      setRevealed((prev) => ({ ...prev, [index]: false }));
      return;
    }

    try {
      setErrorMsg('');
      if (decrypted[index] == null) {
        const row = rows[index];
        const plain = await decryptText(row.encryptedValue, row.iv, row.salt, masterPassword);
        setDecrypted((prev) => ({ ...prev, [index]: plain }));
      }
      setRevealed((prev) => ({ ...prev, [index]: true }));
    } catch (err) {
      console.error('Decryption failed', err);
      setErrorMsg('解密失败：该凭据可能由另一个主密码加密，或密文已损坏。');
    }
  };

  const handleCopy = async (index: number) => {
    if (!masterPassword) {
      onRequireUnlock();
      return;
    }

    try {
      setErrorMsg('');
      let textToCopy = decrypted[index];
      if (textToCopy == null) {
        const row = rows[index];
        textToCopy = await decryptText(row.encryptedValue, row.iv, row.salt, masterPassword);
        setDecrypted((prev) => ({ ...prev, [index]: textToCopy as string }));
      }
      await navigator.clipboard.writeText(textToCopy);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error('Copy failed', err);
      // Do not silently pretend it worked: distinguish decrypt vs clipboard errors.
      setErrorMsg(
        masterPassword === null
          ? '金库已锁定，请先解锁'
          : '复制或解密失败：请确认主密码正确，且页面处于聚焦状态。'
      );
    }
  };

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case 'api_key':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-info/10 text-sh-info border border-sh-info/40 whitespace-nowrap">API Key</span>;
      case 'ssh_key':
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-ok/10 text-sh-ok border border-sh-ok/40 whitespace-nowrap">SSH 凭证</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono bg-sh-focus/10 text-sh-focus border border-sh-focus/40 whitespace-nowrap">Secret</span>;
    }
  };

  const multiField = rows.length > 1;

  return (
    <div
      className="group relative p-3.5 sm:p-4 rounded-xl bg-sh-surface border border-sh-line card-hover shadow-sm flex flex-col justify-between"
      data-secret-card={secret.id}
    >
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-lg bg-sh-surface2 border border-sh-line flex items-center justify-center shrink-0 text-sh-warn">
              <Key className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs sm:text-sm font-semibold text-sh-fg truncate">
                  {secret.name}
                </h3>
                {getCategoryBadge(secret.category)}
              </div>
              {secret.description && (
                <p className="text-[10px] sm:text-[11px] text-sh-muted truncate mt-0.5">
                  {secret.description}
                </p>
              )}
            </div>
          </div>

          <ConfirmButton
            onConfirm={() => onDelete(secret.id)}
            confirmLabel="确认删除？"
            confirmDetail={secret.name}
            className="opacity-100 sm:opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-sh-surface2 text-sh-subtle hover:text-sh-danger transition-opacity shrink-0"
            title="删除"
            aria-label={`删除凭据 ${secret.name}`}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
          </ConfirmButton>
        </div>

        {/* Fields: one reveal/copy row each, so revealing a key never exposes its secret. */}
        <div className={multiField ? 'space-y-1.5 mt-2.5' : 'relative mt-2.5'} data-testid="secret-card-fields">
          {rows.map((row, index) => (
            <div
              key={index}
              data-secret-field-row={row.label || undefined}
              className={multiField ? 'p-2 rounded-lg bg-sh-bg/80 border border-sh-line' : 'p-2 rounded-lg bg-sh-bg/80 border border-sh-line font-mono text-xs flex items-center justify-between gap-1.5'}
            >
              {multiField && (
                <div className="text-[10px] text-sh-subtle mb-1 flex items-center justify-between">
                  <span className="font-mono text-sh-muted">{row.label || '字段'}</span>
                </div>
              )}
              <div className={`truncate text-sh-muted text-[11px] select-all min-w-0 ${multiField ? 'font-mono' : ''}`}>
                {revealed[index] && decrypted[index] != null ? decrypted[index] : row.maskedPreview}
              </div>

              <div className={`flex items-center gap-1 shrink-0 ${multiField ? 'mt-1' : ''}`}>
                <button
                  onClick={() => handleToggleReveal(index)}
                  className="p-1 rounded hover:bg-sh-surface2 text-sh-muted hover:text-sh-fg transition-colors"
                  title={revealed[index] ? '隐藏明文' : '查看明文'}
                  aria-label={revealed[index] ? '隐藏明文' : '查看明文'}
                >
                  {revealed[index] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => handleCopy(index)}
                  className="px-2 py-1 rounded bg-sh-surface2 hover:bg-sh-line text-sh-fg text-[10px] sm:text-[11px] flex items-center gap-1 transition-colors whitespace-nowrap"
                  title={`复制${row.label ? ` ${row.label}` : '明文'}`}
                >
                  {copiedIndex === index ? <Check className="w-3 h-3 text-sh-ok" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedIndex === index ? '已复制' : '复制'}</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {errorMsg && (
          <div className="mt-2 rounded-lg border border-sh-danger/50 bg-sh-danger/10 px-2 py-1.5 text-[10px] text-sh-danger">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Security Status Tag */}
      <div className="flex items-center justify-between text-[10px] text-sh-subtle mt-2.5 pt-2 border-t border-sh-line">
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Shield className="w-3 h-3 text-sh-ok shrink-0" />
          <span>{multiField ? `${rows.length} 个字段 · AES-256-GCM 加密` : 'AES-256-GCM 零知识加密'}</span>
        </div>
        {!masterPassword && (
          <span className="flex items-center gap-1 text-sh-warn font-medium whitespace-nowrap">
            <Lock className="w-3 h-3 shrink-0" />
            需主密码
          </span>
        )}
      </div>
    </div>
  );
};
