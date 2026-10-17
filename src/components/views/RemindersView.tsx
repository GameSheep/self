import React, { useState, useEffect } from 'react';
import { 
  Clock, 
  Plus, 
  ExternalLink, 
  Trash2, 
  Calendar, 
  AlertTriangle, 
  CreditCard, 
  Server, 
  Globe, 
  ShieldAlert, 
  CheckCircle2, 
  DollarSign,
  Flame,
  ArrowRight,
  Edit3,
  RefreshCw,
  X,
  Check,
  RotateCcw
} from 'lucide-react';
import { ReminderItem } from '../../types';
import { daysUntil, parseDateInputValue, toDateInputValue, advanceRecurringDate, nextRenewal } from '../../lib/dates';
import { requestNotificationPermission } from '../../lib/reminderNotifier';
import { Bell } from 'lucide-react';

interface RemindersViewProps {
  reminders: ReminderItem[];
  onAddReminder: (reminder: ReminderItem) => void;
  onUpdateReminder?: (reminder: ReminderItem) => void;
  onDeleteReminder: (id: string) => void;
  onToggleComplete?: (id: string) => void;
}

export const RemindersView: React.FC<RemindersViewProps> = ({
  reminders,
  onAddReminder,
  onUpdateReminder,
  onDeleteReminder,
  onToggleComplete
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'urgent' | 'subscription' | 'server'>('all');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Form states (Create)
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<'subscription' | 'server' | 'domain' | 'cert' | 'other'>('subscription');
  const [targetDateStr, setTargetDateStr] = useState('');
  const [recurring, setRecurring] = useState<'monthly' | 'yearly' | 'weekly' | 'once'>('monthly');
  const [cost, setCost] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [autoRollover, setAutoRollover] = useState(true);

  // Form states (Edit)
  const [editingReminder, setEditingReminder] = useState<ReminderItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState<'subscription' | 'server' | 'domain' | 'cert' | 'other'>('subscription');
  const [editTargetDateStr, setEditTargetDateStr] = useState('');
  const [editRecurring, setEditRecurring] = useState<'monthly' | 'yearly' | 'weekly' | 'once'>('monthly');
  const [editCost, setEditCost] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editAutoRollover, setEditAutoRollover] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const now = Date.now();

  const getDaysLeft = (targetDate: number) => daysUntil(targetDate, now);

  // Auto-catchup on mount: advance expired items that have autoRollover === true.
  // Bounded by advanceRecurringDate(), which returns null for unknown recurrences —
  // the previous unbounded `while` froze the whole tab on imported bad data.
  useEffect(() => {
    if (!onUpdateReminder) return;
    const nowTs = Date.now();
    reminders.forEach((r) => {
      if (!r.autoRollover || !r.recurring || r.recurring === 'once') return;
      const base = Number(r.targetDate);
      if (!Number.isFinite(base) || base >= nowTs) return;
      const next = advanceRecurringDate(base, r.recurring, nowTs);
      if (next && next.getTime() !== base) {
        onUpdateReminder({ ...r, targetDate: next.getTime() });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedReminders = [...reminders].sort((a, b) => a.targetDate - b.targetDate);

  const urgentCount = sortedReminders.filter(r => getDaysLeft(r.targetDate) <= 7 && !r.completed).length;

  const filteredReminders = sortedReminders.filter(r => {
    if (filter === 'urgent') return getDaysLeft(r.targetDate) <= 7 && !r.completed;
    if (filter === 'subscription') return r.category === 'subscription';
    if (filter === 'server') return r.category === 'server';
    return true;
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !targetDateStr) return;

    const targetTimestamp = parseDateInputValue(targetDateStr);
    if (isNaN(targetTimestamp)) return;

    onAddReminder({
      id: `rem-${Date.now()}`,
      title,
      category,
      targetDate: targetTimestamp,
      recurring,
      cost,
      url,
      notes,
      autoRollover,
      completed: false,
      createdAt: Date.now()
    });

    setIsModalOpen(false);
    setTitle('');
    setCost('');
    setUrl('');
    setNotes('');
    setTargetDateStr('');
    setAutoRollover(true);
    showToast('✅ 提醒事项已创建');
  };

  const handleOpenEdit = (item: ReminderItem) => {
    setEditingReminder(item);
    setEditTitle(item.title);
    setEditCategory(item.category);
    setEditTargetDateStr(toDateInputValue(item.targetDate));
    setEditRecurring(item.recurring || 'monthly');
    setEditCost(item.cost || '');
    setEditUrl(item.url || '');
    setEditNotes(item.notes || '');
    setEditAutoRollover(Boolean(item.autoRollover));
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingReminder || !editTitle.trim() || !editTargetDateStr) return;

    const targetTimestamp = parseDateInputValue(editTargetDateStr);
    if (isNaN(targetTimestamp)) return;

    const updated: ReminderItem = {
      ...editingReminder,
      title: editTitle.trim(),
      category: editCategory,
      targetDate: targetTimestamp,
      recurring: editRecurring,
      cost: editCost.trim(),
      url: editUrl.trim(),
      notes: editNotes.trim(),
      autoRollover: editAutoRollover
    };

    if (onUpdateReminder) {
      onUpdateReminder(updated);
      showToast('💾 提醒已成功修改更新');
    }
    setEditingReminder(null);
  };

  const handleAdvanceCycle = (item: ReminderItem) => {
    if (!item.recurring || item.recurring === 'once') {
      // A one-off item has no next cycle: mark it done instead of inventing +30 days.
      if (onToggleComplete) onToggleComplete(item.id);
      showToast(`✅【${item.title}】是一次性事项，已标记完成`);
      return;
    }

    const nextTs = nextRenewal(item.targetDate, item.recurring);
    if (nextTs === null || nextTs === item.targetDate) {
      showToast(`⚠️【${item.title}】的周期设置无效，无法自动顺延`);
      return;
    }

    const updated: ReminderItem = {
      ...item,
      targetDate: nextTs,
      completed: false
    };

    if (onUpdateReminder) {
      onUpdateReminder(updated);
      showToast(`🎉 已将【${item.title}】顺延至下个周期：${new Date(nextTs).toLocaleDateString()}`);
    }
  };

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'subscription': return <CreditCard className="w-4 h-4 text-sky-400" />;
      case 'server': return <Server className="w-4 h-4 text-emerald-400" />;
      case 'domain': return <Globe className="w-4 h-4 text-indigo-400" />;
      case 'cert': return <ShieldAlert className="w-4 h-4 text-amber-400" />;
      default: return <Clock className="w-4 h-4 text-zinc-400" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-100 text-xs font-mono shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
      
      {/* Header & Urgent Alerts Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121316] p-4 sm:p-5 rounded-2xl border border-[#22242a]">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-400 shrink-0" />
            <h2 className="text-sm sm:text-base font-semibold text-zinc-100">
              倒计时提醒与服务时效管理
            </h2>
            {urgentCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-red-950/80 text-red-400 border border-red-800/60 font-semibold animate-pulse">
                {urgentCount} 项即将到期
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            监控 ChatGPT Plus、VPS 主机、域名与 Token 秘钥到期续费，支持周期自动顺延、修改与一键推进下个周期
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="px-3.5 py-2 rounded-xl bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1.5 hover:bg-white shadow-sm shrink-0 self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建提醒事项</span>
        </button>
      </div>

      {/* Browser notification permission (honest about the page-open limitation) */}
      <NotificationBanner />

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 bg-[#121316] p-1.5 rounded-xl border border-[#22242a] text-xs">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            filter === 'all' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          全部提醒 ({reminders.length})
        </button>
        <button
          onClick={() => setFilter('urgent')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
            filter === 'urgent' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span>7天内紧急 ({urgentCount})</span>
        </button>
        <button
          onClick={() => setFilter('subscription')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            filter === 'subscription' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Plus/软件订阅
        </button>
        <button
          onClick={() => setFilter('server')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            filter === 'server' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          VPS/云服务器
        </button>
      </div>

      {/* Reminders Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {filteredReminders.map((item) => {
          const daysLeft = getDaysLeft(item.targetDate);
          const isUrgent = daysLeft <= 7 && !item.completed;
          const isExpired = daysLeft < 0;

          return (
            <div
              key={item.id}
              className={`p-4 rounded-xl bg-[#121316] border transition-all flex flex-col justify-between ${
                isUrgent ? 'border-red-900/60 shadow-red-950/20 shadow-md' : 'border-[#22242a] hover:border-zinc-700'
              }`}
            >
              <div>
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                      {getCategoryIcon(item.category)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                          {item.title}
                        </h3>
                        {item.autoRollover && (
                          <span className="px-1 py-0.2 rounded text-[9px] font-mono bg-emerald-950/70 text-emerald-400 border border-emerald-800/60 shrink-0">
                            自动顺延
                          </span>
                        )}
                      </div>
                      {item.cost && (
                        <span className="text-[11px] font-mono text-zinc-400 flex items-center gap-0.5 mt-0.5">
                          <DollarSign className="w-3 h-3 text-emerald-400" />
                          {item.cost} {item.recurring ? `(${item.recurring === 'monthly' ? '月付' : item.recurring === 'yearly' ? '年付' : item.recurring === 'weekly' ? '周付' : '单次'})` : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleOpenEdit(item)}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
                      title="编辑修改提醒"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`确定删除提醒 ${item.title} 吗？`)) onDeleteReminder(item.id);
                      }}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-400 transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Countdown Badge Box */}
                <div className="my-3 p-3 rounded-xl bg-zinc-900/70 border border-zinc-800/80 flex items-center justify-between">
                  <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-zinc-400" />
                    <span>到期日: {new Date(item.targetDate).toLocaleDateString()}</span>
                  </div>

                  {item.completed ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/70">
                      已完成
                    </span>
                  ) : isExpired ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-red-950 text-red-400 border border-red-800">
                      已到期
                    </span>
                  ) : daysLeft === 0 ? (
                    <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-red-950/80 text-red-400 border border-red-800/80">
                      今天到期
                    </span>
                  ) : isUrgent ? (
                    <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-red-950/80 text-red-400 border border-red-800/80 animate-pulse">
                      D-{daysLeft} 天 (紧急)
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded text-xs font-mono font-semibold bg-zinc-800 text-emerald-400 border border-zinc-700">
                      倒计 {daysLeft} 天
                    </span>
                  )}
                </div>

                {/* Notes */}
                {item.notes && (
                  <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed mb-2">
                    {item.notes}
                  </p>
                )}
              </div>

              {/* Action Toolbar */}
              <div className="pt-2.5 border-t border-zinc-800/60 mt-2 flex items-center justify-between gap-2 text-xs">
                {/* Advance Cycle / Renew Button */}
                <button
                  onClick={() => handleAdvanceCycle(item)}
                  className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-emerald-400 text-[11px] flex items-center gap-1.5 transition-colors"
                  title="标记本次已扣款/续费，并将到期日推进至下一个周期"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>已续费·顺延下期</span>
                </button>

                {onToggleComplete && (
                  <button
                    onClick={() => onToggleComplete(item.id)}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] flex items-center gap-1.5 transition-colors ${
                      item.completed
                        ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-400 hover:bg-emerald-900/40'
                        : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
                    }`}
                    title={item.completed ? '取消完成标记' : '标记为已处理（保留记录，不再计入紧急提醒）'}
                  >
                    <CheckCircle2 className="w-3 h-3" />
                    <span>{item.completed ? '已完成' : '标记完成'}</span>
                  </button>
                )}

                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:underline flex items-center gap-1 text-[11px] font-medium"
                  >
                    <span>官方控制台</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Reminder Modal */}
      {isModalOpen && (
        <div 
          onClick={() => setIsModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-[#121316] border border-zinc-800 rounded-2xl p-5 shadow-2xl flex flex-col space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                新建倒计时与续费提醒
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-zinc-400 hover:text-white text-xs"
              >
                关闭 (ESC)
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">提醒事项名称</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如: ChatGPT Plus 续期 / 阿里云香港服务器到期"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">类别</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  >
                    <option value="subscription">Plus/软件订阅</option>
                    <option value="server">VPS/服务器</option>
                    <option value="domain">域名到期</option>
                    <option value="cert">Token/证书口令</option>
                    <option value="other">其他时效提醒</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">到期 / 续费截止日期</label>
                  <input
                    type="date"
                    required
                    value={targetDateStr}
                    onChange={(e) => setTargetDateStr(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">续期周期</label>
                  <select
                    value={recurring}
                    onChange={(e) => setRecurring(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  >
                    <option value="monthly">每月自动续费</option>
                    <option value="yearly">按年续费</option>
                    <option value="weekly">按周续费</option>
                    <option value="once">单次时效 (不循环)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">续费金额 (可选)</label>
                  <input
                    type="text"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    placeholder="$20/月 或 ¥199/年"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 p-2 bg-zinc-900/60 rounded-xl border border-zinc-800">
                <input
                  type="checkbox"
                  id="autoRollover"
                  checked={autoRollover}
                  onChange={(e) => setAutoRollover(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0"
                />
                <label htmlFor="autoRollover" className="text-xs text-zinc-300 cursor-pointer">
                  到期后自动顺延至下一周期 (无需每次手动改日期)
                </label>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">续费网址 (URL)</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">备忘与扣款说明</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="例如: 绑定了招行外币卡扣费，提前查额度..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-900 font-semibold text-xs hover:bg-white shadow-sm"
                >
                  保存提醒
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Reminder Modal */}
      {editingReminder && (
        <div 
          onClick={() => setEditingReminder(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-[#121316] border border-zinc-800 rounded-2xl p-5 shadow-2xl flex flex-col space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-emerald-400" />
                编辑续费与倒计时事项
              </h3>
              <button
                onClick={() => setEditingReminder(null)}
                className="text-zinc-400 hover:text-white text-xs"
              >
                关闭 (ESC)
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">提醒事项名称</label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">类别</label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  >
                    <option value="subscription">Plus/软件订阅</option>
                    <option value="server">VPS/服务器</option>
                    <option value="domain">域名到期</option>
                    <option value="cert">Token/证书口令</option>
                    <option value="other">其他时效提醒</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">到期 / 续费截止日期</label>
                  <input
                    type="date"
                    required
                    value={editTargetDateStr}
                    onChange={(e) => setEditTargetDateStr(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">续期周期</label>
                  <select
                    value={editRecurring}
                    onChange={(e) => setEditRecurring(e.target.value as any)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  >
                    <option value="monthly">每月自动续费</option>
                    <option value="yearly">按年续费</option>
                    <option value="weekly">按周续费</option>
                    <option value="once">单次时效 (不循环)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">续费金额</label>
                  <input
                    type="text"
                    value={editCost}
                    onChange={(e) => setEditCost(e.target.value)}
                    placeholder="$20/月 或 ¥199/年"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 p-2 bg-zinc-900/60 rounded-xl border border-zinc-800">
                <input
                  type="checkbox"
                  id="editAutoRollover"
                  checked={editAutoRollover}
                  onChange={(e) => setEditAutoRollover(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0"
                />
                <label htmlFor="editAutoRollover" className="text-xs text-zinc-300 cursor-pointer">
                  到期后自动顺延至下一周期 (无需每次手动改日期)
                </label>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">续费网址 (URL)</label>
                <input
                  type="text"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">备忘与扣款说明</label>
                <textarea
                  rows={2}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-none resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setEditingReminder(null)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-sm"
                >
                  保存更新
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};

/**
 * Browser notification permission strip.
 *
 * Deliberately states the limitation: a web page can only notify while it is
 * open, so we do not promise background alarms.
 */
const NotificationBanner: React.FC = () => {
  const [permission, setPermission] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'
  );
  const [busy, setBusy] = useState(false);

  if (permission === 'granted') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-900/50 bg-emerald-950/25 px-3 py-2 text-[11px] text-emerald-300">
        <Bell className="w-3.5 h-3.5 shrink-0" />
        <span>
          到期提醒已开启：到期前 3 天内、以及已过期的未完成提醒，会在页面打开时推送一次系统通知（每天每项最多一次）。
        </span>
      </div>
    );
  }

  if (permission === 'denied') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-900/50 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-300">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>浏览器已拒绝通知权限，请到地址栏左侧的站点设置里重新允许「通知」。</span>
      </div>
    );
  }

  if (permission === 'unsupported') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px] text-zinc-400">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>当前环境不支持系统通知，到期项只会在本页显示。</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-900/50 bg-sky-950/25 px-3 py-2 text-[11px] text-sky-300">
      <span className="flex items-center gap-2">
        <Bell className="w-3.5 h-3.5 shrink-0" />
        开启浏览器提醒后，到期与逾期项会在页面打开时推送系统通知（浏览器限制：关闭页面后无法提醒）。
      </span>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            const result = await requestNotificationPermission();
            setPermission(result);
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="shrink-0 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-[11px] disabled:opacity-50"
      >
        {busy ? '请求中…' : '开启到期提醒'}
      </button>
    </div>
  );
};
