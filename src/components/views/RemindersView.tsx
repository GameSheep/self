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

  const getDaysLeft = (targetDate: number) => {
    return Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));
  };

  // Auto-catchup on mount: advance expired items that have autoRollover === true
  useEffect(() => {
    if (!onUpdateReminder) return;
    const nowTs = Date.now();
    reminders.forEach((r) => {
      if (r.autoRollover && r.recurring && r.recurring !== 'once' && r.targetDate < nowTs) {
        let next = new Date(r.targetDate);
        while (next.getTime() < nowTs) {
          if (r.recurring === 'monthly') next.setMonth(next.getMonth() + 1);
          else if (r.recurring === 'yearly') next.setFullYear(next.getFullYear() + 1);
          else if (r.recurring === 'weekly') next.setDate(next.getDate() + 7);
        }
        onUpdateReminder({ ...r, targetDate: next.getTime() });
      }
    });
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

    const targetTimestamp = new Date(targetDateStr).getTime();
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
    setEditTargetDateStr(new Date(item.targetDate).toISOString().slice(0, 10));
    setEditRecurring(item.recurring || 'monthly');
    setEditCost(item.cost || '');
    setEditUrl(item.url || '');
    setEditNotes(item.notes || '');
    setEditAutoRollover(Boolean(item.autoRollover));
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingReminder || !editTitle.trim() || !editTargetDateStr) return;

    const targetTimestamp = new Date(editTargetDateStr).getTime();
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
    let nextDate = item.targetDate < Date.now() ? new Date() : new Date(item.targetDate);
    if (item.recurring === 'monthly') {
      nextDate.setMonth(nextDate.getMonth() + 1);
    } else if (item.recurring === 'yearly') {
      nextDate.setFullYear(nextDate.getFullYear() + 1);
    } else if (item.recurring === 'weekly') {
      nextDate.setDate(nextDate.getDate() + 7);
    } else {
      nextDate.setDate(nextDate.getDate() + 30);
    }

    const updated: ReminderItem = {
      ...item,
      targetDate: nextDate.getTime(),
      completed: false
    };

    if (onUpdateReminder) {
      onUpdateReminder(updated);
      showToast(`🎉 已将【${item.title}】顺延至下个周期：${nextDate.toLocaleDateString()}`);
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

                  {isExpired ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-red-950 text-red-400 border border-red-800">
                      已到期
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
