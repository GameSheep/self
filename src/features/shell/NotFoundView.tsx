import React from 'react';
import { Compass } from 'lucide-react';
import { EmptyState } from '../../shared/ui';

export interface NotFoundViewProps {
  onNavigate: (path: string) => void;
}

/**
 * Unknown route (P1-01).
 *
 * The old build simply rendered nothing for an unrecognised tab, which looks
 * identical to a crash. An explicit state with a way back is required by
 * "非法/缺失页面处理" in the plan.
 */
export const NotFoundView: React.FC<NotFoundViewProps> = ({ onNavigate }) => (
  <div data-testid="not-found-view">
    <EmptyState
      icon={<Compass className="w-6 h-6" />}
      title="页面不存在"
      description="这个地址没有对应的页面。可能是链接过期，或数据来自另一台设备。"
      action={
        <>
          <button
            onClick={() => onNavigate('#/home')}
            className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg text-xs font-semibold"
          >
            返回首页
          </button>
          <button
            onClick={() => onNavigate('#/library')}
            className="px-3 py-1.5 rounded-lg border border-sh-line text-xs"
          >
            去资料库
          </button>
        </>
      }
    />
  </div>
);

export default NotFoundView;
