import { describe, expect, it } from 'vitest';
import { candidatePaths, parseAuth, parseCapabilities, parseVersion } from '../../src/main/claude/detect';
import { parseAgentFile, parseLiveAgents } from '../../src/main/claude/agents';

const HELP = `Usage: claude [options] [command] [prompt]
Options:
  -c, --continue                        Continue the most recent conversation
  --model <model>                       Model for the current session.
  -n, --name <name>                     Set a display name
  --permission-mode <mode>              Permission mode
  -r, --resume [value]                  Resume a conversation
  --session-id <uuid>                   Use a specific session ID
Commands:
  agents [options]                      Manage background agents
  auth                                  Manage authentication
`;

describe('detection parsing', () => {
  it('parses versions', () => {
    expect(parseVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
    expect(parseVersion('nope')).toBeNull();
  });
  it('feature-detects flags from --help', () => {
    const c = parseCapabilities(HELP, '  --json   Print active sessions');
    expect(c).toEqual({ sessionId: true, resume: true, continue: true, model: true, permissionMode: true, name: true, agentsJson: true, authStatusJson: true });
    const old = parseCapabilities('Options:\n  --model <m>\n', '');
    expect(old.sessionId).toBe(false);
    expect(old.agentsJson).toBe(false);
    expect(old.authStatusJson).toBe(false);
  });
  it('reads only whitelisted auth fields', () => {
    const r = parseAuth(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', email: 'x@y.z', token: 'secret', projectsDirectory: '/h/.claude/projects' }));
    expect(r.auth).toEqual({ state: 'logged-in', method: 'oauth_token', provider: 'firstParty' });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(JSON.stringify(r)).not.toContain('x@y.z');
    expect(parseAuth('{"loggedIn": false}').auth.state).toBe('logged-out');
    expect(parseAuth('garbage').auth.state).toBe('unknown');
  });
  it('includes standard install locations', () => {
    const c = candidatePaths('/usr/bin:/opt/x', '/Users/me');
    expect(c[0]).toBe('/usr/bin/claude');
    expect(c).toContain('/Users/me/.local/bin/claude');
    expect(c).toContain('/opt/homebrew/bin/claude');
  });
});

describe('agents', () => {
  it('parses claude agents --json defensively', () => {
    const out = JSON.stringify([{ pid: 4, cwd: '/p', kind: 'interactive', startedAt: 1, sessionId: 'abc', name: 'n', status: 'busy' }, { junk: true }]);
    expect(parseLiveAgents(out)).toEqual([{ sessionId: 'abc', pid: 4, cwd: '/p', kind: 'interactive', status: 'busy', name: 'n', startedAt: 1 }]);
    expect(parseLiveAgents('not json')).toBeNull();
  });
  it('parses subagent frontmatter', () => {
    const md = '---\nname: reviewer\ndescription: "Reviews code"\nmodel: sonnet\ntools: Read\n---\nBody';
    expect(parseAgentFile(md)).toEqual({ name: 'reviewer', description: 'Reviews code', model: 'sonnet' });
  });
});
