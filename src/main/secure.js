// Cifratura dei segreti locali con safeStorage (DPAPI su Windows, Keychain su macOS).
import { safeStorage } from 'electron';

export const crypt = {
  encrypt(plain) {
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  },
  decrypt(stored) {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    throw new Error('formato del segreto sconosciuto');
  },
};
