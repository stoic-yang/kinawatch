import { useState } from "react";
import { ThumbsUp } from "lucide-react";

export function BeliefLikeButton({ title, liked, count, disabled, pending, onToggle }: {
  title: string; liked: boolean; count: number; disabled: boolean; pending: boolean; onToggle: () => void;
}) {
  const [feedback, setFeedback] = useState<{liked: boolean; sequence: number} | null>(null);
  const motion = feedback?.liked === liked ? (liked ? "like" : "unlike") : undefined;
  return <button type="button" className="belief-like" disabled={disabled && !pending} aria-disabled={disabled} aria-pressed={liked} aria-busy={pending}
    aria-label={(liked ? "取消今日点赞：" : "今日点赞：") + title + "，累计 " + count + " 次"}
    title={liked ? "今日已点赞，点击取消" : "每天可点赞一次"}
    onClick={() => {if (disabled) return; setFeedback(previous => ({liked: !liked, sequence: (previous?.sequence ?? 0) + 1})); onToggle();}}>
    <span key={"icon-" + feedback?.sequence} className="belief-like-icon" data-feedback={motion} aria-hidden="true"><ThumbsUp size={17}/></span>
    <span key={"count-" + feedback?.sequence} className="belief-like-count" data-feedback={motion} aria-hidden="true">{count}</span>
  </button>;
}
