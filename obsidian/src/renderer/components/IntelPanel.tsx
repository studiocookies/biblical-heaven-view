import { useMemo, useState } from 'react';
import type { Task } from '../../shared/types';
import { duration } from '../lib/format';
import { activeProject, activeSession, useStore, type RightTab } from '../state/store';
import { ChangeRow, GitPanel } from './GitPanel';
import { Icon } from './Icon';
import { Empty, IconButton, KV, Provenance, SectionHeader, Tabs } from './ui';

const newId = () => Math.random().toString(36).slice(2, 12);

function TasksTab() {
  const session = useStore(activeSession);
  const insight = useStore((s) => (session ? s.insights[session.id] : undefined));
  const tasks = useStore((s) => s.tasks);
  const project = useStore(activeProject);
  const saveTasks = useStore((s) => s.saveTasks);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [scope, setScope] = useState<'project' | 'all'>('project');

  const visible = tasks.filter((t) => scope === 'all' || t.projectId === null || t.projectId === project?.id);
  const open = visible.filter((t) => !t.done);
  const done = visible.filter((t) => t.done);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    const now = Date.now();
    void saveTasks([...tasks, { id: newId(), projectId: project?.id ?? null, title, done: false, createdAt: now, updatedAt: now }]);
    setDraft('');
  };
  const update = (id: string, patch: Partial<Task>) => void saveTasks(tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)));
  const remove = (id: string) => void saveTasks(tasks.filter((t) => t.id !== id));

  const row = (t: Task) => (
    <div key={t.id} className={`task-row ${t.done ? 'is-done' : ''}`}>
      <button className={`check ${t.done ? 'is-on' : ''}`} role="checkbox" aria-checked={t.done} aria-label={t.done ? 'Mark not done' : 'Mark done'} onClick={() => update(t.id, { done: !t.done })}>
        {t.done && <Icon name="check" size={11} />}
      </button>
      {editing === t.id ? (
        <input
          className="input task-edit"
          autoFocus
          defaultValue={t.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== t.title) update(t.id, { title: v });
            setEditing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(null);
          }}
          aria-label="Edit task"
        />
      ) : (
        <span className="task-title" onDoubleClick={() => setEditing(t.id)}>
          {t.title}
        </span>
      )}
      <span className="task-actions">
        <IconButton icon="edit" label="Edit task" size={12} onClick={() => setEditing(t.id)} />
        <IconButton icon="trash" label="Delete task" size={12} onClick={() => remove(t.id)} />
      </span>
    </div>
  );

  return (
    <div className="intel-scroll">
      <SectionHeader title="Claude's plan" count={insight?.todos?.length ?? 0}>
        <Provenance kind="transcript" />
      </SectionHeader>
      {!session || session.kind !== 'claude' ? (
        <div className="muted-row">Open a Claude Code session to see its task list.</div>
      ) : insight?.todos && insight.todos.length ? (
        insight.todos.map((t, i) => (
          <div key={i} className={`todo-row todo-${t.status}`}>
            <span className="todo-mark">{t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? <span className="led" data-state="busy" /> : <span className="todo-empty" />}</span>
            <span className="todo-text">{t.content}</span>
          </div>
        ))
      ) : (
        <div className="muted-row">Claude hasn’t published a task list in this session. It appears here when Claude uses its todo tool.</div>
      )}

      <SectionHeader title="Your tasks" count={open.length}>
        <button className="link-btn" onClick={() => setScope(scope === 'project' ? 'all' : 'project')}>
          {scope === 'project' ? 'This project' : 'All projects'}
        </button>
      </SectionHeader>
      <div className="task-add">
        <input
          className="input"
          placeholder={project ? `Add a task for ${project.name}…` : 'Add a task…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          aria-label="New task"
        />
        <IconButton icon="plus" label="Add task" onClick={add} disabled={!draft.trim()} />
      </div>
      {open.map(row)}
      {open.length === 0 && <div className="muted-row">No open tasks.</div>}
      {done.length > 0 && (
        <>
          <SectionHeader title="Done" count={done.length}>
            <button className="link-btn" onClick={() => void saveTasks(tasks.filter((t) => !done.includes(t)))}>
              Clear
            </button>
          </SectionHeader>
          {done.map(row)}
        </>
      )}
    </div>
  );
}

function FilesTab() {
  const project = useStore(activeProject);
  const status = useStore((s) => (s.activeProjectId ? s.git[s.activeProjectId] : undefined));
  const session = useStore(activeSession);
  const insight = useStore((s) => (session ? s.insights[session.id] : undefined));
  const openFile = useStore((s) => s.openFile);

  const touched = useMemo(() => {
    const set = new Map<string, string>();
    for (const e of insight?.events ?? []) {
      if (e.kind === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(e.label) && e.detail && !e.detail.startsWith('/')) set.set(e.detail, e.label.split(' ')[0]);
    }
    return [...set.entries()];
  }, [insight?.events]);

  if (!project) return <Empty icon="files" title="No project open" />;
  return (
    <div className="intel-scroll">
      <SectionHeader title="Modified files" count={status?.isRepo ? status.files.length : '—'}>
        <Provenance kind="git" />
      </SectionHeader>
      {!status ? (
        <div className="muted-row">Reading…</div>
      ) : !status.isRepo ? (
        <div className="muted-row">Not a git repository — file changes can’t be listed without git.</div>
      ) : status.files.length === 0 ? (
        <div className="muted-row">Working tree clean.</div>
      ) : (
        status.files.map((f) => <ChangeRow key={f.path} projectId={project.id} change={f} staged={f.staged && !f.unstaged} actions={false} />)
      )}

      {session?.kind === 'claude' && (
        <>
          <SectionHeader title="Edited by this session" count={touched.length}>
            <Provenance kind="transcript" />
          </SectionHeader>
          {touched.length === 0 ? (
            <div className="muted-row">No file edits recorded in this conversation yet.</div>
          ) : (
            touched.map(([rel, tool]) => (
              <button key={rel} className="touched-row" onClick={() => openFile(project.id, rel)}>
                <Icon name="file" size={13} />
                <span className="mono">{rel}</span>
                <span className="flex-1" />
                <span className="tag">{tool}</span>
              </button>
            ))
          )}
        </>
      )}
    </div>
  );
}

function ContextTab() {
  const project = useStore(activeProject);
  const session = useStore(activeSession);
  const insight = useStore((s) => (session ? s.insights[session.id] : undefined));
  const claude = useStore((s) => s.claude);
  const live = useStore((s) => s.liveAgents);
  const settings = useStore((s) => s.settings);
  const git = useStore((s) => (s.activeProjectId ? s.git[s.activeProjectId] : undefined));
  const liveAgent = session?.claudeSessionId ? live?.find((a) => a.sessionId === session.claudeSessionId) : undefined;
  const na = <span className="na">unavailable</span>;

  return (
    <div className="intel-scroll context">
      <SectionHeader title="Project" />
      <KV k="Root" mono>{project?.root ?? na}</KV>
      <KV k="Branch" mono>{git?.isRepo ? `${git.branch ?? 'detached'}${git.upstream ? ` → ${git.upstream}` : ''}` : git ? 'not a repository' : na}</KV>

      <SectionHeader title="Session" />
      {session ? (
        <>
          <KV k="Kind">{session.kind === 'claude' ? 'Claude Code (interactive PTY)' : 'Login shell (PTY)'}</KV>
          <KV k="Launch">{session.mode}{session.permissionMode && session.permissionMode !== 'default' ? ` · ${session.permissionMode}` : ''}</KV>
          <KV k="Claude session" mono>{session.claudeSessionId ?? (session.kind === 'claude' ? 'detecting…' : '—')}</KV>
          <KV k="Process" mono>{session.state}{session.pid ? ` · pid ${session.pid}` : ''}{session.state === 'running' ? ` · ${duration(Date.now() - session.startedAt)}` : ''}</KV>
          <KV k="Command" mono>{session.commandLine || session.error}</KV>
          {session.kind === 'claude' && (
            <>
              <KV k="Model">
                <span className="mono">{insight?.model ?? session.requestedModel ?? 'not yet reported'}</span> <Provenance kind={insight?.model ? 'transcript' : session.requestedModel ? 'requested' : 'unavailable'} />
              </KV>
              <KV k="Live status">
                {liveAgent ? <>{liveAgent.status} <Provenance kind="live" /></> : <span className="na">{claude?.capabilities?.agentsJson ? (settings?.liveStatusPolling ? 'waiting for poll' : 'polling disabled') : 'unsupported by CLI'}</span>}
              </KV>
              <KV k="Transcript">{insight?.transcriptFound ? `${insight.prompts} prompts · ${insight.toolCalls} tool calls` : <span className="na">not written yet</span>}</KV>
            </>
          )}
        </>
      ) : (
        <div className="muted-row">No active session.</div>
      )}

      <SectionHeader title="Claude Code" />
      <KV k="Version" mono>{claude?.version ?? na}</KV>
      <KV k="Executable" mono>{claude?.path ?? na}</KV>
      <KV k="Auth">
        {claude?.auth.state === 'logged-in' ? (
          <>
            signed in · <span className="mono">{claude.auth.method}</span> <Provenance kind="cli" />
          </>
        ) : (
          claude?.auth.state ?? na
        )}
      </KV>
      <KV k="Capabilities" mono>
        {claude?.capabilities
          ? Object.entries(claude.capabilities)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(' ')
          : na}
      </KV>
      <KV k="Transcripts" mono>{claude?.projectsDirectory ?? na}</KV>
      {claude?.apiKeyEnvPresent && (
        <div className="callout warn small">
          <Icon name="warning" size={13} /> ANTHROPIC_API_KEY is set in the environment
        </div>
      )}
      <SectionHeader title="Not available" />
      <div className="pane-note">
        Token usage, cost and context-window fill aren’t exposed by the interactive CLI in a stable form, so OBSIDIAN doesn’t show them. Use <span className="mono">/status</span> or <span className="mono">/cost</span> inside the session.
      </div>
    </div>
  );
}

export function IntelPanel() {
  const tab = useStore((s) => s.rightTab);
  const project = useStore(activeProject);
  const changes = useStore((s) => (s.activeProjectId ? s.git[s.activeProjectId]?.files.length ?? 0 : 0));
  const todos = useStore((s) => {
    const sess = activeSession(s);
    return sess ? s.insights[sess.id]?.todos?.filter((t) => t.status !== 'completed').length ?? 0 : 0;
  });
  return (
    <aside className="intel" aria-label="Intelligence panel">
      <div className="intel-head">
        <Tabs<RightTab>
          ariaLabel="Intelligence panel"
          value={tab}
          onChange={(rightTab) => useStore.setState({ rightTab })}
          tabs={[
            { id: 'tasks', label: 'Tasks', badge: todos ? <span className="seg-badge">{todos}</span> : undefined },
            { id: 'files', label: 'Files', badge: changes ? <span className="seg-badge">{changes}</span> : undefined },
            { id: 'git', label: 'Git' },
            { id: 'context', label: 'Context' },
          ]}
        />
      </div>
      <div className="intel-body">
        {tab === 'tasks' && <TasksTab />}
        {tab === 'files' && <FilesTab />}
        {tab === 'git' && (project ? <div className="intel-scroll"><GitPanel projectId={project.id} compact /></div> : <Empty icon="git" title="No project open" />)}
        {tab === 'context' && <ContextTab />}
      </div>
    </aside>
  );
}
