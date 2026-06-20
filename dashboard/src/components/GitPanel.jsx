import { ArrowUp, Check, CircleDot, GitBranch, GitCommitHorizontal, GitPullRequest, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

function statusText(file) {
  if (file.untracked) return 'новый';
  if (file.index === 'D' || file.worktree === 'D') return 'удалён';
  if (file.index === 'A') return 'добавлен';
  if (file.index === 'R') return 'переименован';
  return file.staged ? 'подготовлен' : 'изменён';
}

export function GitPanel({ git, onCommit, onPush, disabled = false }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const perform = async (action, callback) => {
    setBusy(action);
    try { const completed = await callback(); if (action === 'commit' && completed !== false) setMessage(''); } finally { setBusy(''); }
  };
  if (!git) return <section className="git-section"><h3>Git</h3><p className="git-empty"><LoaderCircle className="spin"/> Проверка репозитория…</p></section>;
  if (!git.available) return <section className="git-section"><h3>Git</h3><p className="git-empty">{git.error || 'Git CLI недоступен.'}</p></section>;
  if (!git.repository) return <section className="git-section"><h3>Git</h3><p className="git-empty">В этой рабочей папке нет Git-репозитория.</p></section>;
  return <section className="git-section">
    <div className="git-heading"><h3>Git</h3><span className={git.dirty ? 'dirty' : 'clean'}><CircleDot/>{git.dirty ? `${git.files.length} изм.` : 'чисто'}</span></div>
    <div className="git-branch"><GitBranch/><strong>{git.branch}</strong>{git.upstream ? <small>{git.upstream}</small> : <small>upstream не задан</small>}</div>
    {git.ahead || git.behind ? <div className="git-sync"><span>↑ {git.ahead}</span><span>↓ {git.behind}</span></div> : null}
    <div className="git-files">{git.files.slice(0, 12).map(file => <div key={`${file.path}-${file.index}-${file.worktree}`}><span className={file.staged ? 'staged' : ''}>{file.staged ? <Check/> : (file.untracked ? '?' : 'M')}</span><code title={file.path}>{file.path}</code><small>{statusText(file)}</small></div>)}{git.files.length > 12 ? <p>Ещё {git.files.length - 12}…</p> : null}</div>
    {git.diff ? <details className="git-diff"><summary><GitPullRequest/> Показать diff</summary><pre>{git.diff}</pre></details> : null}
    <label className="commit-message"><span>Сообщение коммита</span><input value={message} maxLength={200} onChange={event => setMessage(event.target.value)} placeholder="Кратко опишите изменения"/></label>
    <div className="git-actions">
      <button disabled={disabled || !git.dirty || !message.trim() || Boolean(busy)} onClick={() => perform('commit', () => onCommit(message))}>{busy === 'commit' ? <LoaderCircle className="spin"/> : <GitCommitHorizontal/>} Commit</button>
      <button disabled={disabled || Boolean(busy)} onClick={() => perform('push', onPush)}>{busy === 'push' ? <LoaderCircle className="spin"/> : <ArrowUp/>} Push</button>
    </div>
  </section>;
}
