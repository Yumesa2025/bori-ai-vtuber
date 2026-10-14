import { useEffect, useId, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * 되돌릴 수 없는 지우기 전에 한 번 더 묻는다.
 * 네이티브 dialog를 써서 포커스 가두기와 Esc 닫기를 브라우저에 맡긴다.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // 기억 화면 안에서도 쓰므로 제목 id가 겹치지 않게 한다.
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      <div className="dialog-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>취소</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>{busy ? "지우는 중" : confirmLabel}</button>
      </div>
    </dialog>
  );
}
