import dotenv from 'dotenv';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { Server as SocketServer } from 'socket.io';
import {
  PrismaClient,
  ReportCategory,
  ReportStatus,
  ModerationActionType,
  AccountStatus,
  FriendRequestStatus,
  NotificationType,
} from '@prisma/client';
import argon2 from 'argon2';
import { z } from 'zod';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { PresenceManager, type PresenceOptions } from './presence.js';
import { LocalMediaStorage, safeFilename, validateAudio } from './media.js';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

export const prisma = new PrismaClient();

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '30m';
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || '30d';
const SECURE_COOKIES = process.env.NODE_ENV === 'production';
const REFRESH_COOKIE = 'connectly_refresh';
const CSRF_COOKIE = 'connectly_csrf';
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
// Temporary local admin defaults. Override these in the server .env before deployment.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234567890';
const PRESENCE_GRACE_MS = Number(process.env.PRESENCE_GRACE_MS || 8000);
const PRESENCE_STALE_MS = Number(process.env.PRESENCE_STALE_MS || 70000);
const PRESENCE_SWEEP_MS = Number(process.env.PRESENCE_SWEEP_MS || 15000);
const MAX_VOICE_MB = Number(process.env.MAX_VOICE_MB || 10);
const MAX_VOICE_DURATION_SEC = Number(process.env.MAX_VOICE_DURATION_SEC || 120);
const CALL_RING_TIMEOUT_SECONDS = Math.max(10, Math.min(120, Number(process.env.CALL_RING_TIMEOUT_SECONDS || 30)));

function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char] || char);
}

async function sendMissedCallEmail(input: { to: string; recipientName: string; callerName: string; callerUsername: string; mode: string; conversationId: string; createdAt: Date }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL_FROM;
  if (!apiKey || !senderEmail || !input.to) return;
  const senderName = process.env.EMAIL_FROM_NAME || 'Connectly';
  const appBaseUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const conversationUrl = `${appBaseUrl}/?conversation=${encodeURIComponent(input.conversationId)}`;
  const when = input.createdAt.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const caller = escapeEmailHtml(input.callerName);
  const username = escapeEmailHtml(input.callerUsername);
  const recipient = escapeEmailHtml(input.recipientName);
  const callType = input.mode === 'video' ? 'video call' : 'voice call';
  const htmlContent = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:Arial,sans-serif;color:#172033"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden"><tr><td style="background:#4f6ef7;padding:28px 32px;color:#fff"><div style="font-size:25px;font-weight:700">connectly<span style="color:#dce4ff">.</span></div><div style="margin-top:8px;font-size:14px;opacity:.9">Every connection matters.</div></td></tr><tr><td style="padding:32px"><p style="font-size:15px">Hello ${recipient},</p><h1 style="font-size:23px;margin:12px 0">You missed a ${callType}</h1><p style="color:#596579;line-height:1.6"><strong>${caller}</strong> (@${username}) tried to reach you on Connectly, but the call was not answered.</p><div style="background:#f4f6fb;border-radius:12px;padding:16px 18px;margin:22px 0"><div style="font-size:13px;color:#667085">Call details</div><p style="margin:8px 0 0"><strong>Type:</strong> ${callType}<br><strong>Date &amp; time:</strong> ${escapeEmailHtml(when)}</p></div><a href="${escapeEmailHtml(conversationUrl)}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:700">Open conversation</a><p style="font-size:12px;color:#8791a2;margin-top:28px">This is an automated notification from Connectly. You can manage your call preferences in your profile.</p></td></tr></table></td></tr></table></body></html>`;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: input.to, name: input.recipientName }], subject: `Missed ${callType} from ${input.callerName} on Connectly`, htmlContent }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Brevo returned HTTP ${response.status}`);
}


async function sendModerationEmail(input: { to: string; recipientName: string; action: 'WARN' | 'SUSPEND' | 'BAN' | 'SOFT_DELETE'; reason: string }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL_FROM;
  if (!apiKey || !senderEmail || !input.to) return;
  const senderName = process.env.EMAIL_FROM_NAME || 'Connectly';
  const appBaseUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const supportEmail = 'chakradhar.websites@gmail.com';
  const labels = { WARN: 'Account warning', SUSPEND: 'Account suspended', BAN: 'Account banned', SOFT_DELETE: 'Account deactivated' };
  const descriptions = {
    WARN: 'Your account has received an official warning. Please review the reason below and ensure future activity follows Connectly guidelines.',
    SUSPEND: 'Your account has been temporarily suspended. You will not be able to sign in while this restriction is active.',
    BAN: 'Your account has been banned. You will no longer be able to access Connectly unless this decision is reversed after review.',
    SOFT_DELETE: 'Your account has been deactivated by the Connectly moderation team. Contact support if you believe this action was made in error.',
  };
  const name = escapeEmailHtml(input.recipientName);
  const reason = escapeEmailHtml(input.reason).replace(/\n/g, '<br>');
  const actionLabel = labels[input.action];
  const htmlContent = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:Arial,sans-serif;color:#172033;padding:32px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden"><tr><td style="background:#4f6ef7;padding:26px 32px;color:#fff"><div style="font-size:25px;font-weight:700">connectly<span style="color:#dce4ff">.</span></div><div style="margin-top:7px;font-size:14px">Account and safety notification</div></td></tr><tr><td style="padding:32px"><p>Hello ${name},</p><h1 style="font-size:23px;margin:12px 0">${actionLabel}</h1><p style="color:#596579;line-height:1.65">${descriptions[input.action]}</p><div style="background:#f4f6fb;border-left:4px solid #4f6ef7;border-radius:10px;padding:17px 18px;margin:22px 0"><strong>Reason provided by moderation</strong><p style="line-height:1.6;margin:9px 0 0">${reason}</p></div><p style="color:#596579;line-height:1.6">If you believe this decision is incorrect or need clarification, contact our support team at <a href="mailto:${supportEmail}" style="color:#315fe8">${supportEmail}</a>.</p><p><a href="${escapeEmailHtml(appBaseUrl)}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 19px;border-radius:9px;font-weight:700">Open Connectly</a></p><p style="font-size:12px;color:#8791a2;margin-top:28px">This is an automated account notification from Connectly. Please do not reply directly to this email.</p></td></tr></table></td></tr></table></body></html>`;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: input.to, name: input.recipientName }], subject: `${actionLabel} - Connectly`, htmlContent }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Brevo returned HTTP ${response.status}`);
}


function durationToMs(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * factors[unit];
}

const REFRESH_TTL_MS = durationToMs(REFRESH_TTL);

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

function serializeCookie(name: string, value: string, options: { maxAge: number; httpOnly?: boolean; path?: string }) {
  const pieces = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `Max-Age=${options.maxAge}`,
    'SameSite=Lax',
  ];
  if (options.httpOnly) pieces.push('HttpOnly');
  if (SECURE_COOKIES) pieces.push('Secure');
  return pieces.join('; ');
}

function setAuthCookies(reply: FastifyReply, refreshToken: string, csrfToken: string) {
  reply.header('Set-Cookie', [
    serializeCookie(REFRESH_COOKIE, refreshToken, { maxAge: Math.floor(REFRESH_TTL_MS / 1000), httpOnly: true, path: '/api/v1/auth' }),
    serializeCookie(CSRF_COOKIE, csrfToken, { maxAge: Math.floor(REFRESH_TTL_MS / 1000), path: '/' }),
  ]);
}

function clearAuthCookies(reply: FastifyReply) {
  reply.header('Set-Cookie', [
    serializeCookie(REFRESH_COOKIE, '', { maxAge: 0, httpOnly: true, path: '/api/v1/auth' }),
    serializeCookie(CSRF_COOKIE, '', { maxAge: 0, path: '/' }),
  ]);
}

function verifyCsrf(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = WEB_ORIGIN.split(',').map((item) => item.trim());
    if (!allowed.includes(origin)) throw new HttpError(403, 'Origin not allowed', 'BAD_ORIGIN');
  }
  const cookie = getCookie(req, CSRF_COOKIE);
  const header = req.headers['x-csrf-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!cookie || !token || !safeEqual(cookie, token)) {
    throw new HttpError(403, 'Invalid CSRF token', 'CSRF_FAILED');
  }
}

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  about: true,
  gender: true,
  profilePictureKey: true,
  createdAt: true,
} as const;

const friendUserSelect = {
  id: true,
  username: true,
  displayName: true,
  about: true,
  profilePictureKey: true,
} as const;

export type BuildOptions = { withSocket?: boolean; presence?: PresenceOptions };

export function buildApp(options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 2 * 1024 * 1024 });
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  mkdirSync(uploadDir, { recursive: true });
  const mediaStorage = new LocalMediaStorage(uploadDir);
  void mediaStorage.init();
  const jwtSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('Set JWT_ACCESS_SECRET to a random secret of at least 32 characters.');
  }

  let io: SocketServer | null = null;
  const presence = new PresenceManager(
    {
      onOnline: (userId) => {
        void broadcastPresence(userId, true);
      },
      onOffline: (userId, lastSeenAt) => {
        void persistOfflinePresence(userId, lastSeenAt);
      },
      onStale: (socketId) => {
        io?.sockets.sockets.get(socketId)?.disconnect(true);
      },
    },
    {
      graceMs: PRESENCE_GRACE_MS,
      staleMs: PRESENCE_STALE_MS,
      sweepIntervalMs: PRESENCE_SWEEP_MS,
      ...options.presence,
    },
  );

  const emitToUser = (userId: string, event: string, payload: unknown) => {
    io?.to(`user:${userId}`).emit(event, payload);
  };

  async function createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string | null,
    data?: Record<string, unknown>,
  ) {
    const notification = await prisma.notification.create({
      data: { userId, type, title, body, data: data as any },
    });
    emitToUser(userId, 'notification:new', notification);
    return notification;
  }

  async function authUser(req: FastifyRequest) {
    await req.jwtVerify();
    const payload = req.user as { sub?: string; sid?: string };
    if (!payload.sub) throw new HttpError(401, 'Unauthorized');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.accountStatus !== AccountStatus.ACTIVE) throw new HttpError(401, 'Account unavailable');
    if (payload.sid) {
      const session = await prisma.session.findUnique({ where: { id: payload.sid } });
      if (!session || session.revokedAt) throw new HttpError(401, 'Session revoked', 'SESSION_REVOKED');
    }
    return user;
  }

  async function optionalAuth(req: FastifyRequest) {
    try {
      return await authUser(req);
    } catch {
      return null;
    }
  }

  async function adminUser(req: FastifyRequest) {
    await req.jwtVerify();
    const username = (req.user as any)?.admin;
    if (!username || username !== ADMIN_USERNAME) throw new HttpError(403, 'Admin access required');
    return username as string;
  }

  function signAccess(user: { id: string; username: string }, sessionId: string) {
    return app.jwt.sign({ sub: user.id, username: user.username, sid: sessionId }, { expiresIn: ACCESS_TTL });
  }

  async function resolveDevice(userId: string, device?: { deviceName: string; platform: string }) {
    const name = device?.deviceName || 'Web Browser';
    const platform = device?.platform || 'WEB';
    const existing = await prisma.device.findFirst({ where: { userId, deviceName: name, platform: platform as any } });
    if (existing) return existing;
    return prisma.device.create({ data: { userId, deviceName: name, platform: platform as any } });
  }

  async function createSession(
    req: FastifyRequest,
    reply: FastifyReply,
    user: { id: string; username: string },
    device?: { deviceName: string; platform: string },
  ) {
    const resolvedDevice = await resolveDevice(user.id, device);
    const familyId = randomUUID();
    const secret = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: resolvedDevice.id,
        refreshTokenHash: hashToken(secret),
        tokenFamilyId: familyId,
        familyExpiresAt: expiresAt,
        expiresAt,
        lastUsedAt: new Date(),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
        ipAddress: req.ip,
      },
    });
    const csrfToken = randomBytes(24).toString('base64url');
    setAuthCookies(reply, `${session.id}.${secret}`, csrfToken);
    return { accessToken: signAccess(user, session.id), session };
  }

  async function revokeFamily(familyId: string | null) {
    if (!familyId) return;
    await prisma.session.updateMany({
      where: { tokenFamilyId: familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async function rotateSession(req: FastifyRequest, reply: FastifyReply) {
    verifyCsrf(req);
    const raw = getCookie(req, REFRESH_COOKIE);
    if (!raw) throw new HttpError(401, 'No refresh token', 'NO_REFRESH_TOKEN');
    const separator = raw.indexOf('.');
    if (separator === -1) throw new HttpError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    const sessionId = raw.slice(0, separator);
    const secret = raw.slice(separator + 1);
    const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
    if (!session) throw new HttpError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');

    if (session.revokedAt) {
      await revokeFamily(session.tokenFamilyId);
      clearAuthCookies(reply);
      throw new HttpError(401, 'Refresh token reuse detected', 'TOKEN_REUSED');
    }
    if (session.expiresAt.getTime() <= Date.now() || (session.familyExpiresAt && session.familyExpiresAt.getTime() <= Date.now())) {
      await revokeFamily(session.tokenFamilyId);
      clearAuthCookies(reply);
      throw new HttpError(401, 'Session expired', 'SESSION_EXPIRED');
    }
    if (session.user.accountStatus !== AccountStatus.ACTIVE) {
      await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      clearAuthCookies(reply);
      throw new HttpError(401, 'Account unavailable', 'ACCOUNT_UNAVAILABLE');
    }
    if (!session.refreshTokenHash || !safeEqual(session.refreshTokenHash, hashToken(secret))) {
      throw new HttpError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }

    const newSecret = randomBytes(48).toString('base64url');
    const familyExpiresAt = session.familyExpiresAt || new Date(Date.now() + REFRESH_TTL_MS);
    const rotated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
      });
      if (claimed.count !== 1) throw new HttpError(401, 'Refresh token reuse detected', 'TOKEN_REUSED');
      return tx.session.create({
        data: {
          userId: session.userId,
          deviceId: session.deviceId,
          refreshTokenHash: hashToken(newSecret),
          tokenFamilyId: session.tokenFamilyId,
          familyExpiresAt,
          expiresAt: familyExpiresAt,
          lastUsedAt: new Date(),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
          ipAddress: req.ip,
        },
      });
    });

    const csrfToken = randomBytes(24).toString('base64url');
    setAuthCookies(reply, `${rotated.id}.${newSecret}`, csrfToken);
    return {
      accessToken: signAccess(session.user, rotated.id),
      user: {
        id: session.user.id,
        username: session.user.username,
        displayName: session.user.displayName,
        email: session.user.email,
        gender: session.user.gender,
        profilePictureKey: session.user.profilePictureKey,
        about: session.user.about,
        showLastSeen: session.user.showLastSeen,
      },
    };
  }

  function orderedPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  async function areFriends(a: string, b: string) {
    const [userAId, userBId] = orderedPair(a, b);
    const friendship = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
    return Boolean(friendship);
  }

  async function isBlocked(a: string, b: string) {
    const block = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedUserId: b },
          { blockerId: b, blockedUserId: a },
        ],
      },
    });
    return Boolean(block);
  }

  async function relationshipFor(meId: string, otherId: string) {
    if (await areFriends(meId, otherId)) return 'ACCEPTED';
    const request = await prisma.friendRequest.findFirst({
      where: {
        OR: [
          { senderId: meId, receiverId: otherId },
          { senderId: otherId, receiverId: meId },
        ],
        status: FriendRequestStatus.PENDING,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (request) return request.senderId === meId ? 'SENT' : 'RECEIVED';
    const latest = await prisma.friendRequest.findFirst({
      where: {
        OR: [
          { senderId: meId, receiverId: otherId },
          { senderId: otherId, receiverId: meId },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });
    return latest?.status || 'NONE';
  }

  app.register(helmet);
  app.register(cors, { origin: WEB_ORIGIN.split(',').map((item) => item.trim()), credentials: true });
  app.register(jwt, { secret: jwtSecret });
  app.register(rateLimit, {
    max: process.env.NODE_ENV === 'test' ? 100000 : 100,
    timeWindow: '1 minute',
  });
  app.register(multipart, { limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024, files: 5 } });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if ((error as any).name === 'ZodError') {
      return reply.code(400).send({ error: 'Invalid input', code: 'INVALID_INPUT' });
    }
    if ((error as any).statusCode === 401) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    req.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => ({ name: 'Connectly API', status: 'ok' }));

  app.post('/api/v1/auth/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const schema = z.object({
      username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_.-]+$/),
      displayName: z.string().min(1).max(100),
      password: z.string().min(10).max(128),
      email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
      phoneNumber: z.string().max(20).optional().nullable(),
      gender: z.enum(['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY']),
      device: z.object({
        deviceName: z.string().min(1).max(100),
        platform: z.enum(['WEB', 'ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX']),
      }),
    });
    const input = schema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { username: input.username } });
    if (existing) return reply.code(409).send({ error: 'Username already exists', code: 'USERNAME_TAKEN' });
    const emailOwner = await prisma.user.findUnique({ where: { email: input.email } });
    if (emailOwner) return reply.code(409).send({ error: 'Email address is already registered', code: 'EMAIL_TAKEN' });
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await prisma.user.create({
      data: {
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        email: input.email,
        phoneNumber: input.phoneNumber || null,
        gender: input.gender as any,
        devices: { create: { deviceName: input.device.deviceName, platform: input.device.platform } },
      },
      select: { id: true, username: true, displayName: true, gender: true, createdAt: true },
    });
    return reply.code(201).send(user);
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = z
      .object({
        username: z.string(),
        password: z.string(),
        device: z
          .object({
            deviceName: z.string().min(1).max(100),
            platform: z.enum(['WEB', 'ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX']),
          })
          .optional(),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { username: input.username } });
    if (!user || user.accountStatus !== AccountStatus.ACTIVE || !(await argon2.verify(user.passwordHash, input.password))) {
      return reply.code(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }
    await prisma.device.updateMany({ where: { userId: user.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    const { accessToken } = await createSession(req, reply, user, input.device);
    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        gender: user.gender,
        profilePictureKey: user.profilePictureKey,
        about: user.about,
        showLastSeen: user.showLastSeen,
      },
    };
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => rotateSession(req, reply));

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const raw = getCookie(req, REFRESH_COOKIE);
    if (raw) {
      try {
        verifyCsrf(req);
      } catch (error) {
        clearAuthCookies(reply);
        throw error;
      }
      const separator = raw.indexOf('.');
      if (separator !== -1) {
        const session = await prisma.session.findUnique({ where: { id: raw.slice(0, separator) } });
        if (session) {
          await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
          emitToUser(session.userId, 'session:revoked', { sessionId: session.id });
        }
      }
    }
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = app.jwt.verify(authHeader.slice(7)) as { sub?: string; sid?: string };
        if (payload.sid) {
          await prisma.session.updateMany({ where: { id: payload.sid, revokedAt: null }, data: { revokedAt: new Date() } });
        }
      } catch {
        // Access token may already be expired; cookie logout still applies.
      }
    }
    clearAuthCookies(reply);
    return { success: true };
  });

  app.post('/api/v1/auth/logout-all', async (req, reply) => {
    const me = await authUser(req);
    await prisma.session.updateMany({ where: { userId: me.id, revokedAt: null }, data: { revokedAt: new Date() } });
    emitToUser(me.id, 'session:revoked', { all: true });
    clearAuthCookies(reply);
    return { success: true };
  });

  app.get('/api/v1/auth/sessions', async (req) => {
    const me = await authUser(req);
    const sessions = await prisma.session.findMany({
      where: { userId: me.id, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((session) => ({
      id: session.id,
      deviceName: session.device.deviceName,
      platform: session.device.platform,
      current: session.id === (req.user as any).sid,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
    }));
  });

  app.delete('/api/v1/auth/sessions/:id', async (req) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const session = await prisma.session.findFirst({ where: { id, userId: me.id } });
    if (!session) throw new HttpError(404, 'Session not found');
    await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
    emitToUser(me.id, 'session:revoked', { sessionId: id });
    return { success: true };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const user = await authUser(req);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      about: user.about,
      gender: user.gender,
      profilePictureKey: user.profilePictureKey,
      lastSeenAt: user.showLastSeen ? user.lastSeenAt : null,
      showLastSeen: user.showLastSeen,
      ringtoneUrl: user.ringtoneUrl,
      callerTuneUrl: user.callerTuneUrl,
    };
  });

  app.patch('/api/v1/users/me', async (req) => {
    const user = await authUser(req);
    const input = z
      .object({
        displayName: z.string().min(1).max(100).optional(),
        about: z.string().max(250).nullable().optional(),
        showLastSeen: z.boolean().optional(),
        gender: z.enum(['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY']).optional(),
      })
      .parse(req.body);
    return prisma.user.update({
      where: { id: user.id },
      data: input,
      select: { id: true, username: true, displayName: true, about: true, gender: true, profilePictureKey: true, lastSeenAt: true, showLastSeen: true },
    });
  });

  app.post('/api/v1/users/me/email', async (req, reply) => {
    const me = await authUser(req);
    if (me.email) return reply.code(409).send({ error: 'An email address is already saved and cannot be changed.' });
    const input = z.object({ email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()) }).parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) return reply.code(409).send({ error: 'This email address is already associated with another account.' });
    try {
      const updated = await prisma.user.update({ where: { id: me.id, email: null }, data: { email: input.email }, select: { email: true } });
      return { email: updated.email };
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002' || (error as { code?: string })?.code === 'P2025') return reply.code(409).send({ error: 'An email address has already been saved or this address is in use.' });
      throw error;
    }
  });

  app.post('/api/v1/users/me/avatar', async (req, reply) => {
    const me = await authUser(req);
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Multipart upload required' });
    let bytes: Buffer | null = null;
    let mime = '';
    for await (const part of req.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file') continue;
      mime = part.mimetype.toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
        part.file.resume();
        return reply.code(415).send({ error: 'Use a JPEG, PNG, WebP or GIF image.' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) return reply.code(413).send({ error: 'Profile picture must be 5 MB or smaller.' });
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    if (!bytes?.length) return reply.code(400).send({ error: 'Choose an image to upload.' });
    // Basic file-signature validation prevents renamed non-image files.
    const valid = (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8)
      || (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      || (mime === 'image/gif' && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))
      || (mime === 'image/webp' && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP');
    if (!valid) return reply.code(415).send({ error: 'The uploaded file is not a valid image.' });
    const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string,string>)[mime];
    const key = `avatar-${me.id}-${randomUUID()}${extension}`;
    await mediaStorage.init();
    await mediaStorage.save(key, bytes);
    const previous = me.profilePictureKey;
    await prisma.user.update({ where: { id: me.id }, data: { profilePictureKey: key } });
    if (previous) await mediaStorage.remove(previous).catch(() => undefined);
    return { profilePictureKey: key };
  });

  app.get('/api/v1/users/avatar/:key', async (req, reply) => {
    await authUser(req);
    const { key } = req.params as { key: string };
    const owner = await prisma.user.findFirst({ where: { profilePictureKey: key }, select: { id: true } });
    if (!owner) return reply.code(404).send({ error: 'Avatar not found' });
    try {
      const info = await mediaStorage.stat(key);
      const extension = path.extname(key).toLowerCase();
      const mime = ({ '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif' } as Record<string,string>)[extension] || 'application/octet-stream';
      reply.header('Content-Type', mime).header('Cache-Control', 'private, max-age=300').header('Content-Length', info.size);
      return reply.send(mediaStorage.stream(key));
    } catch { return reply.code(404).send({ error: 'Avatar file unavailable' }); }
  });

  app.patch('/api/v1/users/me/password', async (req, reply) => {
    const me = await authUser(req);
    const input = z
      .object({ currentPassword: z.string(), newPassword: z.string().min(10).max(128) })
      .parse(req.body);
    if (!(await argon2.verify(me.passwordHash, input.currentPassword))) {
      return reply.code(400).send({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
    }
    const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    await prisma.$transaction([
      prisma.user.update({ where: { id: me.id }, data: { passwordHash } }),
      prisma.session.updateMany({ where: { userId: me.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    emitToUser(me.id, 'session:revoked', { all: true });
    clearAuthCookies(reply);
    return { success: true };
  });

  app.get('/api/v1/users/search', async (req, reply) => {
    const me = await authUser(req);
    const query = z.object({ q: z.string().min(1).max(30) }).parse(req.query);
    const user = await prisma.user.findUnique({
      where: { username: query.q },
      select: { ...publicUserSelect, accountStatus: true },
    });
    if (!user || user.accountStatus !== AccountStatus.ACTIVE) return reply.code(404).send({ error: 'User not found', code: 'NOT_FOUND' });
    if (user.id === me.id) {
      return { found: true, user: publicUser(user), relationship: 'SELF', request: null };
    }
    const [relationship, pending] = await Promise.all([
      relationshipFor(me.id, user.id),
      prisma.friendRequest.findFirst({
        where: {
          status: FriendRequestStatus.PENDING,
          OR: [
            { senderId: me.id, receiverId: user.id },
            { senderId: user.id, receiverId: me.id },
          ],
        },
      }),
    ]);
    const blocked = await isBlocked(me.id, user.id);
    return { found: true, user: publicUser(user), relationship: blocked ? 'BLOCKED' : relationship, request: pending };
  });

  app.get('/api/v1/users/:username', async (req, reply) => {
    const { username } = req.params as { username: string };
    const me = await optionalAuth(req);
    const user = await prisma.user.findUnique({ where: { username }, select: publicUserSelect });
    if (!user) return reply.code(404).send({ error: 'User not found' });
    const relationship = me && me.id !== user.id ? await relationshipFor(me.id, user.id) : 'SELF';
    return { ...user, relationship };
  });

  app.get('/api/v1/friends', async (req) => {
    const me = await authUser(req);
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userAId: me.id }, { userBId: me.id }] },
      include: {
        userA: { select: { ...friendUserSelect, lastSeenAt: true, showLastSeen: true } },
        userB: { select: { ...friendUserSelect, lastSeenAt: true, showLastSeen: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return friendships.map((friendship) => {
      const friend = friendship.userAId === me.id ? friendship.userB : friendship.userA;
      return {
        friendshipId: friendship.id,
        friend: { ...friend, lastSeenAt: friend.showLastSeen ? friend.lastSeenAt : null },
        online: friend.showLastSeen !== false && presence.isOnline(friend.id),
        since: friendship.createdAt,
      };
    });
  });

  app.get('/api/v1/friend-requests', async (req) => {
    const me = await authUser(req);
    const query = z.object({ type: z.enum(['incoming', 'outgoing', 'all']).optional() }).parse(req.query);
    const type = query.type || 'all';
    // This endpoint powers the pending-request UI. Accepted relationships are
    // represented by Friendship records and must only appear in /friends.
    const where =
      type === 'incoming'
        ? { receiverId: me.id, status: FriendRequestStatus.PENDING }
        : type === 'outgoing'
          ? { senderId: me.id, status: FriendRequestStatus.PENDING }
          : {
              status: FriendRequestStatus.PENDING,
              OR: [{ receiverId: me.id }, { senderId: me.id }],
            };
    const requests = await prisma.friendRequest.findMany({
      where,
      include: {
        sender: { select: friendUserSelect },
        receiver: { select: friendUserSelect },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { incoming: requests.filter((r) => r.receiverId === me.id), outgoing: requests.filter((r) => r.senderId === me.id) };
  });

  app.post('/api/v1/friend-requests', async (req, reply) => {
    const me = await authUser(req);
    const input = z.object({ username: z.string().min(1).max(30) }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { username: input.username } });
    if (!target || target.accountStatus !== AccountStatus.ACTIVE) return reply.code(404).send({ error: 'User not found' });
    if (target.id === me.id) return reply.code(400).send({ error: 'You cannot send a friend request to yourself', code: 'SELF_REQUEST' });
    if (await isBlocked(me.id, target.id)) return reply.code(403).send({ error: 'Friend request unavailable', code: 'BLOCKED' });
    if (await areFriends(me.id, target.id)) return reply.code(409).send({ error: 'Already friends', code: 'ALREADY_FRIENDS' });

    const incoming = await prisma.friendRequest.findFirst({
      where: { senderId: target.id, receiverId: me.id, status: FriendRequestStatus.PENDING },
    });
    if (incoming) {
      return reply.code(409).send({
        error: 'This user already sent you a request',
        code: 'OPPOSITE_PENDING',
        request: incoming,
      });
    }
    const outgoing = await prisma.friendRequest.findFirst({
      where: { senderId: me.id, receiverId: target.id, status: FriendRequestStatus.PENDING },
    });
    if (outgoing) return reply.code(409).send({ error: 'Request already sent', code: 'REQUEST_ALREADY_SENT', request: outgoing });

    const request = await prisma.$transaction(async (tx) => {
      const existing = await tx.friendRequest.findUnique({
        where: { senderId_receiverId: { senderId: me.id, receiverId: target.id } },
      });
      const saved = existing
        ? await tx.friendRequest.update({
            where: { id: existing.id },
            data: { status: FriendRequestStatus.PENDING, respondedAt: null, updatedAt: new Date() },
            include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
          })
        : await tx.friendRequest.create({
            data: { senderId: me.id, receiverId: target.id },
            include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
          });
      return saved;
    });

    await createNotification(target.id, NotificationType.FRIEND_REQUEST, 'New friend request', `${me.displayName} (@${me.username}) sent you a friend request.`, {
      requestId: request.id,
      senderId: me.id,
      senderUsername: me.username,
    });
    emitToUser(target.id, 'friend-request:new', request);
    return reply.code(201).send(request);
  });

  app.post('/api/v1/friend-requests/:id/accept', async (req) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const request = await prisma.friendRequest.findUnique({
      where: { id },
      include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
    });
    if (!request) throw new HttpError(404, 'Friend request not found');
    if (request.receiverId !== me.id) throw new HttpError(403, 'Only the recipient can accept this request');
    if (request.status !== FriendRequestStatus.PENDING) throw new HttpError(409, 'Request is no longer pending', 'NOT_PENDING');

    const [userAId, userBId] = orderedPair(request.senderId, request.receiverId);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.friendRequest.update({
        where: { id },
        data: { status: FriendRequestStatus.ACCEPTED, respondedAt: new Date() },
        include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
      });
      await tx.friendRequest.updateMany({
        where: {
          senderId: request.receiverId,
          receiverId: request.senderId,
          status: FriendRequestStatus.PENDING,
        },
        data: { status: FriendRequestStatus.CANCELLED, respondedAt: new Date() },
      });
      const friendship = await tx.friendship.upsert({
        where: { userAId_userBId: { userAId, userBId } },
        create: { userAId, userBId },
        update: {},
      });
      return { updated, friendship };
    });

    await createNotification(
      request.senderId,
      NotificationType.FRIEND_REQUEST_ACCEPTED,
      'Friend request accepted',
      `${request.receiver.displayName} accepted your friend request.`,
      { requestId: request.id, friendId: request.receiverId, friendUsername: request.receiver.username },
    );
    emitToUser(request.senderId, 'friend-request:updated', result.updated);
    emitToUser(request.receiverId, 'friend-request:updated', result.updated);
    emitToUser(request.senderId, 'friends:updated', { friendId: request.receiverId });
    emitToUser(request.receiverId, 'friends:updated', { friendId: request.senderId });
    return { success: true, request: result.updated, friendship: result.friendship };
  });

  app.post('/api/v1/friend-requests/:id/reject', async (req) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const request = await prisma.friendRequest.findUnique({
      where: { id },
      include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
    });
    if (!request) throw new HttpError(404, 'Friend request not found');
    if (request.receiverId !== me.id) throw new HttpError(403, 'Only the recipient can reject this request');
    if (request.status !== FriendRequestStatus.PENDING) throw new HttpError(409, 'Request is no longer pending', 'NOT_PENDING');
    const updated = await prisma.friendRequest.update({
      where: { id },
      data: { status: FriendRequestStatus.REJECTED, respondedAt: new Date() },
      include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
    });
    emitToUser(request.senderId, 'friend-request:updated', updated);
    emitToUser(request.receiverId, 'friend-request:updated', updated);
    return { success: true, request: updated };
  });

  app.post('/api/v1/friend-requests/:id/cancel', async (req) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const request = await prisma.friendRequest.findUnique({
      where: { id },
      include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
    });
    if (!request) throw new HttpError(404, 'Friend request not found');
    if (request.senderId !== me.id) throw new HttpError(403, 'Only the sender can cancel this request');
    if (request.status !== FriendRequestStatus.PENDING) throw new HttpError(409, 'Request is no longer pending', 'NOT_PENDING');
    const updated = await prisma.friendRequest.update({
      where: { id },
      data: { status: FriendRequestStatus.CANCELLED, respondedAt: new Date() },
      include: { sender: { select: friendUserSelect }, receiver: { select: friendUserSelect } },
    });
    await createNotification(
      request.receiverId,
      NotificationType.FRIEND_REQUEST_CANCELLED,
      'Friend request cancelled',
      `${request.sender.displayName} cancelled their friend request.`,
      { requestId: request.id, senderId: request.senderId },
    );
    emitToUser(request.receiverId, 'friend-request:updated', updated);
    emitToUser(request.senderId, 'friend-request:updated', updated);
    return { success: true, request: updated };
  });

  app.post('/api/v1/users/:username/block', async (req) => {
    const me = await authUser(req);
    const { username } = req.params as { username: string };
    const target = await prisma.user.findUnique({ where: { username } });
    if (!target) throw new HttpError(404, 'User not found');
    if (target.id === me.id) throw new HttpError(400, 'You cannot block yourself');
    await prisma.$transaction([
      prisma.blockedUser.upsert({
        where: { blockerId_blockedUserId: { blockerId: me.id, blockedUserId: target.id } },
        create: { blockerId: me.id, blockedUserId: target.id },
        update: {},
      }),
      prisma.friendRequest.updateMany({
        where: {
          status: FriendRequestStatus.PENDING,
          OR: [
            { senderId: me.id, receiverId: target.id },
            { senderId: target.id, receiverId: me.id },
          ],
        },
        data: { status: FriendRequestStatus.CANCELLED, respondedAt: new Date() },
      }),
    ]);
    emitToUser(target.id, 'friends:updated', { friendId: me.id });
    return { success: true };
  });

  app.get('/api/v1/users/blocked', async (req) => {
    const me = await authUser(req);
    const rows = await prisma.blockedUser.findMany({
      where: { blockerId: me.id }, orderBy: { createdAt: 'desc' },
      include: { blockedUser: { select: { id: true, username: true, displayName: true, profilePictureKey: true } } },
    });
    return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, user: row.blockedUser }));
  });

  app.delete('/api/v1/users/:username/block', async (req) => {
    const me = await authUser(req);
    const { username } = req.params as { username: string };
    const target = await prisma.user.findUnique({ where: { username } });
    if (!target) throw new HttpError(404, 'User not found');
    await prisma.blockedUser.deleteMany({ where: { blockerId: me.id, blockedUserId: target.id } });
    return { success: true };
  });

  app.get('/api/v1/notifications', async (req) => {
    const me = await authUser(req);
    const query = z.object({ unreadOnly: z.string().optional() }).parse(req.query);
    const where = query.unreadOnly === 'true' ? { userId: me.id, readAt: null } : { userId: me.id };
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.notification.count({ where: { userId: me.id, readAt: null } }),
    ]);
    return { notifications, unreadCount };
  });

  app.patch('/api/v1/notifications/:id/read', async (req) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const notification = await prisma.notification.findFirst({ where: { id, userId: me.id } });
    if (!notification) throw new HttpError(404, 'Notification not found');
    return prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  });

  app.post('/api/v1/notifications/read-all', async (req) => {
    const me = await authUser(req);
    await prisma.notification.updateMany({ where: { userId: me.id, readAt: null }, data: { readAt: new Date() } });
    return { success: true };
  });

  app.post('/api/v1/conversations/direct', async (req, reply) => {
    const me = await authUser(req);
    const { username } = z.object({ username: z.string() }).parse(req.body);
    const other = await prisma.user.findUnique({ where: { username } });
    if (!other || other.id === me.id || other.accountStatus !== AccountStatus.ACTIVE) {
      return reply.code(404).send({ error: 'User unavailable' });
    }
    if (await isBlocked(me.id, other.id)) return reply.code(403).send({ error: 'Conversation unavailable', code: 'BLOCKED' });
    const existing = await prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [{ members: { some: { userId: me.id } } }, { members: { some: { userId: other.id } } }],
      },
    });
    if (existing) return existing;
    if (!(await areFriends(me.id, other.id))) {
      return reply.code(403).send({ error: 'You must be friends to start a conversation', code: 'NOT_FRIENDS' });
    }
    return reply.code(201).send(
      await prisma.conversation.create({
        data: { type: 'DIRECT', members: { create: [{ userId: me.id }, { userId: other.id }] } },
        include: {
          members: { include: { user: { select: { id: true, username: true, displayName: true } } } },
        },
      }),
    );
  });

  app.post('/api/v1/conversations/group', async (req, reply) => {
    const me = await authUser(req);
    const input = z.object({ title: z.string().min(1).max(100), usernames: z.array(z.string()).min(1).max(100) }).parse(req.body);
    const users = await prisma.user.findMany({
      where: { username: { in: input.usernames }, accountStatus: 'ACTIVE' },
      select: { id: true },
    });
    return reply.code(201).send(
      await prisma.conversation.create({
        data: {
          type: 'GROUP',
          title: input.title,
          members: {
            create: [{ userId: me.id, role: 'ADMIN' }, ...users.filter((u) => u.id !== me.id).map((u) => ({ userId: u.id }))],
          },
        },
      }),
    );
  });

  app.patch('/api/v1/conversations/:id/favorite', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const input = z.object({ favorite: z.boolean() }).parse(req.body);
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member || member.isLocked) return reply.code(404).send({ error: 'Conversation not found' });
    const updated = await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me.id } }, data: { isFavorite: input.favorite } });
    return { success: true, isFavorite: updated.isFavorite };
  });

  app.post('/api/v1/conversations/:id/lock', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const input = z.object({ secret: z.string().min(4).max(64) }).parse(req.body);
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member) return reply.code(404).send({ error: 'Conversation not found' });
    await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me.id } }, data: { isLocked: true, lockSecretHash: await argon2.hash(input.secret) } });
    return { success: true, hidden: true };
  });

  app.post('/api/v1/conversations/unlock', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = await authUser(req);
    const input = z.object({ secret: z.string().min(1).max(64) }).parse(req.body);
    const candidates = await prisma.conversationMember.findMany({
      where: { userId: me.id, isLocked: true, lockSecretHash: { not: null } },
      include: {
        conversation: {
          include: {
            members: {
              include: {
                user: { select: { id: true, username: true, displayName: true, profilePictureKey: true, lastSeenAt: true, showLastSeen: true } },
              },
            },
            messages: { take: 1, orderBy: { createdAt: 'desc' }, include: { attachment: true } },
          },
        },
      },
    });
    for (const candidate of candidates) {
      if (!candidate.lockSecretHash || !(await argon2.verify(candidate.lockSecretHash, input.secret))) continue;
      const conversation = candidate.conversation;
      return { ...conversation, members: conversation.members.map((member) => ({ ...member, user: { id: member.user.id, username: member.user.username, displayName: member.user.displayName, profilePictureKey: member.user.profilePictureKey, lastSeenAt: conversation.type === 'DIRECT' && member.user.showLastSeen ? member.user.lastSeenAt : null, online: member.user.showLastSeen !== false && presence.isOnline(member.user.id) } })) };
    }
    return reply.code(404).send({ error: 'No locked chat matches that secret key.' });
  });

  app.get('/api/v1/conversations', async (req) => {
    const me = await authUser(req);
    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: me.id, isLocked: false } } },
      include: {
        members: {
          include: { user: { select: { id: true, username: true, displayName: true, profilePictureKey: true, lastSeenAt: true, showLastSeen: true } } },
        },
        messages: { take: 1, orderBy: { createdAt: 'desc' }, include: { attachment: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return conversations.map((conversation) => ({
      ...conversation,
      members: conversation.members.map((member) => ({
        ...member,
        user: {
          id: member.user.id,
          username: member.user.username,
          displayName: member.user.displayName,
          profilePictureKey: member.user.profilePictureKey,
          lastSeenAt: conversation.type === 'DIRECT' && member.user.showLastSeen ? member.user.lastSeenAt : null,
          online: member.user.showLastSeen !== false && presence.isOnline(member.user.id),
        },
      })),
    }));
  });

  app.get('/api/v1/conversations/:id/messages', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: id, userId: me.id } },
    });
    if (!member) return reply.code(403).send({ error: 'Not a member' });
    const { before } = req.query as { before?: string };
    return prisma.message.findMany({
      where: { conversationId: id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        sender: { select: { id: true, username: true, displayName: true, profilePictureKey: true } },
        receipts: true,
        attachment: true,
      },
    });
  });

  app.get('/api/v1/conversations/:id/search', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member) return reply.code(403).send({ error: 'Not a conversation member' });
    const query = z.object({ q: z.string().optional(), date: z.string().optional() }).parse(req.query);
    const where: any = { conversationId: id, deletedAt: null };
    if (query.q?.trim()) where.body = { contains: query.q.trim(), mode: 'insensitive' };
    if (query.date) {
      const start = new Date(`${query.date}T00:00:00.000`);
      if (Number.isNaN(start.getTime())) return reply.code(400).send({ error: 'Invalid date' });
      const end = new Date(start); end.setDate(end.getDate() + 1);
      where.createdAt = { gte: start, lt: end };
    }
    const results = await prisma.message.findMany({ where, orderBy: { createdAt: 'asc' }, take: 500, include: { sender: { select: { id: true, username: true, displayName: true, profilePictureKey: true } }, receipts: true, attachment: true } });
    return results;
  });

  app.delete('/api/v1/conversations/:id', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member) return reply.code(404).send({ error: 'Conversation not found' });
    await prisma.conversationMember.delete({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    return { success: true, deletedForCurrentUser: true };
  });

  app.get('/api/v1/users/me/audio-settings', async (req) => {
    const me = await authUser(req);
    return prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { ringtoneUrl: true, callerTuneUrl: true } });
  });

  app.patch('/api/v1/users/me/audio-settings', async (req, reply) => {
    const me = await authUser(req);
    const input = z.object({ ringtoneUrl: z.string().url().max(2048).nullable(), callerTuneUrl: z.string().url().max(2048).nullable() }).parse(req.body);
    for (const value of [input.ringtoneUrl, input.callerTuneUrl]) {
      if (value && !/^https:\/\//i.test(value)) return reply.code(400).send({ error: 'Audio URLs must use HTTPS' });
    }
    return prisma.user.update({ where: { id: me.id }, data: input, select: { id: true, ringtoneUrl: true, callerTuneUrl: true } });
  });

  app.get('/api/v1/conversations/:id/calls', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member) return reply.code(403).send({ error: 'Not a conversation member' });
    return prisma.call.findMany({ where: { conversationId: id, hiddenBy: { none: { userId: me.id } } }, orderBy: { createdAt: 'desc' }, take: 100, include: { caller: { select: { id: true, username: true, displayName: true } } } });
  });

  app.delete('/api/v1/calls/:id/history', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const call = await prisma.call.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
    if (!call || !call.conversation.members.some((member) => member.userId === me.id)) return reply.code(404).send({ error: 'Call not found' });
    await prisma.callHistoryHidden.upsert({ where: { callId_userId: { callId: id, userId: me.id } }, create: { callId: id, userId: me.id }, update: { hiddenAt: new Date() } });
    return { success: true };
  });

  app.delete('/api/v1/calls/history', async (req) => {
    const me = await authUser(req);
    const memberships = await prisma.conversationMember.findMany({ where: { userId: me.id }, select: { conversationId: true } });
    const calls = await prisma.call.findMany({ where: { conversationId: { in: memberships.map((m) => m.conversationId) }, hiddenBy: { none: { userId: me.id } } }, select: { id: true } });
    if (calls.length) await prisma.callHistoryHidden.createMany({ data: calls.map((call) => ({ callId: call.id, userId: me.id })), skipDuplicates: true });
    return { success: true, hiddenCount: calls.length };
  });

  app.post('/api/v1/conversations/:id/read', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } } });
    if (!member) return reply.code(403).send({ error: 'Not a conversation member' });
    const now = new Date();
    await prisma.$transaction([
      prisma.notification.updateMany({ where: { userId: me.id, type: NotificationType.NEW_MESSAGE, readAt: null, data: { path: ['conversationId'], equals: id } }, data: { readAt: now } }),
      prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me.id } }, data: { lastReadAt: now } }),
    ]);
    return { success: true, readAt: now };
  });

  app.delete('/api/v1/messages/:id/everyone', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const message = await prisma.message.findUnique({ where: { id }, include: { attachment: true } });
    if (!message) return reply.code(404).send({ error: 'Message not found' });
    if (message.senderId !== me.id) return reply.code(403).send({ error: 'Only the sender can delete this message for everyone.' });
    if (message.deletedAt) return { success: true, deletedAt: message.deletedAt };
    const deletedAt = new Date();
    const storageKey = message.attachment?.storageKey;
    await prisma.$transaction(async (tx) => {
      if (message.attachment) await tx.messageAttachment.delete({ where: { id: message.attachment.id } });
      await tx.message.update({ where: { id }, data: { body: null, attachmentKey: null, deletedAt } });
    });
    if (storageKey) await mediaStorage.remove(storageKey).catch(() => undefined);
    io?.to(`conversation:${message.conversationId}`).emit('message:deleted', { messageId: id, conversationId: message.conversationId, deletedAt: deletedAt.toISOString() });
    return { success: true, deletedAt };
  });

  app.post('/api/v1/calls/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = await authUser(req);
    const input = z.object({ conversationId: z.string().uuid(), mode: z.enum(['audio', 'video']), notify: z.boolean().optional().default(false) }).parse(req.body);
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: input.conversationId, userId: me.id } }, include: { conversation: { include: { members: true } } } });
    if (!member) return reply.code(403).send({ error: 'You are not a member of this conversation.' });
    for (const participant of member.conversation.members) { if (participant.userId !== me.id && await isBlocked(me.id, participant.userId)) return reply.code(403).send({ error: 'Calls are unavailable because a participant has blocked this account.', code: 'BLOCKED' }); }
    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !apiKey || !apiSecret) return reply.code(503).send({ error: 'Calling is not configured. Add LiveKit credentials to apps/server/.env.' });
    const roomName = `connectly-${input.conversationId}`;
    const roomServiceUrl = livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);
    const existingRooms = await roomService.listRooms([roomName]);
    if (!existingRooms.length) {
      await roomService.createRoom({ name: roomName, maxParticipants: 5, emptyTimeout: 60 }).catch(async () => {
        // A concurrent call request may have created the room; verify it exists before continuing.
        const racedRoom = await roomService.listRooms([roomName]);
        if (!racedRoom.length) throw new HttpError(503, 'Could not create the LiveKit room');
      });
    }
    const activeParticipants = await roomService.listParticipants(roomName).catch(() => []);
    if (activeParticipants.length >= 5 && !activeParticipants.some((participant) => participant.identity === me.id)) return reply.code(409).send({ error: 'This call already has 5 participants.' });
    const at = new AccessToken(apiKey, apiSecret, { identity: me.id, name: me.displayName, ttl: '10m' });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    let callRecord: any = null;
    if (input.notify && activeParticipants.length === 0) {
      callRecord = await prisma.call.create({ data: { conversationId: input.conversationId, callerId: me.id, mode: input.mode, status: 'RINGING' } });
      const recipientIds = member.conversation.members.filter((participant) => participant.userId !== me.id).map((participant) => participant.userId);
      const recipients = await prisma.user.findMany({ where: { id: { in: recipientIds } }, select: { id: true, email: true, displayName: true, username: true, ringtoneUrl: true, callerTuneUrl: true } });
      for (const participant of recipients) emitToUser(participant.id, 'call:incoming', { callId: callRecord.id, conversationId: input.conversationId, roomName, callerId: me.id, callerName: me.displayName, callerAvatarKey: me.profilePictureKey, callerUsername: me.username, mode: input.mode, ringtoneUrl: participant.ringtoneUrl, callerTuneUrl: participant.callerTuneUrl, timeoutSeconds: CALL_RING_TIMEOUT_SECONDS });
      const timeout = setTimeout(async () => {
        const endedAt = new Date();
        const beforeTimeout = await prisma.call.findUnique({ where: { id: callRecord.id }, select: { status: true } }).catch(() => null);
        const result = await prisma.call.updateMany({ where: { id: callRecord.id, status: 'RINGING' }, data: { status: 'NO_RESPONSE', endedAt } }).catch(() => ({ count: 0 }));
        if (result.count) {
          for (const participant of member.conversation.members) emitToUser(participant.userId, 'call:ended', { callId: callRecord.id, conversationId: input.conversationId, status: 'NO_RESPONSE' });
          for (const recipient of recipients) {
            if (beforeTimeout?.status !== 'RINGING' || !recipient.email) continue;
            void sendMissedCallEmail({ to: recipient.email, recipientName: recipient.displayName, callerName: me.displayName, callerUsername: me.username, mode: input.mode, conversationId: input.conversationId, createdAt: callRecord.createdAt })
              .catch((error) => req.log.warn({ err: error, callId: callRecord.id, recipientId: recipient.id }, 'Missed-call email delivery failed'));
          }
        }
      }, CALL_RING_TIMEOUT_SECONDS * 1000);
      timeout.unref?.();
    }
    const otherUser = member.conversation.members.find((participant) => participant.userId !== me.id);
    const otherAudio = otherUser ? await prisma.user.findUnique({ where: { id: otherUser.userId }, select: { callerTuneUrl: true } }) : null;
    return { token, serverUrl: livekitUrl, roomName, mode: input.mode, callId: callRecord?.id, timeoutSeconds: CALL_RING_TIMEOUT_SECONDS, callerTuneUrl: otherAudio?.callerTuneUrl || null };
  });

  app.get('/api/v1/calls/:id', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const call = await prisma.call.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
    if (!call || !call.conversation.members.some((m) => m.userId === me.id)) return reply.code(404).send({ error: 'Call not found' });
    return { id: call.id, status: call.status, startedAt: call.startedAt, endedAt: call.endedAt, durationSeconds: call.durationSeconds };
  });

  app.post('/api/v1/calls/:id/respond', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const input = z.object({ action: z.enum(['ACCEPT', 'REJECT']) }).parse(req.body);
    const call = await prisma.call.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
    if (!call || !call.conversation.members.some((m) => m.userId === me.id) || call.callerId === me.id) return reply.code(404).send({ error: 'Call not found' });
    if (call.status !== 'RINGING') return reply.code(409).send({ error: 'Call is no longer ringing' });
    const updated = await prisma.call.update({ where: { id }, data: input.action === 'ACCEPT' ? { status: 'ACCEPTED' } : { status: 'REJECTED', endedAt: new Date() } });
    for (const participant of call.conversation.members) emitToUser(participant.userId, 'call:status', { callId: id, conversationId: call.conversationId, status: updated.status, startedAt: updated.startedAt });
    return updated;
  });
  app.post('/api/v1/calls/:id/connected', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const call = await prisma.call.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
    if (!call || !call.conversation.members.some((m) => m.userId === me.id)) return reply.code(404).send({ error: 'Call not found' });
    if (['ENDED', 'REJECTED', 'NO_RESPONSE'].includes(call.status)) return reply.code(409).send({ error: 'Call is no longer active' });
    const startedAt = call.startedAt || new Date();
    const updated = await prisma.call.update({ where: { id }, data: { status: 'CONNECTED', startedAt } });
    if (call.status !== 'CONNECTED') for (const participant of call.conversation.members) emitToUser(participant.userId, 'call:status', { callId: id, conversationId: call.conversationId, status: 'CONNECTED', startedAt });
    return updated;
  });

  app.post('/api/v1/calls/:id/end', async (req, reply) => {
    const me = await authUser(req); const { id } = req.params as { id: string };
    const call = await prisma.call.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
    if (!call || !call.conversation.members.some((m) => m.userId === me.id)) return reply.code(404).send({ error: 'Call not found' });
    const endedAt = new Date(); const durationSeconds = call.startedAt ? Math.max(0, Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000)) : 0;
    const updated = await prisma.call.update({ where: { id }, data: { status: 'ENDED', endedAt, durationSeconds } });
    for (const participant of call.conversation.members) emitToUser(participant.userId, 'call:ended', { callId: id, conversationId: call.conversationId, status: 'ENDED', durationSeconds });
    return updated;
  });

  app.post('/api/v1/attachments/voice', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = await authUser(req);
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Multipart upload required', code: 'INVALID_UPLOAD' });

    let data: Buffer | null = null;
    let declaredMime = '';
    let durationMs = 0;
    const maxBytes = Math.min(MAX_VOICE_MB, Number(process.env.MAX_UPLOAD_MB || 10)) * 1024 * 1024;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume();
            continue;
          }
          if (data) return reply.code(400).send({ error: 'Only one audio file is allowed', code: 'TOO_MANY_FILES' });
          declaredMime = part.mimetype;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > maxBytes) throw new HttpError(413, 'Voice recording exceeds the upload limit', 'FILE_TOO_LARGE');
            chunks.push(chunk);
          }
          data = Buffer.concat(chunks);
        } else if (part.fieldname === 'durationMs') {
          durationMs = Number(part.value);
        }
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'Voice recording exceeds the upload limit', 'FILE_TOO_LARGE');
      throw error;
    }

    if (!data || data.length < 64) return reply.code(400).send({ error: 'A valid audio recording is required', code: 'INVALID_AUDIO' });
    const validated = validateAudio(data, declaredMime);
    if (!validated) return reply.code(415).send({ error: 'Unsupported or invalid audio format', code: 'INVALID_AUDIO_TYPE' });
    if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_VOICE_DURATION_SEC * 1000) {
      return reply.code(400).send({ error: 'Voice duration is outside the allowed range', code: 'INVALID_DURATION' });
    }

    const storageKey = `${randomUUID()}${validated.extension}`;
    await mediaStorage.save(storageKey, data);
    try {
      const attachment = await prisma.messageAttachment.create({
        data: {
          uploaderId: me.id,
          mimeType: validated.mimeType,
          sizeBytes: data.length,
          durationMs,
          storageKey,
        },
      });
      return reply.code(201).send({
        id: attachment.id,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        durationMs: attachment.durationMs,
        createdAt: attachment.createdAt,
      });
    } catch (error) {
      await mediaStorage.remove(storageKey);
      throw error;
    }
  });


  // General chat attachments. The configured MAX_UPLOAD_MB is a deployment limit;
  // there is no safe or meaningful "unlimited" upload size on HTTP servers.
  app.post('/api/v1/attachments', async (req, reply) => {
    const me = await authUser(req);
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Multipart upload required', code: 'INVALID_UPLOAD' });
    let data: Buffer | null = null;
    let declaredMime = '';
    for await (const part of req.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file') {
        if (part.type === 'file') part.file.resume();
        continue;
      }
      if (data) return reply.code(400).send({ error: 'Only one file is allowed', code: 'TOO_MANY_FILES' });
      declaredMime = part.mimetype;
      const chunks: Buffer[] = [];
      let size = 0;
      const maxBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100)) * 1024 * 1024;
      for await (const chunk of part.file) {
        size += chunk.length;
        if (size > maxBytes) throw new HttpError(413, `File exceeds configured ${Math.floor(maxBytes / 1048576)} MB limit`, 'FILE_TOO_LARGE');
        chunks.push(chunk);
      }
      data = Buffer.concat(chunks);
    }
    if (!data?.length) return reply.code(400).send({ error: 'Choose a file to upload', code: 'EMPTY_FILE' });
    const allowed = declaredMime.startsWith('image/') || declaredMime.startsWith('video/') || declaredMime.startsWith('audio/') ||
      declaredMime === 'application/pdf' || declaredMime.startsWith('text/') ||
      declaredMime.includes('officedocument') || declaredMime === 'application/zip' ||
      declaredMime === 'application/octet-stream';
    if (!allowed) return reply.code(415).send({ error: 'This file type is not supported', code: 'UNSUPPORTED_FILE_TYPE' });
    const extension = path.extname((req.headers['x-file-name'] || 'upload.bin').toString()).slice(0, 16).replace(/[^.A-Za-z0-9]/g, '');
    const storageKey = `${randomUUID()}${extension || '.bin'}`;
    await mediaStorage.save(storageKey, data);
    try {
      const attachment = await prisma.messageAttachment.create({ data: {
        uploaderId: me.id, mimeType: declaredMime, sizeBytes: data.length, storageKey,
      }});
      return reply.code(201).send({ id: attachment.id, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, createdAt: attachment.createdAt });
    } catch (error) {
      await mediaStorage.remove(storageKey);
      throw error;
    }
  });

  app.get('/api/v1/attachments/:id/file', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const attachment = await prisma.messageAttachment.findUnique({
      where: { id }, include: { message: { select: { conversationId: true } } },
    });
    if (!attachment?.message) return reply.code(404).send({ error: 'File not found' });
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: attachment.message.conversationId, userId: me.id } },
    });
    if (!member) return reply.code(403).send({ error: 'Not a conversation member' });
    const info = await mediaStorage.stat(attachment.storageKey).catch(() => null);
    if (!info) return reply.code(404).send({ error: 'Stored file is missing' });
    reply.header('Content-Type', attachment.mimeType);
    reply.header('Content-Length', info.size);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(mediaStorage.stream(attachment.storageKey));
  });

  app.get('/api/v1/attachments/:id/audio', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const attachment = await prisma.messageAttachment.findUnique({
      where: { id },
      include: { message: { select: { conversationId: true } } },
    });
    if (!attachment?.message) return reply.code(404).send({ error: 'Audio not found' });
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: attachment.message.conversationId, userId: me.id } },
    });
    if (!member) return reply.code(403).send({ error: 'Not a member' });

    let info;
    try {
      info = await mediaStorage.stat(attachment.storageKey);
    } catch {
      return reply.code(404).send({ error: 'Audio file missing' });
    }
    const filename = safeFilename(attachment.mimeType);
    reply.header('Content-Type', attachment.mimeType);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=300');
    reply.header('Content-Disposition', `inline; filename="${filename}"`);

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.code(206).send(mediaStorage.stream(attachment.storageKey, { start, end }));
    }
    reply.header('Content-Length', info.size);
    return reply.send(mediaStorage.stream(attachment.storageKey));
  });

  app.post('/api/v1/reports', async (req, reply) => {
    const reporter = await authUser(req);
    const input = z
      .object({
        reportedUsername: z.string(),
        category: z.nativeEnum(ReportCategory),
        description: z.string().min(10).max(5000),
      })
      .parse(req.body);
    const target = await prisma.user.findUnique({ where: { username: input.reportedUsername } });
    if (!target || target.id === reporter.id) return reply.code(400).send({ error: 'Invalid report target' });
    const report = await prisma.report.create({
      data: {
        reporterId: reporter.id,
        reportedUserId: target.id,
        reportedUsernameSnapshot: target.username,
        category: input.category,
        description: input.description,
      },
    });
    return reply.code(201).send({
      id: report.id,
      status: report.status,
      reportedUser: { username: target.username, displayName: target.displayName, id: target.id },
    });
  });

  app.post('/api/v1/reports/:id/evidence', async (req, reply) => {
    const me = await authUser(req);
    const { id } = req.params as { id: string };
    const report = await prisma.report.findFirst({ where: { id, reporterId: me.id } });
    if (!report) return reply.code(404).send({ error: 'Report not found' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Evidence file required' });
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!allowed.includes(part.mimetype)) {
      return reply.code(415).send({ error: 'Only PNG, JPG, WebP or PDF evidence is accepted' });
    }
    const key = `${randomUUID()}${path.extname(part.filename).toLowerCase().slice(0, 8)}`;
    await pipeline(part.file, createWriteStream(path.join(uploadDir, key)));
    const stat = await import('node:fs/promises').then((fs) => fs.stat(path.join(uploadDir, key)));
    const evidence = await prisma.reportEvidence.create({
      data: { reportId: id, storageKey: key, mimeType: part.mimetype, sizeBytes: stat.size },
    });
    return reply.code(201).send({ id: evidence.id, uploaded: true });
  });

  app.post('/api/v1/admin/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const passwordValid = safeEqual(input.password, ADMIN_PASSWORD);
    if (!passwordValid || input.username !== ADMIN_USERNAME) {
      return reply.code(401).send({ error: 'Invalid admin credentials' });
    }
    return { accessToken: app.jwt.sign({ admin: input.username }, { expiresIn: '30m' }) };
  });

  app.get('/api/v1/admin/overview', async (req) => {
    await adminUser(req);
    const [users, activeUsers, suspendedUsers, conversations, messages, calls, pendingReports, reports] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { accountStatus: AccountStatus.ACTIVE } }),
      prisma.user.count({ where: { accountStatus: AccountStatus.SUSPENDED } }),
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.call.count(),
      prisma.report.count({ where: { status: ReportStatus.PENDING } }),
      prisma.report.count(),
    ]);
    return { users, activeUsers, suspendedUsers, conversations, messages, calls, pendingReports, reports };
  });

  app.get('/api/v1/admin/users', async (req) => {
    await adminUser(req);
    const query = z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['ALL', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED']).default('ALL'),
      take: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const users = await prisma.user.findMany({
      where: {
        ...(query.status === 'ALL' ? {} : { accountStatus: query.status as AccountStatus }),
        ...(query.q ? { OR: [
          { username: { contains: query.q, mode: 'insensitive' } },
          { displayName: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ] } : {}),
      },
      select: { id: true, username: true, displayName: true, email: true, accountStatus: true, createdAt: true, lastSeenAt: true },
      orderBy: { createdAt: 'desc' },
      take: query.take,
    });
    return users;
  });

  app.patch('/api/v1/admin/users/:id', async (req, reply) => {
    const who = await adminUser(req);
    const { id } = req.params as { id: string };
    const input = z.object({
      action: z.enum(['WARN', 'SUSPEND', 'BAN', 'SOFT_DELETE', 'RESTORE']),
      reason: z.string().min(5).max(2000),
      durationHours: z.number().int().positive().max(8760).optional(),
    }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.username === ADMIN_USERNAME) return reply.code(403).send({ error: 'Admin account cannot be moderated through this endpoint' });
    const nextStatus: AccountStatus = input.action === 'RESTORE' ? AccountStatus.ACTIVE
      : ['SUSPEND', 'BAN', 'SOFT_DELETE'].includes(input.action) ? (input.action === 'SOFT_DELETE' ? AccountStatus.DELETED : input.action === 'BAN' ? AccountStatus.BANNED : AccountStatus.SUSPENDED)
      : target.accountStatus;
    await prisma.$transaction(async (tx) => {
      await tx.moderationAction.create({
        data: {
          adminUsername: who,
          targetUserId: id,
          type: input.action as ModerationActionType,
          reason: input.reason,
          expiresAt: input.durationHours ? new Date(Date.now() + input.durationHours * 3600000) : null,
        },
      });
      await tx.user.update({ where: { id }, data: { accountStatus: nextStatus } });
      if (nextStatus !== AccountStatus.ACTIVE) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    });
    const notificationTitle = input.action === 'WARN' ? 'Account warning' : input.action === 'SUSPEND' ? 'Account suspended' : input.action === 'BAN' ? 'Account banned' : input.action === 'SOFT_DELETE' ? 'Account deactivated' : 'Account restored';
    if (input.action !== 'RESTORE') {
      await createNotification(id, NotificationType.SYSTEM, notificationTitle, input.reason);
      if (target.email && ['WARN', 'SUSPEND', 'BAN', 'SOFT_DELETE'].includes(input.action)) {
        try { await sendModerationEmail({ to: target.email, recipientName: target.displayName, action: input.action as 'WARN' | 'SUSPEND' | 'BAN' | 'SOFT_DELETE', reason: input.reason }); }
        catch (error) { app.log.error({ error, userId: id }, 'Could not send moderation email through Brevo'); }
      }
    } else {
      await createNotification(id, NotificationType.SYSTEM, 'Account restored', input.reason);
    }
    return { success: true, accountStatus: nextStatus };
  });

  app.get('/api/v1/admin/actions', async (req) => {
    await adminUser(req);
    const actions = await prisma.moderationAction.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const ids = [...new Set(actions.map((action) => action.targetUserId))];
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, displayName: true } });
    const byId = new Map(users.map((user) => [user.id, user]));
    return actions.map((action) => ({ ...action, targetUser: byId.get(action.targetUserId) || null }));
  });

  app.get('/api/v1/admin/reports', async (req) => {
    await adminUser(req);
    return prisma.report.findMany({
      include: {
        reporter: { select: { id: true, username: true, displayName: true, email: true } },
        reportedUser: { select: { id: true, username: true, displayName: true, email: true, accountStatus: true } },
        evidence: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.get('/api/v1/admin/reports/:id/evidence/:evidenceId', async (req, reply) => {
    await adminUser(req);
    const { id, evidenceId } = req.params as { id: string; evidenceId: string };
    const evidence = await prisma.reportEvidence.findFirst({ where: { id: evidenceId, reportId: id } });
    if (!evidence) throw new HttpError(404, 'Evidence file not found');
    const filePath = path.join(uploadDir, evidence.storageKey);
    let contents: Buffer;
    try { contents = await readFile(filePath); }
    catch { throw new HttpError(404, 'Evidence file is no longer available'); }
    reply.header('Content-Type', evidence.mimeType);
    reply.header('Content-Length', contents.length);
    reply.header('Content-Disposition', `inline; filename=\"report-evidence-${evidence.id}${path.extname(evidence.storageKey)}\"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(contents);
  });

  app.patch('/api/v1/admin/reports/:id', async (req) => {
    const who = await adminUser(req);
    const { id } = req.params as { id: string };
    const input = z
      .object({
        status: z.nativeEnum(ReportStatus),
        action: z.enum(['NONE', 'WARN', 'SUSPEND', 'BAN', 'SOFT_DELETE']).default('NONE'),
        reason: z.string().min(5).max(2000),
        durationHours: z.number().int().positive().max(8760).optional(),
      })
      .parse(req.body);
    const report = await prisma.report.findUnique({ where: { id } });
    if (!report) throw new HttpError(404, 'Report not found');
    await prisma.$transaction(async (tx) => {
      await tx.report.update({ where: { id }, data: { status: input.status, reviewedBy: who, reviewedAt: new Date() } });
      if (input.action !== 'NONE') {
        const type = input.action as ModerationActionType;
        await tx.moderationAction.create({
          data: {
            reportId: id,
            adminUsername: who,
            targetUserId: report.reportedUserId,
            type,
            reason: input.reason,
            expiresAt: input.durationHours ? new Date(Date.now() + input.durationHours * 3600000) : null,
          },
        });
        if (input.action === 'SUSPEND' || input.action === 'BAN' || input.action === 'SOFT_DELETE') {
          await tx.user.update({
            where: { id: report.reportedUserId },
            data: { accountStatus: input.action === 'SOFT_DELETE' ? 'DELETED' : input.action === 'BAN' ? 'BANNED' : 'SUSPENDED' },
          });
          await tx.session.updateMany({ where: { userId: report.reportedUserId }, data: { revokedAt: new Date() } });
        }
      }
    });
    if (input.action !== 'NONE') {
      const title = input.action === 'WARN' ? 'Account warning' : input.action === 'SUSPEND' ? 'Account suspended' : input.action === 'BAN' ? 'Account banned' : 'Account deactivated';
      await createNotification(report.reportedUserId, NotificationType.SYSTEM, title, input.reason);
      const target = await prisma.user.findUnique({ where: { id: report.reportedUserId }, select: { email: true, displayName: true } });
      if (target?.email && ['WARN', 'SUSPEND', 'BAN', 'SOFT_DELETE'].includes(input.action)) {
        try { await sendModerationEmail({ to: target.email, recipientName: target.displayName, action: input.action as 'WARN' | 'SUSPEND' | 'BAN' | 'SOFT_DELETE', reason: input.reason }); }
        catch (error) { app.log.error({ error, userId: report.reportedUserId }, 'Could not send moderation email through Brevo'); }
      }
    }
    return { success: true };
  });

  function publicUser(user: Record<string, any>) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      about: user.about,
      gender: user.gender,
      profilePictureKey: user.profilePictureKey,
      createdAt: user.createdAt,
    };
  }

  async function friendIdsFor(userId: string) {
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    });
    return friendships.map((friendship) => (friendship.userAId === userId ? friendship.userBId : friendship.userAId));
  }

  async function broadcastPresence(userId: string, online: boolean, lastSeenAt: Date | null = null) {
    const friendIds = await friendIdsFor(userId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { showLastSeen: true } });
    const visible = user?.showLastSeen !== false;
    const payload = {
      userId,
      online: visible ? online : false,
      lastSeenAt: visible && !online ? lastSeenAt : null,
      hidden: !visible,
    };
    for (const friendId of friendIds) emitToUser(friendId, 'presence:update', payload);
    emitToUser(userId, 'presence:update', { ...payload, online, lastSeenAt: !online ? lastSeenAt : null });
  }

  async function persistOfflinePresence(userId: string, lastSeenAt: Date) {
    const user = await prisma.user
      .update({ where: { id: userId }, data: { lastSeenAt }, select: { showLastSeen: true } })
      .catch(() => null);
    if (!user) return;
    await broadcastPresence(userId, false, user.showLastSeen ? lastSeenAt : null);
  }

  async function receiptTargets(userId: string, messageIds: string[]) {
    const uniqueIds = [...new Set(messageIds.filter((id) => typeof id === 'string'))].slice(0, 200);
    if (!uniqueIds.length) return [];
    const messages = await prisma.message.findMany({
      where: { id: { in: uniqueIds }, senderId: { not: userId } },
      select: { id: true, conversationId: true },
    });
    const conversationIds = [...new Set(messages.map((message) => message.conversationId))];
    const memberships = await prisma.conversationMember.findMany({
      where: { userId, conversationId: { in: conversationIds } },
      select: { conversationId: true },
    });
    const allowed = new Set(memberships.map((membership) => membership.conversationId));
    return messages.filter((message) => allowed.has(message.conversationId));
  }

  async function markDelivered(userId: string, messageIds: string[]) {
    const targets = await receiptTargets(userId, messageIds);
    if (!targets.length) return { changed: [], conversationIds: [] };
    const existing = await prisma.messageReceipt.findMany({
      where: { userId, messageId: { in: targets.map((target) => target.id) } },
      select: { messageId: true },
    });
    const existingIds = new Set(existing.map((receipt) => receipt.messageId));
    const newIds = targets.filter((target) => !existingIds.has(target.id)).map((target) => target.id);
    const now = new Date();
    if (newIds.length) {
      await prisma.messageReceipt.createMany({
        data: newIds.map((messageId) => ({ messageId, userId, deliveredAt: now })),
        skipDuplicates: true,
      });
    }
    const changed = targets.filter((target) => newIds.includes(target.id));
    return { changed, conversationIds: [...new Set(changed.map((target) => target.conversationId))] };
  }

  async function markRead(userId: string, messageIds: string[], conversationId?: string) {
    let ids = messageIds;
    if (!ids.length && conversationId) {
      const member = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!member) return { changed: [], conversationIds: [] };
      const recent = await prisma.message.findMany({
        where: { conversationId, senderId: { not: userId } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true },
      });
      ids = recent.map((message) => message.id);
    }
    const targets = await receiptTargets(userId, ids);
    if (!targets.length) return { changed: [], conversationIds: [] };
    const existing = await prisma.messageReceipt.findMany({
      where: { userId, messageId: { in: targets.map((target) => target.id) } },
      select: { messageId: true, readAt: true },
    });
    const existingMap = new Map(existing.map((receipt) => [receipt.messageId, receipt]));
    const missing = targets.filter((target) => !existingMap.has(target.id)).map((target) => target.id);
    const unread = targets.filter((target) => existingMap.has(target.id) && !existingMap.get(target.id)?.readAt).map((target) => target.id);
    const changed = [...missing, ...unread];
    const now = new Date();
    if (changed.length) {
      await prisma.$transaction([
        prisma.messageReceipt.createMany({
          data: missing.map((messageId) => ({ messageId, userId, deliveredAt: now, readAt: now })),
          skipDuplicates: true,
        }),
        prisma.messageReceipt.updateMany({
          where: { userId, messageId: { in: unread }, readAt: null },
          data: { readAt: now },
        }),
      ]);
      const changedTargets = targets.filter((target) => changed.includes(target.id));
      const changedConversations = [...new Set(changedTargets.map((target) => target.conversationId))];
      await prisma.conversationMember.updateMany({
        where: { userId, conversationId: { in: changedConversations } },
        data: { lastReadAt: now },
      });
      return { changed: changedTargets, conversationIds: changedConversations };
    }
    return { changed: [], conversationIds: [] };
  }

  if (options.withSocket !== false) presence.start();

  if (options.withSocket !== false) {
    io = new SocketServer(app.server, {
      cors: { origin: WEB_ORIGIN.split(',').map((item) => item.trim()), credentials: true },
    });
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error('Unauthorized'));
        const payload = app.jwt.verify(token) as any;
        if (!payload.sub) return next(new Error('Unauthorized'));
        const user = await prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return next(new Error('Unauthorized'));
        if (payload.sid) {
          const session = await prisma.session.findUnique({ where: { id: payload.sid } });
          if (!session || session.revokedAt) return next(new Error('Unauthorized'));
        }
        (socket as any).userId = payload.sub;
        (socket as any).sessionId = payload.sid;
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
    io.on('connection', async (socket) => {
      const userId = (socket as any).userId as string;
      const sessionId = (socket as any).sessionId as string | undefined;
      socket.join(`user:${userId}`);
      presence.addConnection(userId, socket.id, sessionId || '');

      const heartbeat = () => presence.heartbeat(userId, socket.id);
      socket.on('presence:heartbeat', heartbeat);
      const heartbeatInterval = setInterval(heartbeat, 25000);
      heartbeatInterval.unref?.();

      socket.on('conversation:join', async (conversationId: string) => {
        const member = await prisma.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId, userId } },
        });
        if (member) socket.join(`conversation:${conversationId}`);
      });

      socket.on(
        'message:send',
        async (payload: {
          conversationId: string;
          body?: string;
          type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
          clientMessageId?: string;
          attachmentId?: string;
        }) => {
          try {
            const member = await prisma.conversationMember.findUnique({
              where: { conversationId_userId: { conversationId: payload.conversationId, userId } },
            });
            if (!member) return;
            const participants = await prisma.conversationMember.findMany({ where: { conversationId: payload.conversationId, userId: { not: userId } }, select: { userId: true } });
            for (const participant of participants) { if (await isBlocked(userId, participant.userId)) { socket.emit('message:error', { clientMessageId: payload.clientMessageId, message: 'Messaging is unavailable because a participant has blocked this account.' }); return; } }
            const body = payload.body?.trim().slice(0, 10000);
            const attachment = payload.attachmentId
              ? await prisma.messageAttachment.findUnique({ where: { id: payload.attachmentId } })
              : null;
            if (payload.attachmentId && (!attachment || attachment.uploaderId !== userId || attachment.messageId)) {
              socket.emit('message:error', { clientMessageId: payload.clientMessageId, message: 'Attachment is unavailable' });
              return;
            }
            if (!body && !attachment) return;

            const message = await prisma.$transaction(async (tx) => {
              const created = await tx.message.create({
                data: {
                  conversationId: payload.conversationId,
                  senderId: userId,
                  body: body || null,
                  type: attachment ? (attachment.mimeType.startsWith('audio/') ? 'AUDIO' : attachment.mimeType.startsWith('image/') ? 'IMAGE' : attachment.mimeType.startsWith('video/') ? 'VIDEO' : 'FILE') : payload.type || 'TEXT',
                  clientMessageId: payload.clientMessageId,
                },
              });
              if (attachment) {
                const linked = await tx.messageAttachment.updateMany({
                  where: { id: attachment.id, uploaderId: userId, messageId: null },
                  data: { messageId: created.id },
                });
                if (linked.count !== 1) throw new Error('Attachment already used');
              }
              return tx.message.findUniqueOrThrow({
                where: { id: created.id },
                include: {
                  sender: { select: { id: true, username: true, displayName: true, profilePictureKey: true } },
                  receipts: true,
                  attachment: true,
                },
              });
            });
            await prisma.conversation.update({ where: { id: payload.conversationId }, data: { updatedAt: new Date() } });
            await prisma.outboxEvent.create({
              data: {
                eventType: 'MESSAGE_CREATED',
                aggregateId: message.id,
                payload: { conversationId: message.conversationId, senderId: userId },
              },
            });
            io?.to(`conversation:${payload.conversationId}`).emit('message:new', message);
            socket.emit('message:ack', {
              clientMessageId: payload.clientMessageId,
              messageId: message.id,
              createdAt: message.createdAt,
            });

            const others = await prisma.conversationMember.findMany({
              where: { conversationId: payload.conversationId, userId: { not: userId } },
              select: { userId: true },
            });
            const sender = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
            const preview = message.type === 'AUDIO' ? '[Voice message]' : body || `[${message.type}]`;
            for (const other of others) {
              await createNotification(
                other.userId,
                NotificationType.NEW_MESSAGE,
                `New message from ${sender?.displayName || sender?.username || 'a user'}`,
                preview,
                { conversationId: payload.conversationId, messageId: message.id, senderId: userId },
              );
              emitToUser(other.userId, 'conversation:updated', { conversationId: payload.conversationId });
            }
          } catch {
            socket.emit('message:error', { clientMessageId: payload.clientMessageId, message: 'Message could not be sent' });
          }
        },
      );

      socket.on('message:delivered', async (payload: { messageIds?: string[]; conversationId?: string } | string) => {
        const messageIds = typeof payload === 'string' ? [payload] : payload?.messageIds || [];
        const result = await markDelivered(userId, messageIds);
        const deliveredAt = new Date().toISOString();
        for (const conversationId of result.conversationIds) {
          const ids = result.changed.filter((item) => item.conversationId === conversationId).map((item) => item.id);
          if (ids.length) io?.to(`conversation:${conversationId}`).emit('receipt:delivered', { messageIds: ids, userId, deliveredAt });
        }
      });

      socket.on('typing', (payload: string | { conversationId: string; typing?: boolean }) => {
        const conversationId = typeof payload === 'string' ? payload : payload.conversationId;
        if (!conversationId) return;
        socket.to(`conversation:${conversationId}`).emit('typing', {
          userId,
          conversationId,
          typing: typeof payload === 'string' ? true : payload.typing !== false,
        });
      });

      socket.on('call:offer', (payload: { toUserId: string; offer: unknown; callId: string }) =>
        io?.to(`user:${payload.toUserId}`).emit('call:incoming', { fromUserId: userId, offer: payload.offer, callId: payload.callId }),
      );
      socket.on('call:answer', (payload: { toUserId: string; answer: unknown; callId: string }) =>
        io?.to(`user:${payload.toUserId}`).emit('call:answer', { fromUserId: userId, answer: payload.answer, callId: payload.callId }),
      );
      socket.on('call:ice', (payload: { toUserId: string; candidate: unknown; callId: string }) =>
        io?.to(`user:${payload.toUserId}`).emit('call:ice', { fromUserId: userId, candidate: payload.candidate, callId: payload.callId }),
      );
      socket.on('call:end', (payload: { toUserId: string; callId: string }) =>
        io?.to(`user:${payload.toUserId}`).emit('call:end', { fromUserId: userId, callId: payload.callId }),
      );

      socket.on('message:read', async (payload: { messageIds?: string[]; conversationId?: string } | string) => {
        const messageIds = typeof payload === 'string' ? [payload] : payload?.messageIds || [];
        const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
        const result = await markRead(userId, messageIds, conversationId);
        const readAt = new Date().toISOString();
        for (const roomConversationId of result.conversationIds) {
          const ids = result.changed.filter((item) => item.conversationId === roomConversationId).map((item) => item.id);
          if (ids.length) {
            io?.to(`conversation:${roomConversationId}`).emit('receipt:read', {
              messageIds: ids,
              messageId: ids.length === 1 ? ids[0] : undefined,
              userId,
              readAt,
            });
          }
        }
      });

      socket.on('disconnect', async () => {
        clearInterval(heartbeatInterval);
        presence.removeConnection(userId, socket.id);
        if (sessionId) {
          const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { deviceId: true } }).catch(() => null);
          if (session) {
            await prisma.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
          }
        }
      });
    });
    app.addHook('onClose', async () => {
      const onlineIds = presence.onlineUserIds();
      presence.stop();
      if (onlineIds.length) {
        await prisma.user.updateMany({ where: { id: { in: onlineIds } }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      }
      io?.close();
    });
  }

  return app;
}
