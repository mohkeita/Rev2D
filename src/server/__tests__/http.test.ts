import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { LOCAL_HOSTS, allowedHostnames, normalizeHostname, parseHostHeader } from '../http.js';
import { SseHub } from '../sse.js';

describe('Host header parsing', () => {
  it('returns the canonical hostname of well-formed values', () => {
    expect(parseHostHeader('127.0.0.1:4777')).toBe('127.0.0.1');
    expect(parseHostHeader('LOCALHOST')).toBe('localhost');
    expect(parseHostHeader('[::1]:4777')).toBe('[::1]');
    expect(parseHostHeader('[0:0:0:0:0:0:0:1]')).toBe('[::1]');
    expect(parseHostHeader('my-pc.local:80')).toBe('my-pc.local');
  });

  it('rejects anything that is not host[:port]', () => {
    for (const bad of ['', 'evil.example@127.0.0.1', '127.0.0.1/x', '127.0.0.1:1:2', '127.0.0.1:x', '127.0.0.1:99999', 'a b', '::1', '[::1']) {
      expect(parseHostHeader(bad), bad).toBeNull();
    }
  });
});

describe('allowed host names', () => {
  it('normalizes user-supplied names, addresses, host:port pairs and URLs', () => {
    expect(normalizeHostname('My.Host')).toBe('my.host');
    expect(normalizeHostname('my.host:4777')).toBe('my.host');
    expect(normalizeHostname('http://my.host:4777/')).toBe('my.host');
    expect(normalizeHostname('::1')).toBe('[::1]');
    expect(normalizeHostname('[fe80::1]:80')).toBe('[fe80::1]');
    expect(() => normalizeHostname('not a host')).toThrow(/not a host name/);
  });

  it('accepts only loopback names for a loopback bind', () => {
    expect([...allowedHostnames('127.0.0.1')].sort()).toEqual([...LOCAL_HOSTS].sort());
    expect([...allowedHostnames('localhost')].sort()).toEqual([...LOCAL_HOSTS].sort());
  });

  it('adds the bound address, and every interface address for a wildcard bind', () => {
    expect(allowedHostnames('127.0.0.2').has('127.0.0.2')).toBe(true);
    expect(allowedHostnames('My-PC.local').has('my-pc.local')).toBe(true);
    const ifaces: Record<string, NetworkInterfaceInfo[]> = {
      eth0: [
        { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.5/24' },
        { address: 'fe80::5', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fe80::5/64', scopeid: 7 },
      ],
    };
    for (const wildcard of ['0.0.0.0', '::']) {
      const allowed = allowedHostnames(wildcard, ['lan-name'], ifaces);
      for (const h of [...LOCAL_HOSTS, '192.168.1.5', '[fe80::5]', 'lan-name']) expect(allowed.has(h), `${wildcard} ${h}`).toBe(true);
      expect(allowed.has('0.0.0.0')).toBe(false);
    }
  });
});

describe('SseHub', () => {
  it('does not count clients that disconnected before their stream opened', async () => {
    const hub = new SseHub();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrive!: (r: { socketClosed: Promise<void> }) => void;
    const arrived = new Promise<{ socketClosed: Promise<void> }>((resolve) => (arrive = resolve));
    // The handler looks something up before opening the stream (like the editor's hello event).
    const server = http.createServer(async (req, res) => {
      arrive({ socketClosed: new Promise((resolve) => req.socket.once('close', () => resolve())) });
      await gate;
      hub.open(req, res, { event: 'hello', data: {} });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/', agent: false });
      client.on('error', () => undefined);
      const { socketClosed } = await arrived;
      client.destroy();
      await socketClosed;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(hub.size).toBe(0);
      expect(hub.broadcast('command', { type: 'reload' })).toBe(0);
    } finally {
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
