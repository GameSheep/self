/**
 * Trusted-device session store.
 *
 * The "keep me signed in on this device for 30 days" promise used to be backed only
 * by a module-level variable plus a sessionStorage flag that was never read, so the
 * vault locked again on every reload. This stores the master password wrapped with a
 * random per-device key in IndexedDB and expires the record after N days.
 *
 * Security note: the wrapping key lives next to the ciphertext in the same origin's
 * IndexedDB, so this protects against casual inspection of localStorage dumps and
 * accidental backups — it is not protection against script execution on this origin.
 * The master password itself is never stored in clear text.
 */
import { getDb } from './indexedDb';

const RECORD_KEY = 'trusted_device_v1';
const DEFAULT_DAYS = 30;

interface TrustedDeviceRecord {
  key: string;
  value: {
    secretB64: string;
    ivB64: string;
    ciphertextB64: string;
    createdAt: number;
    expiresAt: number;
  };
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function putRecord(record: TrustedDeviceRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    getDb()
      .then((db) => {
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
      .catch(reject);
  });
}

function getRecord(): Promise<TrustedDeviceRecord | null> {
  return new Promise((resolve) => {
    getDb()
      .then((db) => {
        const tx = db.transaction('metadata', 'readonly');
        const req = tx.objectStore('metadata').get(RECORD_KEY);
        req.onsuccess = () => resolve((req.result as TrustedDeviceRecord) || null);
        req.onerror = () => resolve(null);
      })
      .catch(() => resolve(null));
  });
}

function deleteRecord(): Promise<void> {
  return new Promise((resolve) => {
    getDb()
      .then((db) => {
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      })
      .catch(() => resolve());
  });
}

async function deriveDeviceKey(secretB64: string): Promise<CryptoKey> {
  return window.crypto.subtle.importKey(
    'raw',
    fromB64(secretB64) as unknown as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Wrap and persist the master password for `days` days. */
export async function rememberMasterPassword(password: string, days: number = DEFAULT_DAYS): Promise<void> {
  try {
    const secret = window.crypto.getRandomValues(new Uint8Array(32));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveDeviceKey(toB64(secret));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      key,
      new TextEncoder().encode(password)
    );
    const now = Date.now();
    await putRecord({
      key: RECORD_KEY,
      value: {
        secretB64: toB64(secret),
        ivB64: toB64(iv),
        ciphertextB64: toB64(ciphertext),
        createdAt: now,
        expiresAt: now + days * 24 * 60 * 60 * 1000
      }
    });
  } catch (err) {
    console.warn('Failed to remember device session', err);
  }
}

/** Read back the remembered master password, honouring the expiry. */
export async function recallMasterPassword(): Promise<string | null> {
  const record = await getRecord();
  if (!record?.value) return null;
  const { secretB64, ivB64, ciphertextB64, expiresAt } = record.value;
  if (!secretB64 || !ivB64 || !ciphertextB64) return null;
  if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
    await deleteRecord();
    return null;
  }
  try {
    const key = await deriveDeviceKey(secretB64);
    const plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) as unknown as ArrayBuffer },
      key,
      fromB64(ciphertextB64) as unknown as ArrayBuffer
    );
    return new TextDecoder().decode(plain);
  } catch {
    await deleteRecord();
    return null;
  }
}

export async function forgetMasterPassword(): Promise<void> {
  await deleteRecord();
}
