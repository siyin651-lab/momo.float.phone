"use client";

import { memo, useState } from "react";

import { PhoneChatApp } from "@/components/chat/phone-chat-app";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import type { MomentPost } from "@/lib/moments-types";

function MiniPhoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 5h4M10.7 18.6h2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export type FloatingPhoneProps = {
  /** 是否显示悬浮小手机，默认 true。各 app 可接自己的设置开关。 */
  enabled?: boolean;
  /** 打开时预选的聊天会话 id（剧情里绑定当前角色/群聊）。 */
  initialSessionId?: string | null;
  /** 用户在浮层内发送消息后的回调（剧情用来回写剧情痕迹，其它 app 可不传）。 */
  onUserMessageSent?: (message: ChatMessage, session: ChatSession) => void;
  /** 用户在浮层内发布动态后的回调。 */
  onMomentPublished?: (post: MomentPost) => void;
  /** 悬浮球的无障碍标签。 */
  label?: string;
};

/**
 * 悬浮小手机：一个固定在右下角的圆形按钮，点击后展开一个独立的小手机浮层。
 * 浮层内直接挂 PhoneChatApp（自带「消息 / 动态 / 我」三个 tab），因此聊天与
 * 朋友圈能力完全复用，不依赖任何具体 app 的状态。剧情 app 里的悬浮小手机普通
 * 模式就是这一形态，这里把它抽成通用组件，供共创、冒险等 app 直接挂载。
 */
export const FloatingPhone = memo(function FloatingPhone({
  enabled = true,
  initialSessionId = null,
  onUserMessageSent,
  onMomentPublished,
  label = "打开悬浮小手机",
}: FloatingPhoneProps) {
  const [open, setOpen] = useState(false);

  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        className="floating-phone-ball"
        onClick={() => setOpen(true)}
        aria-label={label}
      >
        <MiniPhoneIcon size={18} />
      </button>
      {open ? (
        <div className="floating-phone-overlay" onClick={() => setOpen(false)}>
          <div className="floating-phone-chat" onClick={(event) => event.stopPropagation()}>
            <PhoneChatApp
              onClose={() => setOpen(false)}
              initialSessionId={initialSessionId}
              onUserMessageSent={onUserMessageSent}
              onMomentPublished={onMomentPublished}
            />
          </div>
        </div>
      ) : null}
    </>
  );
});
