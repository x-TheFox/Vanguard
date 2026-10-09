/**
 * WebSocket Client — Manages real-time connections to Pterodactyl Wings daemons
 *
 * Handles WebSocket connections for console streaming, command sending,
 * and resource monitoring. Manages the JWT refresh lifecycle:
 * - JWT expires after 10 minutes
 * - Refresh at 8 minutes (2-minute safety margin)
 * - Automatic reconnect on close code 4004 (token expired)
 * - Maximum 5 reconnect attempts with exponential backoff
 * - Idle disconnect after 5 minutes with no subscribers
 * - Console buffer of last 200 lines per server
 */

import WebSocket from 'ws';
import { credentialLoader } from '../auth/credentialLoader.js';
import { RATE_LIMITS } from '@edenvanguard/shared';

interface WsConnection {
  ws: WebSocket;
  serverId: string;
  jwt: string;
  wsUrl: string;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  consoleBuffer: string[];
  subscribers: Set<(event: WsEvent) => void>;
}

export interface WsEvent {
  type:
    | 'console_output'
    | 'status'
    | 'stats'
    | 'auth_success'
    | 'jwt_error'
    | 'daemon_message';
  data: unknown;
  serverId: string;
}

const JWT_REFRESH_MS = RATE_LIMITS.PTERO_WS_JWT_REFRESH_MS;
const MAX_RECONNECT_ATTEMPTS = RATE_LIMITS.PTERO_WS_MAX_RECONNECTS;
const MAX_CONSOLE_BUFFER = 200;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class PteroWebSocketManager {
  private connections = new Map<string, WsConnection>();
  private baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.PTERO_PANEL_URL ?? '').replace(/\/$/, '');
  }

  /** Connect to a server's WebSocket */
  async connect(serverId: string): Promise<void> {
    if (this.connections.has(serverId)) {
      return; // Already connected
    }

    // Get WebSocket credentials (Client API)
    const credential = credentialLoader.getCredential('client', serverId);
    if (!credential) {
      throw new Error(`No client credential available for server ${serverId}`);
    }

    // Fetch JWT and WS URL
    const response = await fetch(
      `${this.baseUrl}/api/client/servers/${serverId}/websocket`,
      {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: 'application/vnd.pterodactyl.v1+json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get WebSocket credentials: ${response.status}`);
    }

    const wsData = (await response.json()) as { data: { token: string; socket: string } };
    const { token, socket } = wsData.data;

    // Connect WebSocket
    const ws = new WebSocket(socket);
    const connection: WsConnection = {
      ws,
      serverId,
      jwt: token,
      wsUrl: socket,
      refreshTimer: null,
      reconnectAttempts: 0,
      consoleBuffer: [],
      subscribers: new Set(),
    };

    ws.on('open', () => {
      // Authenticate
      ws.send(JSON.stringify({ event: 'auth', args: [token] }));
      // Start JWT refresh timer
      this.startRefreshTimer(serverId);
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const message = JSON.parse(raw.toString()) as { event: string; args: string[] };
        this.handleMessage(serverId, message);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', (code: number) => {
      if (code === 4004) {
        // JWT expired — reconnect
        void this.reconnect(serverId);
      }
    });

    ws.on('error', (error: Error) => {
      console.error(`WebSocket error for server ${serverId}:`, error.message);
    });

    this.connections.set(serverId, connection);
  }

  /** Send a console command to a server */
  sendCommand(serverId: string, command: string): void {
    const conn = this.connections.get(serverId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to server ${serverId}`);
    }
    conn.ws.send(JSON.stringify({ event: 'send command', args: [command] }));
  }

  /** Send a power signal to a server */
  sendPowerSignal(
    serverId: string,
    signal: 'start' | 'stop' | 'restart' | 'kill',
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to server ${serverId}`);
    }
    conn.ws.send(JSON.stringify({ event: 'set state', args: [signal] }));
  }

  /** Subscribe to WebSocket events for a server */
  subscribe(serverId: string, callback: (event: WsEvent) => void): () => void {
    let conn = this.connections.get(serverId);
    if (!conn) {
      // Auto-connect
      this.connect(serverId).catch((err: unknown) => {
        console.error(`Auto-connect failed for server ${serverId}:`, err);
      });
      conn = this.connections.get(serverId);
    }
    conn?.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      const c = this.connections.get(serverId);
      if (c) {
        c.subscribers.delete(callback);
        // If no more subscribers, start idle timer
        if (c.subscribers.size === 0) {
          setTimeout(() => {
            const current = this.connections.get(serverId);
            if (current && current.subscribers.size === 0) {
              this.disconnect(serverId);
            }
          }, IDLE_TIMEOUT_MS);
        }
      }
    };
  }

  /** Get recent console output buffer */
  getConsoleBuffer(serverId: string): string[] {
    const conn = this.connections.get(serverId);
    return conn?.consoleBuffer ?? [];
  }

  /** Disconnect from a server's WebSocket */
  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn) {
      if (conn.refreshTimer) clearTimeout(conn.refreshTimer);
      conn.ws.close();
      this.connections.delete(serverId);
    }
  }

  private handleMessage(
    serverId: string,
    message: { event: string; args: string[] },
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    const eventMap: Record<string, WsEvent['type']> = {
      'console output': 'console_output',
      status: 'status',
      stats: 'stats',
      'auth success': 'auth_success',
      'jwt error': 'jwt_error',
      'daemon message': 'daemon_message',
    };

    const eventType = eventMap[message.event];
    if (!eventType) return;

    // Buffer console output
    if (eventType === 'console_output' && message.args[0]) {
      conn.consoleBuffer.push(message.args[0]);
      if (conn.consoleBuffer.length > MAX_CONSOLE_BUFFER) {
        conn.consoleBuffer.shift();
      }
    }

    // Parse stats data
    let data: unknown = message.args[0];
    if (eventType === 'stats' && typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        /* keep as string */
      }
    }

    // Emit to subscribers
    const event: WsEvent = { type: eventType, data, serverId };
    for (const subscriber of conn.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  private startRefreshTimer(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    if (conn.refreshTimer) clearTimeout(conn.refreshTimer);
    conn.refreshTimer = setTimeout(() => {
      void this.refreshJwt(serverId);
    }, JWT_REFRESH_MS);
  }

  private async refreshJwt(serverId: string): Promise<void> {
    try {
      const credential = credentialLoader.getCredential('client', serverId);
      if (!credential) return;

      const response = await fetch(
        `${this.baseUrl}/api/client/servers/${serverId}/websocket`,
        {
          headers: {
            Authorization: `Bearer ${credential.token}`,
            Accept: 'application/vnd.pterodactyl.v1+json',
          },
        },
      );

      if (!response.ok) {
        console.error(
          `JWT refresh failed for server ${serverId}: ${response.status}`,
        );
        return;
      }

      const wsData = (await response.json()) as {
        data: { token: string; socket: string };
      };
      const conn = this.connections.get(serverId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.jwt = wsData.data.token;
        conn.ws.send(
          JSON.stringify({ event: 'auth', args: [wsData.data.token] }),
        );
        this.startRefreshTimer(serverId);
      }
    } catch (error: unknown) {
      console.error(
        `JWT refresh error for server ${serverId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async reconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    conn.reconnectAttempts++;
    if (conn.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`Max reconnect attempts reached for server ${serverId}`);
      this.disconnect(serverId);
      return;
    }

    // Exponential backoff
    const delay = Math.min(
      1000 * Math.pow(2, conn.reconnectAttempts - 1),
      30000,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));

    this.disconnect(serverId);
    await this.connect(serverId);
    const newConn = this.connections.get(serverId);
    if (newConn) {
      newConn.reconnectAttempts = 0;
    }
  }
}

export const wsManager = new PteroWebSocketManager();
