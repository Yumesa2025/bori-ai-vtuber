import { forwardRef, type KeyboardEvent } from "react";
import { MAX_MESSAGE_LENGTH } from "../api";

type Props = {
  value: string;
  sending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

/** Enter로 보내고 Shift+Enter로 줄을 바꾼다. 보내는 동안은 입력을 잠근다. */
export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer({ value, sending, onChange, onSubmit }, ref) {
  const trimmed = value.trim();
  const canSend = !sending && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_LENGTH;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter는 글자 확정이라 전송하지 않는다.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSubmit();
  };

  return (
    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) onSubmit(); }}>
      <label htmlFor="composer-input" className="visually-hidden">메시지</label>
      <textarea
        id="composer-input"
        ref={ref}
        value={value}
        rows={2}
        maxLength={MAX_MESSAGE_LENGTH}
        disabled={sending}
        placeholder={sending ? "답변을 기다리는 중" : "메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"}
        aria-describedby="composer-count"
        onChange={event => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer-side">
        <span id="composer-count" className="composer-count">{value.length}/{MAX_MESSAGE_LENGTH}</span>
        <button type="submit" className="primary-button" disabled={!canSend}>{sending ? "보내는 중" : "보내기"}</button>
      </div>
    </form>
  );
});
