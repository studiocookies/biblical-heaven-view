import { useCallback, useEffect, useState } from 'react';
import type { AgentDefinition, HistoryEntry, LiveAgent } from '../../shared/types';
import { api } from '../lib/api';
import { bytes, shortId, timeAgo } from '../lib/format';
import { activeProject, useStore } from '../state/store';
import { FileTree } from './FileTree';
import { GitPanel } from './GitPanel';
import { Icon } from './Icon';
import { Button, Empty, IconButton, Provenance, SectionHeader } from './ui';

function ProjectsPane() {
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const sessions = useStore((s) => s.sessions);
  const git = useStore((s) => s.git);
  const { addProject, selectProject, removeProject } = useStore.getState();
  const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const project = useStore(activeProject);

  return (
    <div className="pane">
      <SectionHeader title="Projects" count={projects.length}>
        <IconButton icon="plus" label="Open project folder…" onClick={() => void addProject()} />
      </SectionHeader>
      {sorted.length === 0 ? (
        <Empty icon="projects" title="No projects yet">
          Choose a folder on your Mac. OBSIDIAN only reads folders you pick.
          <Button variant="primary" icon="plus" onClick={() => void addProject()}>
            Open Folder…
          </Button>
        </Empty>
      ) : (
        <div className="project-list">
          {sorted.map((p) => {
            const live = Object.values(sessions).filter((x) => x.projectId === p.id && x.state === 'running');
            const g = git[p.id];
            return (
              <div key={p.id} className={`project-row ${p.id === activeId ? 'is-active' : ''}`}>
                <button className="project-main" onClick={() => selectProject(p.id)} title={p.root}>
                  <Icon name={p.id === activeId ? 'folderOpen' : 'folder'} size={15} />
                  <span className="project-text">
                    <span className="project-name">{p.name}</span>
                    <span className="project-meta mono">
                      {g?.isRepo ? `${g.branch ?? 'detached'}${g.files.length ? ` · ${g.files.length}Δ` : ''}` : timeAgo(p.lastOpenedAt)}
                    </span>
                  </span>
                  {live.length > 0 && (
                    <span className="project-live" title={`${live.length} running session(s)`}>
                      <span className="led" data-state={live.some((l) => l.kind === 'claude') ? 'busy' : 'ok'} />
                      {live.length}
                    </span>
                  )}
                </button>
                <IconButton
                  icon="close"
                  size={12}
                  className="project-remove"
                  label={`Remove ${p.name} from the list`}
                  onClick={() => {
                    if (window.confirm(`Remove "${p.name}" from OBSIDIAN's project list?\n\nNo files are touched.`)) void removeProject(p.id);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {project && (
        <>
          <SectionHeader title={`Files · ${project.name}`}>
            <IconButton icon="reveal" label="Reveal in Finder" size={13} onClick={() => void api.invoke('projects:reveal', project.id, '')} />
          </SectionHeader>
          <div className="pane-scroll">
            <FileTree projectId={project.id} />
          </div>
        </>
      )}
    </div>
  );
}

function SessionsPane() {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const project = useStore(activeProject);
  const settings = useStore((s) => s.settings);
  const claude = useStore((s) => s.claude);
  const titles = useStore((s) => s.sessionTitles);
  const live = useStore((s) => s.liveAgents);
  const attention = useStore((s) => s.attention);
  const { activateTab, startSession } = useStore.getState();
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  const loadHistory = useCallback(() => {
    if (!project) return setHistory(null);
    void api.invoke('claude:history', project.id).then(setHistory);
  }, [project]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory, claude?.projectsDirectory]);

  const list = Object.values(sessions).sort((a, b) => b.startedAt - a.startedAt);
  const openIds = new Set(list.map((s) => s.claudeSessionId).filter(Boolean));

  return (
    <div className="pane">
      <SectionHeader title="Open in OBSIDIAN" count={list.length} />
      {list.length === 0 && <div className="muted-row">No sessions open</div>}
      {list.map((s) => {
        const status = s.claudeSessionId ? live?.find((a) => a.sessionId === s.claudeSessionId)?.status : undefined;
        return (
          <button key={s.id} className="session-row" onClick={() => activateTab(s.id)}>
            <span className="led" data-state={s.state === 'running' ? (status === 'busy' ? 'busy' : 'ok') : s.state === 'failed' ? 'err' : 'off'} />
            <Icon name={s.kind === 'claude' ? 'claude' : 'terminal'} size={14} />
            <span className="session-text">
              <span className="session-title">{titles[s.id] || s.title}</span>
              <span className="session-meta mono">
                {projects.find((p) => p.id === s.projectId)?.name} · {s.state}
                {status ? ` · ${status}` : ''}
              </span>
            </span>
            {attention[s.id] && <span className="attn-dot" aria-label="Needs attention" />}
          </button>
        );
      })}

      {project && settings?.restoreSessions !== 'none' && (
        <>
          <SectionHeader title={`Conversations · ${project.name}`} count={history?.length ?? '…'}>
            <IconButton icon="refresh" label="Reload history" size={13} onClick={loadHistory} />
          </SectionHeader>
          <div className="pane-note">
            Stored by Claude Code in <span className="mono">{claude?.projectsDirectory ?? '~/.claude/projects'}</span>. Titles are read locally and never copied. <Provenance kind="transcript" />
          </div>
          <div className="pane-scroll">
            {history?.length === 0 && <div className="muted-row">No saved conversations for this folder yet.</div>}
            {history?.map((h) => (
              <div key={h.claudeSessionId} className="history-row">
                <div className="history-text">
                  <span className="history-title">{h.title ?? 'Untitled conversation'}</span>
                  <span className="history-meta mono">
                    {shortId(h.claudeSessionId)} · {timeAgo(h.modifiedAt)} · {bytes(h.sizeBytes)}
                    {h.startedInObsidian ? ' · obsidian' : ''}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  icon="resume"
                  disabled={!claude?.capabilities?.resume || openIds.has(h.claudeSessionId)}
                  title={openIds.has(h.claudeSessionId) ? 'Already open' : `claude --resume ${h.claudeSessionId}`}
                  onClick={() => void startSession({ kind: 'claude', mode: 'resume', resumeId: h.claudeSessionId, title: h.title?.slice(0, 60) ?? undefined })}
                >
                  Resume
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
      {project && settings?.restoreSessions === 'none' && <div className="pane-note">Conversation history is hidden (Settings → Sessions).</div>}
    </div>
  );
}

function AgentsPane() {
  const claude = useStore((s) => s.claude);
  const live = useStore((s) => s.liveAgents);
  const sessions = useStore((s) => s.sessions);
  const project = useStore(activeProject);
  const [defs, setDefs] = useState<AgentDefinition[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const agents = await api.invoke('claude:liveAgents');
    useStore.setState({ liveAgents: agents });
    setLoading(false);
  };
  useEffect(() => {
    void api.invoke('claude:agentDefinitions', project?.id ?? null).then(setDefs);
    if (claude?.capabilities?.agentsJson) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, claude?.capabilities?.agentsJson]);

  const ownPids = new Set(Object.values(sessions).map((s) => s.pid));

  return (
    <div className="pane">
      <SectionHeader title="Active Claude sessions" count={live?.length ?? '—'}>
        <IconButton icon="refresh" label="Refresh" size={13} onClick={refresh} disabled={!claude?.capabilities?.agentsJson || loading} />
      </SectionHeader>
      {!claude?.capabilities?.agentsJson ? (
        <div className="pane-note">This Claude Code version doesn’t offer <span className="mono">claude agents --json</span>, so live agent status is unavailable.</div>
      ) : (
        <>
          <div className="pane-note">
            Reported by <span className="mono">claude agents --json</span> — includes sessions started outside OBSIDIAN. <Provenance kind="live" />
          </div>
          {live?.length === 0 && <div className="muted-row">No active sessions reported.</div>}
          {live?.map((a: LiveAgent) => (
            <div key={a.sessionId} className="agent-row">
              <span className="led" data-state={a.status === 'busy' ? 'busy' : a.status ? 'ok' : 'off'} />
              <div className="agent-text">
                <span className="agent-name">{a.name || shortId(a.sessionId)}</span>
                <span className="agent-meta mono">
                  {a.kind ?? '?'} · {a.status ?? 'unknown'} · pid {a.pid ?? '?'}
                  {a.pid && ownPids.has(a.pid) ? ' · this app' : ''}
                </span>
                {a.cwd && <span className="agent-meta mono">{a.cwd}</span>}
              </div>
            </div>
          ))}
        </>
      )}

      <SectionHeader title="Subagent definitions" count={defs?.length ?? '…'} />
      <div className="pane-note">
        From <span className="mono">.claude/agents</span> in the project and <span className="mono">~/.claude/agents</span>. Claude Code decides when to use them.
      </div>
      <div className="pane-scroll">
        {defs?.length === 0 && <div className="muted-row">No custom subagents defined.</div>}
        {defs?.map((d) => (
          <div key={d.file} className="agent-row">
            <Icon name="agents" size={14} />
            <div className="agent-text">
              <span className="agent-name">
                {d.name} <span className="tag">{d.scope}</span>
                {d.model && <span className="tag mono">{d.model}</span>}
              </span>
              {d.description && <span className="agent-desc">{d.description}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesPane() {
  const project = useStore(activeProject);
  const [filter, setFilter] = useState('');
  if (!project) return <Empty icon="files" title="No project open">Open a project to browse its files.</Empty>;
  return (
    <div className="pane">
      <SectionHeader title={project.name}>
        <IconButton icon="search" label="Quick open (fuzzy)" size={13} onClick={() => useStore.setState({ paletteOpen: 'files' })} />
        <IconButton icon="reveal" label="Reveal in Finder" size={13} onClick={() => void api.invoke('projects:reveal', project.id, '')} />
      </SectionHeader>
      <input className="input pane-filter" placeholder="Filter loaded files…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
      <div className="pane-scroll">
        <FileTree projectId={project.id} filter={filter} />
      </div>
    </div>
  );
}

function GitPane() {
  const project = useStore(activeProject);
  if (!project) return <Empty icon="git" title="No project open">Open a project to see its repository.</Empty>;
  return (
    <div className="pane">
      <SectionHeader title={`Source control · ${project.name}`} />
      <div className="pane-scroll">
        <GitPanel projectId={project.id} />
      </div>
    </div>
  );
}

const SETTINGS_SECTIONS = ['Claude Code', 'Projects', 'Workspace', 'Terminal', 'Appearance', 'Sessions', 'Shortcuts', 'Data & Privacy'];
function SettingsPane() {
  return (
    <div className="pane">
      <SectionHeader title="Settings" />
      {SETTINGS_SECTIONS.map((s) => (
        <button key={s} className="settings-nav" onClick={() => document.getElementById(`settings-${s.replace(/\W+/g, '-').toLowerCase()}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          {s}
        </button>
      ))}
    </div>
  );
}

export function Sidebar() {
  const nav = useStore((s) => s.nav);
  return (
    <aside className="sidebar" aria-label="Navigator">
      {nav === 'home' || nav === 'projects' ? <ProjectsPane /> : null}
      {nav === 'sessions' && <SessionsPane />}
      {nav === 'agents' && <AgentsPane />}
      {nav === 'files' && <FilesPane />}
      {nav === 'git' && <GitPane />}
      {nav === 'settings' && <SettingsPane />}
    </aside>
  );
}
