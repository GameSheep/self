/**
 * Self-Hub Zero-Knowledge Web Crypto Engine
 * Uses Browser Native WebCrypto (PBKDF2 + AES-256-GCM)
 * Zero external dependencies, 100% client-side security
 */
import { rememberMasterPassword, recallMasterPassword, forgetMasterPassword } from './trustedDevice';
import { normalizeHubState } from './storage';

// Helper to convert ArrayBuffer to Base64
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Helper to convert Base64 to Uint8Array
export function base64ToBuffer(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Derive AES-256-GCM key from master password using PBKDF2 (100,000 rounds)
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passwordKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt plaintext with master password
export async function encryptText(plaintext: string, password: string): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const enc = new TextEncoder();
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as any },
    key,
    enc.encode(plaintext)
  );

  return {
    ciphertext: bufferToBase64(encrypted),
    iv: bufferToBase64(iv),
    salt: bufferToBase64(salt)
  };
}

// Decrypt ciphertext with master password
export async function decryptText(ciphertext: string, iv: string, salt: string, password: string): Promise<string> {
  const saltBuffer = base64ToBuffer(salt);
  const ivBuffer = base64ToBuffer(iv);
  const cipherBuffer = base64ToBuffer(ciphertext);

  const key = await deriveKey(password, saltBuffer);

  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer as any },
    key,
    cipherBuffer as any
  );

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

// Generate zero-knowledge password verification hash
export async function createPasswordHash(password: string): Promise<{ hash: string; salt: string }> {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBits = await window.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 150000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return {
    hash: bufferToBase64(hashBits),
    salt: bufferToBase64(salt)
  };
}

// Verify password against stored hash
export async function verifyPasswordHash(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
  try {
    const saltBuffer = base64ToBuffer(storedSalt);
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const hashBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBuffer as any,
        iterations: 150000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    return bufferToBase64(hashBits) === storedHash;
  } catch {
    return false;
  }
}

// Anti-peek masking helper (e.g. sk-proj-1234567890abcdef -> sk-proj-••••••••cdef)
export function createMaskedPreview(secret: string): string {
  if (!secret) return '';
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  const prefixLen = Math.min(6, Math.floor(trimmed.length * 0.25));
  const suffixLen = Math.min(4, Math.floor(trimmed.length * 0.25));
  const prefix = trimmed.slice(0, prefixLen);
  const suffix = trimmed.slice(-suffixLen);
  return `${prefix}••••••••${suffix}`;
}

// Trusted Device Token Management (Local-First IndexedDB session storage)
const TRUSTED_DEVICE_KEY = 'self_hub_trusted_device';

export interface TrustedDeviceSession {
  trusted: boolean;
  expiresAt: number;
  encryptedKeyMaterial?: string;
  iv?: string;
  salt?: string;
}

// In-memory active session reference
let memorySessionPassword: string | null = null;

/**
 * Keep the vault unlocked on this device.
 * The password is wrapped with a random per-device key in IndexedDB
 * (see lib/trustedDevice.ts) and expires after `days` days.
 */
export async function saveTrustedSession(password: string, days = 30): Promise<void> {
  memorySessionPassword = password;
  try {
    sessionStorage.setItem('self_hub_session_active', '1');
    // Security clean up: immediately wipe any insecure legacy localStorage key
    localStorage.removeItem(TRUSTED_DEVICE_KEY);
  } catch (err) {
    console.warn('Failed to save session', err);
  }
  await rememberMasterPassword(password, days);
}

/** Synchronous in-memory lookup (used during a live session). */
export function getTrustedSession(): { password?: string; isValid: boolean } {
  try {
    localStorage.removeItem(TRUSTED_DEVICE_KEY);
  } catch {}

  if (memorySessionPassword) {
    return { password: memorySessionPassword, isValid: true };
  }
  return { isValid: false };
}

/**
 * Boot-time lookup: restores a remembered session surviving a page reload
 * or browser restart, until it expires.
 */
export async function restoreTrustedSession(): Promise<{ password?: string; isValid: boolean }> {
  if (memorySessionPassword) return { password: memorySessionPassword, isValid: true };
  try {
    const password = await recallMasterPassword();
    if (password) {
      memorySessionPassword = password;
      sessionStorage.setItem('self_hub_session_active', '1');
      return { password, isValid: true };
    }
  } catch {}
  return { isValid: false };
}

export async function clearTrustedSession(): Promise<void> {
  memorySessionPassword = null;
  try {
    sessionStorage.removeItem('self_hub_session_active');
    localStorage.removeItem(TRUSTED_DEVICE_KEY);
    // Dispatch global event so all components immediately wipe plaintext displays
    window.dispatchEvent(new CustomEvent('selfhub:vault-locked'));
  } catch {
    // ignore
  }
  await forgetMasterPassword();
}

/**
 * Encrypt full hub backup with master password (N02, N03)
 */
export async function exportEncryptedBackup(stateObj: any, password: string): Promise<string> {
  const jsonString = JSON.stringify(stateObj);
  const encrypted = await encryptText(jsonString, password);
  
  const payload = {
    schemaVersion: 2,
    app: 'self-hub',
    encryptedData: encrypted.ciphertext,
    iv: encrypted.iv,
    salt: encrypted.salt,
    createdAt: Date.now(),
    summary: {
      sitesCount: stateObj.sites?.length || 0,
      notesCount: stateObj.notes?.length || 0,
      secretsCount: stateObj.secrets?.length || 0,
      serversCount: stateObj.servers?.length || 0,
      projectsCount: stateObj.projects?.length || 0,
      remindersCount: stateObj.reminders?.length || 0,
      inboxCount: stateObj.inbox?.length || 0
    }
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Decrypt and parse full hub backup with master password (N02, N03)
 */
export async function importEncryptedBackup(payloadJson: string, password: string): Promise<any> {
  let parsedPayload: any;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch {
    throw new Error('备份文件格式损坏，无法解析 JSON');
  }

  // Handle encrypted backup format (version 2)
  if (parsedPayload.app === 'self-hub' && parsedPayload.encryptedData && parsedPayload.iv && parsedPayload.salt) {
    try {
      const decryptedJson = await decryptText(
        parsedPayload.encryptedData,
        parsedPayload.iv,
        parsedPayload.salt,
        password
      );
      // Normalised so a backup missing optional collections cannot blank the app.
      return normalizeHubState(JSON.parse(decryptedJson));
    } catch {
      throw new Error('解密失败：主密码错误或备份已被篡改');
    }
  }

  // Handle legacy plaintext backup format with warning
  if (parsedPayload.sites && parsedPayload.servers && parsedPayload.secrets) {
    return parsedPayload;
  }
  throw new Error('无效的 Self-Hub 备份文件格式');
}

/**
 * Native Browser WebCrypto HMAC-SHA1
 * Used for Aliyun OSS / AWS S3 REST API Signature
 */
export async function hmacSha1(keyStr: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await window.crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bufferToBase64(signature);
}

