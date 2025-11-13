import type { DataCache } from '../types';

const STORAGE_KEY = 'spotify_stats_data';
const FILE_STORAGE_KEY = 'spotify_stats_file';
const DB_NAME = 'spotify_stats_db';
const DB_VERSION = 1;
const STORE_NAME = 'files';

// Funzioni per IndexedDB
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export function saveDataToStorage(dataCache: DataCache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataCache));
  } catch (error) {
    console.error('Errore nel salvataggio dei dati:', error);
  }
}

export function loadDataFromStorage(): DataCache | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved) as DataCache;
    }
  } catch (error) {
    console.error('Errore nel caricamento dei dati:', error);
  }
  return null;
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(FILE_STORAGE_KEY);
    localStorage.removeItem(`${FILE_STORAGE_KEY}_name`);
    
    // Pulisci anche IndexedDB
    openDB().then((db) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();
      db.close();
    }).catch((err) => {
      console.error('Errore nella pulizia di IndexedDB:', err);
    });
  } catch (error) {
    console.error('Errore nella pulizia dello storage:', error);
  }
}

export async function saveFileToStorage(file: File): Promise<void> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const fileSize = arrayBuffer.byteLength;
    
    // Se il file è più piccolo di 5MB, prova localStorage, altrimenti IndexedDB
    if (fileSize < 5 * 1024 * 1024) {
      try {
        // Conversione base64 più efficiente per file grandi
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192; // Processa in chunk per evitare stack overflow
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const base64 = btoa(binary);
        localStorage.setItem(FILE_STORAGE_KEY, base64);
        localStorage.setItem(`${FILE_STORAGE_KEY}_name`, file.name);
        localStorage.setItem(`${FILE_STORAGE_KEY}_storage`, 'localstorage');
        return;
      } catch (e) {
        // Se localStorage fallisce, usa IndexedDB
        console.log('localStorage pieno o errore, uso IndexedDB');
      }
    }
    
    // Usa IndexedDB per file grandi o se localStorage fallisce
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    await new Promise<void>((resolve, reject) => {
      const request = store.put({ file: arrayBuffer, name: file.name }, FILE_STORAGE_KEY);
      request.onsuccess = () => {
        localStorage.setItem(`${FILE_STORAGE_KEY}_storage`, 'indexeddb');
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    
    db.close();
  } catch (error) {
    console.error('Errore nel salvataggio del file:', error);
  }
}

export async function loadFileFromStorage(): Promise<File | null> {
  try {
    const storageType = localStorage.getItem(`${FILE_STORAGE_KEY}_storage`);
    
    if (storageType === 'indexeddb') {
      // Carica da IndexedDB
      const db = await openDB();
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      
      return new Promise<File | null>((resolve, reject) => {
        const request = store.get(FILE_STORAGE_KEY);
        request.onsuccess = () => {
          const result = request.result;
          if (result) {
            const file = new File([result.file], result.name, { type: 'application/zip' });
            db.close();
            resolve(file);
          } else {
            db.close();
            resolve(null);
          }
        };
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      });
    } else {
      // Carica da localStorage
      const base64 = localStorage.getItem(FILE_STORAGE_KEY);
      const fileName = localStorage.getItem(`${FILE_STORAGE_KEY}_name`);
      
      if (base64 && fileName) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new File([bytes], fileName, { type: 'application/zip' });
      }
    }
  } catch (error) {
    console.error('Errore nel caricamento del file:', error);
  }
  return null;
}

