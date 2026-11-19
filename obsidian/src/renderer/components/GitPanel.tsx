import { useEffect, useState } from 'react';
import type { GitCommit, GitFileChange } from '../../shared/types';
import { api } from '../lib/api';
import { basename, dirname, timeAgo } from '../lib/format';
import { useStore } from '../state/store';
import { gitBadge } from './FileTree';
import { Icon } from './Icon';
import { Button, Empty, IconButton, Provenance, SectionHeader } from './ui';

export function ChangeRow({ projectId, change, staged, actions = true }: { projectId: string; change: GitFileChange; staged: boolean; actions?: boolean }) {
  const openDiff = useStore((s) => s.openDiff);
  const refresh = useStore((s) => s.refreshGit);
  const toast = useStore((s) => s.toast);
  const badge = staged
    ? { letter: change.index === '.' ? 'M' : change.index, tone: change.index === 'D' ? 'err' : change.index === 'A' ? 'ok' : 'warn' }
    : gitBadge(change);

  const act = async (kind: 'stage' | 'unstage' | 'discard') => {
    const channel = kind === 'stage' ? 'git:stage' : kind === 'unstage' ? 'git:unstage' : 'git:discard';
    const res = await api.invoke(channel, projectId, [change.path]);
    if (!res.ok && res.error !== 'Cancelled') toast('error', res.error);
    void refresh(projectId);
  };

  return (
    <div className="change-row">
      <button className="change-main" onClick={() => openDiff(projectId, change.path, staged)} title={`Open diff: ${change.path}`}>
        <span className={`tree-badge tone-${badge?.tone}`}>{badge?.letter}</span>
        <span className="change-name">{basename(change.path)}</span>
        <span className="change-dir mono">{dirname(change.path)}</span>
      </button>
      {actions && (
        <span className="change-actions">
          {!staged && !change.untracked && !change.conflicted && <IconButton icon="undo" label="Discard changes…" size={13} onClick={() => act('discard')} />}
          {staged ? <IconButton icon="unstage" label="Unstage" size={13} onClick={() => act('unstage')} /> : <IconButton icon="stage" label="Stage" size={13} onClick={() => act('stage')} />}
        </span>
      )}
    </div>
  );
}

export function GitPanel({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const status = useStore((s) => s.git[projectId]);
  const refresh = useStore((s) => s.refreshGit);
  const toast = useStore((s) => s.toast);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<GitCommit[] | null>(null);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);
  useEffect(() => {
    if (!status?.isRepo) return;
    void api.invoke('git:log', projectId).then(setLog);
  }, [projectId, status?.isRepo, status?.updatedAt]);

  if (!status) return <div className="tree-loading">Reading git status…</div>;
  if (!status.isRepo) {
    return (
      <Empty icon="git" title="Not a git repository">
        {status.error ? status.error : 'This folder is not under version control. Run `git init` in a shell tab to start tracking it.'}
      </Empty>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);

  const commit = async () => {
    if (!staged.length) return toast('warn', 'Stage at least one file before committing.');
    if (!message.trim()) return toast('warn', 'Write a commit message first.');
    setBusy(true);
    const res = await api.invoke('git:commit', projectId, message);
    setBusy(false);
    if (res.ok) {
      toast('ok', `Committed ${res.value}`);
      setMessage('');
    } else toast('error', res.error);
    void refresh(projectId);
  };

  const stageAll = async () => {
    const paths = unstaged.filter((f) => !f.conflicted).map((f) => f.path);
    if (!paths.length) return;
    const res = await api.invoke('git:stage', projectId, paths);
    if (!res.ok) toast('error', res.error);
    void refresh(projectId);
  };

  return (
    <div className={`git-panel ${compact ? 'is-compact' : ''}`}>
      <div className="git-branch">
        <Icon name="branch" size={14} />
        <span className="mono git-branch-name">{status.detached ? 'detached HEAD' : status.branch}</span>
        {status.upstream && (
          <span className="git-ab mono" title={`Tracking ${status.upstream}`}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <span className="flex-1" />
        <Provenance kind="git" />
        <IconButton icon="refresh" label="Refresh git status" size={13} onClick={() => refresh(projectId)} />
      </div>

      <div className="commit-box">
        <textarea
          className="input commit-input"
          placeholder={staged.length ? `Commit message (${staged.length} staged)` : 'Stage files to commit'}
          value={message}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit();
          }}
          aria-label="Commit message"
        />
        <Button variant="primary" icon="check" disabled={busy || !staged.length || !message.trim()} onClick={commit}>
          Commit
        </Button>
      </div>

      <SectionHeader title="Staged" count={staged.length} />
      {staged.length ? staged.map((f) => <ChangeRow key={`s:${f.path}`} projectId={projectId} change={f} staged />) : <div className="muted-row">Nothing staged</div>}

      <SectionHeader title="Changes" count={unstaged.length}>
        {unstaged.length > 0 && (
          <button className="link-btn" onClick={stageAll}>
            Stage all
          </button>
        )}
      </SectionHeader>
      {unstaged.length ? unstaged.map((f) => <ChangeRow key={`w:${f.path}`} projectId={projectId} change={f} staged={false} />) : <div className="muted-row">Working tree clean</div>}

      {!compact && (
        <>
          <SectionHeader title="Recent commits" count={log?.length ?? 0} />
          {(log ?? []).map((c) => (
            <div key={c.hash} className="commit-row" title={`${c.hash}\n${c.author}`}>
              <span className="mono commit-hash">{c.short}</span>
              <span className="commit-subject">{c.subject}</span>
              <span className="commit-time">{timeAgo(c.date)}</span>
            </div>
          ))}
        </>
      )}
      {status.error && <div className="tree-error">{status.error}</div>}
    </div>
  );
}
