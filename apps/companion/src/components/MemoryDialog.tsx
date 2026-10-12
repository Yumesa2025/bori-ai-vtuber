import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type Memory } from "../api";

type Props = { open: boolean; onClose: () => void };

const dateFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "numeric", day: "numeric" });
const formatDate = (iso: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
};

/**
 * 보리가 나에 대해 기억하는 내용(본인 private 기억)을 보고 지운다.
 * 서버가 본인 기억만 돌려주므로 화면은 받은 목록을 그대로 보여 준다.
 */
export function MemoryDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setNotice("");
    api.listMemories()
      .then(setMemories)
      .catch(error => setNotice(describeError(error)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); setConfirmAll(false); load(); }
    if (!open && dialog.open) dialog.close();
  }, [open, load]);

  const removeOne = (id: string) => {
    setBusyId(id);
    setNotice("");
    api.deleteMemory(id)
      .then(() => setMemories(current => current.filter(memory => memory.id !== id)))
      // 이미 지워진 기억이면 목록을 다시 받아 화면을 서버와 맞춘다.
      .catch(error => { setNotice(describeError(error)); load(); })
      .finally(() => setBusyId(null));
  };

  const removeAll = () => {
    setBusyId("*");
    setNotice("");
    api.deleteAllMemories()
      .then(count => { setMemories([]); setConfirmAll(false); setNotice(`기억 ${count}개를 지웠어요.`); })
      .catch(error => setNotice(describeError(error)))
      .finally(() => setBusyId(null));
  };

  return (
    <dialog ref={dialogRef} className="memory-dialog" aria-labelledby="memory-title" onCancel={event => { event.preventDefault(); onClose(); }}>
      <header className="dialog-header">
        <h2 id="memory-title">내 기억</h2>
        <button type="button" className="icon-button" aria-label="닫기" onClick={onClose}>×</button>
      </header>
      <p className="muted">보리가 1:1 대화에서 기억한 내 이야기예요. 방송에는 쓰이지 않아요.</p>
      {notice && <p className="inline-notice" role="status">{notice}</p>}
      {loading && <p className="muted">불러오는 중</p>}
      {!loading && memories.length === 0 && <p className="muted">기억된 내용이 없어요.</p>}
      <ul className="memory-list">
        {memories.map(memory => (
          <li key={memory.id}>
            <div>
              <p>{memory.text}</p>
              <span className="memory-meta">
                {formatDate(memory.createdAt)}
                {formatDate(memory.expiresAt) && ` · ${formatDate(memory.expiresAt)}까지 보관`}
              </span>
            </div>
            <button type="button" className="ghost-button" onClick={() => removeOne(memory.id)} disabled={busyId !== null}>
              {busyId === memory.id ? "지우는 중" : "지우기"}
            </button>
          </li>
        ))}
      </ul>
      {memories.length > 0 && (
        <div className="dialog-actions">
          {confirmAll ? (
            <>
              <span className="confirm-text">기억을 모두 지울까요? 되돌릴 수 없어요.</span>
              <button type="button" className="ghost-button" onClick={() => setConfirmAll(false)} disabled={busyId !== null}>취소</button>
              <button type="button" className="danger-button" onClick={removeAll} disabled={busyId !== null}>{busyId === "*" ? "지우는 중" : "모두 지우기"}</button>
            </>
          ) : (
            <button type="button" className="danger-button" onClick={() => setConfirmAll(true)} disabled={busyId !== null}>전체 삭제</button>
          )}
        </div>
      )}
    </dialog>
  );
}
