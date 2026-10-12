import { useEffect, useRef } from "react";

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
 * 되돌릴 수 없는 삭제 전에 한 번 더 묻는다.
 * 네이티브 dialog를 써서 포커스 가두기와 Esc 닫기를 브라우저에 맡긴다.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="confirm-title">{title}</h2>
      <p>{description}</p>
      <div className="dialog-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>취소</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>{busy ? "삭제하는 중" : confirmLabel}</button>
      </div>
    </dialog>
  );
}
