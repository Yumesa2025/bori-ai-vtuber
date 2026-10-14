import { forwardRef, type KeyboardEvent } from "react";
import { MAX_MESSAGE_LENGTH } from "../api";
import { isSubmitEnter, overLengthNotice } from "../ui";

type Props = {
  value: string;
  sending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

/**
 * Enter로 보내고 Shift+Enter로 줄을 바꾼다. 보내는 동안은 입력을 잠근다.
 * 최대 길이를 넘게 붙여 넣어도 말없이 자르지 않고, 넘친 만큼 알려 주며 전송만 막는다.
 */
export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer({ value, sending, onChange, onSubmit }, ref) {
  const trimmed = value.trim();
  const canSend = !sending && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_LENGTH;
  const overNotice = overLengthNotice(value.length, MAX_MESSAGE_LENGTH);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter는 글자 확정이라 전송하지 않는다. Shift+Enter는 줄바꿈으로 둔다.
    if (!isSubmitEnter(event)) return;
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
        disabled={sending}
        placeholder={sending ? "답변을 기다리는 중" : "메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"}
        aria-describedby="composer-count"
        aria-invalid={overNotice !== null}
        onChange={event => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer-side">
        <span id="composer-count" className={`composer-count${overNotice ? " over" : ""}`} role={overNotice ? "alert" : undefined}>{overNotice ?? `${value.length}/${MAX_MESSAGE_LENGTH}`}</span>
        <button type="submit" className="primary-button" disabled={!canSend}>{sending ? "보내는 중" : "보내기"}</button>
      </div>
    </form>
  );
});
