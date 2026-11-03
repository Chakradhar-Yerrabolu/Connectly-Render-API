export type PresenceCallbacks = {
  onOnline: (userId: string) => void;
  onOffline: (userId: string, lastSeenAt: Date) => void;
  onStale: (socketId: string, userId: string) => void;
};

export type PresenceOptions = {
  graceMs?: number;
  staleMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
};

type Connection = {
  socketId: string;
  sessionId: string;
  lastHeartbeat: number;
};

export class PresenceManager {
  private readonly connections = new Map<string, Map<string, Connection>>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly graceMs: number;
  private readonly staleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly callbacks: PresenceCallbacks,
    options: PresenceOptions = {},
  ) {
    this.graceMs = options.graceMs ?? 8000;
    this.staleMs = options.staleMs ?? 70000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 15000;
    this.now = options.now ?? Date.now;
  }

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepStale(), this.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  isOnline(userId: string) {
    return (this.connections.get(userId)?.size || 0) > 0;
  }

  connectionCount(userId: string) {
    return this.connections.get(userId)?.size || 0;
  }

  onlineUserIds() {
    return [...this.connections.entries()].filter(([, connections]) => connections.size > 0).map(([userId]) => userId);
  }

  addConnection(userId: string, socketId: string, sessionId: string) {
    const existing = this.graceTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(userId);
    }
    let connections = this.connections.get(userId);
    if (!connections) {
      connections = new Map();
      this.connections.set(userId, connections);
    }
    const firstConnection = connections.size === 0;
    connections.set(socketId, { socketId, sessionId, lastHeartbeat: this.now() });
    if (firstConnection) this.callbacks.onOnline(userId);
  }

  heartbeat(userId: string, socketId: string) {
    const connection = this.connections.get(userId)?.get(socketId);
    if (connection) connection.lastHeartbeat = this.now();
  }

  removeConnection(userId: string, socketId: string) {
    const connections = this.connections.get(userId);
    if (!connections || !connections.delete(socketId)) return;
    if (connections.size === 0) {
      this.connections.delete(userId);
      this.scheduleOffline(userId);
    }
  }

  sweepStale() {
    const cutoff = this.now() - this.staleMs;
    const stale: { userId: string; socketId: string }[] = [];
    for (const [userId, connections] of this.connections) {
      for (const connection of connections.values()) {
        if (connection.lastHeartbeat <= cutoff) stale.push({ userId, socketId: connection.socketId });
      }
    }
    for (const item of stale) {
      this.removeConnection(item.userId, item.socketId);
      this.callbacks.onStale(item.socketId, item.userId);
    }
    return stale;
  }

  private scheduleOffline(userId: string) {
    if (this.graceTimers.has(userId)) return;
    const timer = setTimeout(() => {
      this.graceTimers.delete(userId);
      if (this.isOnline(userId)) return;
      this.callbacks.onOffline(userId, new Date(this.now()));
    }, this.graceMs);
    timer.unref?.();
    this.graceTimers.set(userId, timer);
  }
}
