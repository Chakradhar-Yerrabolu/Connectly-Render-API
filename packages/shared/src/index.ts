export type Platform = 'WEB'|'ANDROID'|'IOS'|'WINDOWS'|'MACOS'|'LINUX';
export type Gender = 'MALE'|'FEMALE'|'NON_BINARY'|'PREFER_NOT_TO_SAY';
export type MessageType = 'TEXT'|'IMAGE'|'VIDEO'|'AUDIO'|'FILE'|'SYSTEM';
export type ReportCategory = 'HARASSMENT'|'THREATS'|'SPAM_SCAM'|'IMPERSONATION'|'INAPPROPRIATE_CONTENT'|'HATE_SPEECH'|'OTHER';
export interface AuthUser { id:string; username:string; displayName:string; gender:Gender; profilePictureKey?:string|null }
export interface SocketMessage { conversationId:string; body?:string; type?:MessageType; clientMessageId?:string }
